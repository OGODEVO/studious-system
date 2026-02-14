import OpenAI from "openai";
import type {
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { config } from "./utils/config.js";
import { TOOLS_SCHEMA, AVAILABLE_TOOLS } from "./tools/registry.js";
import {
    loadBootstrapContext,
    flushBeforeCompaction,
    logTurnSummary,
    extractEpisodicFromTurn,
} from "./memory/manager.js";

const BASE_SYSTEM_PROMPT = `You are Oasis, a capable browser-automation agent.
You can browse the web, interact with pages, extract information, and search Google.

Guidelines:
- Use tools to gather real data before answering. Do NOT guess or hallucinate content.
- When navigating, always use full URLs (https://).
- Use extract_text after navigating to read page content.
- Use search_google when you need to find something and don't have a direct URL.
- Be concise in your final answers. Summarize what you found clearly.
- If a tool call fails, try an alternative approach before giving up.
- Reference any user preferences or known facts from your memory when relevant.`;

const client = new OpenAI({ apiKey: config.openaiKey });

export type Message = ChatCompletionMessageParam;



// ---------------------------------------------------------------------------
// Build system prompt with memory context
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
    const bootstrapContext = loadBootstrapContext();
    if (bootstrapContext.trim()) {
        return `${BASE_SYSTEM_PROMPT}\n\n${bootstrapContext}`;
    }
    return BASE_SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeToolCalls(
    toolCalls: ChatCompletionMessageToolCall[]
): Promise<Message[]> {
    const results: Message[] = [];

    for (const tc of toolCalls) {
        const fn = AVAILABLE_TOOLS[tc.function.name];
        let output: string;

        if (fn) {
            try {
                const args = JSON.parse(tc.function.arguments);
                output = await fn(args);
            } catch (err) {
                output = `Error executing ${tc.function.name}: ${(err as Error).message}`;
            }
        } else {
            output = `Unknown tool: ${tc.function.name}`;
        }

        console.log(`   🔧 ${tc.function.name} → ${output.slice(0, 80)}...`);

        results.push({
            role: "tool",
            tool_call_id: tc.id,
            content: output,
        });
    }

    return results;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function runAgent(
    userMessage: string,
    history: Message[]
): Promise<{ reply: string; history: Message[] }> {
    // Pre-compaction flush when history gets long
    if (history.length >= config.compactionThreshold) {
        console.log("   💾 History reaching limit, flushing memory before compaction...");
        await flushBeforeCompaction(history);
        // Keep only the most recent messages after flush
        history = history.slice(-10);
    }

    const systemPrompt = buildSystemPrompt();

    const messages: Message[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userMessage },
    ];

    // Tool-call loop — keep going until the model returns a text response
    while (true) {
        const completion = await client.chat.completions.create({
            model: config.model,
            messages,
            tools: TOOLS_SCHEMA,
            tool_choice: "auto",
            temperature: config.temperature,
            max_completion_tokens: config.maxTokens,
        });

        const choice = completion.choices[0];
        const msg = choice.message;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
            // Append assistant message with tool calls
            messages.push({
                role: "assistant",
                content: msg.content ?? null,
                tool_calls: msg.tool_calls,
            } as Message);

            // Execute all tool calls
            const toolResults = await executeToolCalls(msg.tool_calls);
            messages.push(...toolResults);
        } else {
            // Final text response — done
            const reply = msg.content ?? "(no response)";

            // Build updated history (skip system prompt)
            const updatedHistory: Message[] = [
                ...history,
                { role: "user", content: userMessage },
                { role: "assistant", content: reply },
            ];

            // Log this turn to the daily episodic log
            logTurnSummary(userMessage, reply);

            // Fire per-turn episodic extraction (non-blocking, uses cheap LLM)
            extractEpisodicFromTurn(userMessage, reply).catch(() => { });

            return { reply, history: updatedHistory };
        }
    }
}

