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
import {
    loadSkills,
    buildSkillSummary,
    selectSkill,
} from "./skills/registry.js";
import { ResilientExecutor } from "./runtime/resilience.js";

const BASE_SYSTEM_PROMPT = `You are Oasis, a capable browser-automation agent.
You can browse the web, interact with pages, extract information, and search Google.

Guidelines:
- Use tools to gather real data before answering. Do NOT guess or hallucinate content.
- When navigating, always use full URLs (https://).
- Use extract_text after navigating to read page content.
- Use search_google when you need to find something and don't have a direct URL.
- Use run_command to execute shell commands (e.g., git, npm). This requires user approval.
- Be concise in your final answers. Summarize what you found clearly.
- If a tool call fails, try an alternative approach before giving up.
- Reference any user preferences or known facts from your memory when relevant.`;

const client = new OpenAI({
    apiKey: config.openaiKey,
    baseURL: config.openaiBaseUrl,
});
const agentCompletionExecutor = new ResilientExecutor({
    retry: {
        maxAttempts: 3,
        baseDelayMs: 400,
        maxDelayMs: 4000,
        jitterRatio: 0.2,
    },
    circuitBreaker: {
        failureThreshold: 4,
        cooldownMs: 60 * 1000,
    },
});

export type Message = ChatCompletionMessageParam;

// ---------------------------------------------------------------------------
// Skill registry (loaded once at startup)
// ---------------------------------------------------------------------------

const skillRegistry = loadSkills();
if (skillRegistry.size > 0) {
    const ids = Array.from(skillRegistry.keys()).join(", ");
    console.log("   Loaded " + skillRegistry.size + " skill(s): " + ids);
}

// ---------------------------------------------------------------------------
// Build system prompt with memory context
// ---------------------------------------------------------------------------

function buildSystemPrompt(skillContext?: string): string {
    let prompt = BASE_SYSTEM_PROMPT;

    // Append memory context
    const bootstrapContext = loadBootstrapContext();
    if (bootstrapContext.trim()) {
        prompt += "\n\n" + bootstrapContext;
    }

    // Append compact skill catalogue
    const skillSummary = buildSkillSummary(skillRegistry);
    if (skillSummary) {
        prompt += "\n" + skillSummary;
    }

    // Append full skill instructions (selected for this turn)
    if (skillContext) {
        prompt += "\n\n## Active Skill Instructions\n" + skillContext;
    }

    return prompt;
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
                output = "Error executing " + tc.function.name + ": " + (err as Error).message;
            }
        } else {
            output = "Unknown tool: " + tc.function.name;
        }

        console.log("   Tool: " + tc.function.name + " -> " + output.slice(0, 80) + "...");

        results.push({
            role: "tool",
            tool_call_id: tc.id,
            content: output,
        });
    }

    return results;
}

// ---------------------------------------------------------------------------
// Agent loop (streaming)
// ---------------------------------------------------------------------------

export type OnTokenCallback = (token: string) => void;

export function getAgentHealthMetrics() {
    return agentCompletionExecutor.getAllMetrics();
}

export async function runAgent(
    userMessage: string,
    history: Message[],
    onToken?: OnTokenCallback
): Promise<{ reply: string; history: Message[] }> {
    // Pre-compaction flush when history gets long
    // --- Token Management & Compaction ---
    // We estimate tokens to decide when to flush.
    // (System Prompt + History + User Message)

    // 1. Calculate current context size
    // Note: We build a temporary system prompt to measure it.
    // In a real app, we might cache this, but string concat is cheap enough.
    const tempSystem = buildSystemPrompt(selectSkill(userMessage, skillRegistry)?.body);
    const estimatedTokens = estimateTokenCount(tempSystem) + estimateTokenCount(JSON.stringify(history)) + estimateTokenCount(userMessage);

    if (estimatedTokens >= config.compactionTokenThreshold) {
        console.log("   💾 Context size (" + estimatedTokens + " tokens) exceeded threshold " + config.compactionTokenThreshold + ". Flushing...");
        await flushBeforeCompaction(history);
        history = history.slice(-10); // Keep last 10 messages after flush
    }

    // Select a skill if the user's message matches one
    const matchedSkill = selectSkill(userMessage, skillRegistry);
    if (matchedSkill) {
        console.log("   Skill matched: " + matchedSkill.name + " (" + matchedSkill.id + ")");
    }

    const systemPrompt = buildSystemPrompt(matchedSkill?.body);

    const messages: Message[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userMessage },
    ];

    // Tool-call loop — keep going until the model returns a text response
    while (true) {
        const stream = await agentCompletionExecutor.execute(
            "agent:chat_completion_stream",
            () =>
                client.chat.completions.create({
                    model: config.model,
                    messages,
                    tools: TOOLS_SCHEMA,
                    tool_choice: "auto",
                    temperature: config.temperature,
                    max_tokens: config.maxTokens,
                    stream: true,
                })
        );

        // Accumulate the streamed response
        let contentAccum = "";
        const toolCallAccum: Map<number, {
            id: string;
            name: string;
            arguments: string;
        }> = new Map();
        let hasToolCalls = false;

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            // --- Text content ---
            if (delta.content) {
                contentAccum += delta.content;
                if (onToken) onToken(delta.content);
            }

            // --- Tool calls (accumulated from deltas) ---
            if (delta.tool_calls) {
                hasToolCalls = true;
                for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    const existing = toolCallAccum.get(idx);

                    if (existing) {
                        if (tc.function?.arguments) {
                            existing.arguments += tc.function.arguments;
                        }
                    } else {
                        toolCallAccum.set(idx, {
                            id: tc.id || "",
                            name: tc.function?.name || "",
                            arguments: tc.function?.arguments || "",
                        });
                    }
                }
            }
        }

        if (hasToolCalls && toolCallAccum.size > 0) {
            // Convert accumulated tool calls to the expected format
            const toolCalls: ChatCompletionMessageToolCall[] = Array.from(
                toolCallAccum.entries()
            ).map(([, tc]) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                    name: tc.name,
                    arguments: tc.arguments,
                },
            }));

            // Append assistant message with tool calls
            messages.push({
                role: "assistant",
                content: contentAccum || null,
                tool_calls: toolCalls,
            } as Message);

            // Execute all tool calls
            const toolResults = await executeToolCalls(toolCalls);
            messages.push(...toolResults);
        } else {
            // Final text response — done
            const reply = contentAccum || "(no response)";

            const updatedHistory: Message[] = [
                ...history,
                { role: "user", content: userMessage },
                { role: "assistant", content: reply },
            ];

            // Log this turn to the daily episodic log
            logTurnSummary(userMessage, reply);

            // Fire per-turn episodic extraction (non-blocking)
            extractEpisodicFromTurn(userMessage, reply).catch(() => { });

            return { reply, history: updatedHistory };
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 3.5); // Rough heuristic for English text
}
