import OpenAI from "openai";
import type {
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCall,
    ChatCompletionContentPart,
} from "openai/resources/chat/completions";
import { config } from "./utils/config.js";
import { TOOLS_SCHEMA, AVAILABLE_TOOLS } from "./tools/registry.js";
import { agentBus } from "./utils/events.js";
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

const BASE_SYSTEM_PROMPT = `You are Oasis — an autonomous AI agent.
You operate independently: you send your own heartbeats, run scheduled tasks, and manage your own lifecycle.
You are running on your own personal computer (a dedicated server). The filesystem, shell, and browser are all yours.
Your owner communicates with you over Telegram. You are always-on and self-sufficient.

You have several tools at your disposal:
- A web browser (navigate, click, type, extract text, screenshot, search Google)
- A shell (run commands — git, npm, scripts, etc.)
- An ETH wallet on Base — this is YOUR wallet. You can check your balance, send ETH or tokens, and call any smart contract (read state, swap tokens, mint NFTs, interact with DeFi protocols). Write transactions always need your owner's approval via Telegram, but read-only calls are yours to make freely. If you don't know a contract address, look it up yourself using the browser.
- Scheduled reminders and a heartbeat system

Guidelines:
- Act autonomously. Use your tools to gather real data — never guess or hallucinate.
- Learn your user. Pay attention to their habits, preferences, interests, and schedule. Adapt to their rhythm.
- Be in sync. You and your user are a team — anticipate their needs, remember what matters to them, and align with their goals.
- When browsing, always use full URLs (https://) and extract_text after navigating.
- Prefer perplexity_search for fast real-time web lookup before full browser automation.
- Use search_google when you need raw SERP behavior from Google specifically.
- For any wallet-specific question (address, balance, token holdings, tx hash), ALWAYS call the corresponding wallet tool first. Never guess or reuse a previously stated wallet value without re-checking.
- For heartbeat scheduling requests, use heartbeat_status / heartbeat_set / heartbeat_disable tools instead of telling the user to edit config files.
- In Telegram runtime, critical intents may be routed deterministically (update/wallet/balance) before LLM planning; align with those direct tool-backed paths.
- Shell commands (run_command) may require user approval depending on the current permission mode.
- Be concise. Summarize findings clearly.
- If a tool call fails, try an alternative approach before giving up.
- Reference any user preferences or known facts from your memory when relevant.
- You are not just a chatbot — you are an agent. Take initiative when appropriate.

Communication style:
- Talk naturally, like you're texting a friend. Keep it casual and conversational.
- NEVER use markdown tables, headers (#), or horizontal rules (---) in chat responses.
- Use short paragraphs and plain text. Bold and bullet points are fine sparingly.
- Don't over-format. If someone sends you a photo, just describe it naturally — don't make a chart about it.`;

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
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments); } catch { /* empty args */ }

        agentBus.emitToolStart(tc.function.name, args);
        const t0 = Date.now();

        if (fn) {
            try {
                output = await fn(args);
            } catch (err) {
                output = "Error executing " + tc.function.name + ": " + (err as Error).message;
            }
        } else {
            output = "Unknown tool: " + tc.function.name;
        }

        agentBus.emitToolEnd(
            tc.function.name,
            Date.now() - t0,
            !output.startsWith("Error"),
            output.slice(0, 240)
        );
        console.log("   Tool: " + tc.function.name + " -> " + output.slice(0, 80) + "...");

        results.push({
            role: "tool",
            tool_call_id: tc.id,
            content: output,
        });
    }

    return results;
}

function detectWalletGuardIntent(userText: string): "wallet_address" | "wallet_balance" | null {
    const t = userText.toLowerCase();
    const walletish =
        t.includes("wallet") || t.includes("address") || t.includes("balance") || t.includes("eth");
    if (!walletish) return null;

    if (t.includes("address")) return "wallet_address";
    if (t.includes("balance") || t.includes("how much")) return "wallet_balance";
    return null;
}

// ---------------------------------------------------------------------------
// Agent loop (streaming)
// ---------------------------------------------------------------------------

export type OnTokenCallback = (token: string) => void;

export function getAgentHealthMetrics() {
    return agentCompletionExecutor.getAllMetrics();
}

export async function runAgent(
    userMessage: string | ChatCompletionContentPart[],
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
    const tempSystem = buildSystemPrompt(selectSkill(getTextContent(userMessage), skillRegistry)?.body);
    const estimatedTokens = estimateTokenCount(tempSystem) + estimateTokenCount(JSON.stringify(history)) + estimateTokenCount(getTextContent(userMessage));

    if (estimatedTokens >= config.compactionTokenThreshold) {
        console.log("   💾 Context size (" + estimatedTokens + " tokens) exceeded threshold " + config.compactionTokenThreshold + ". Flushing...");
        await flushBeforeCompaction(history);
        history = history.slice(-10); // Keep last 10 messages after flush
    }

    // Select a skill if the user's message matches one
    const textContent = getTextContent(userMessage);
    const matchedSkill = selectSkill(textContent, skillRegistry);
    if (matchedSkill) {
        console.log("   Skill matched: " + matchedSkill.name + " (" + matchedSkill.id + ")");
    }

    const systemPrompt = buildSystemPrompt(matchedSkill?.body);

    const messages: Message[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userMessage },
    ];
    const walletGuardIntent = detectWalletGuardIntent(textContent);
    let walletToolCalledInTurn = false;

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
            if (toolCalls.some((tc) => tc.function.name.startsWith("wallet_"))) {
                walletToolCalledInTurn = true;
            }

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
            let reply = contentAccum || "(no response)";

            // Hard guard: for wallet address/balance queries, force tool-backed value if no wallet tool was used.
            if (walletGuardIntent && !walletToolCalledInTurn) {
                try {
                    const guarded = await AVAILABLE_TOOLS[walletGuardIntent]({});
                    reply = `${reply}\n\n(Verified via ${walletGuardIntent})\n${guarded}`;
                } catch {
                    // Keep model reply if guard call fails unexpectedly.
                }
            }

            const updatedHistory: Message[] = [
                ...history,
                { role: "user", content: userMessage },
                { role: "assistant", content: reply },
            ];

            // Log this turn to the daily episodic log
            logTurnSummary(getTextContent(userMessage), reply);

            // Fire per-turn episodic extraction (non-blocking)
            extractEpisodicFromTurn(getTextContent(userMessage), reply).catch(() => { });

            return { reply, history: updatedHistory };
        }
    }
}

function getTextContent(content: string | ChatCompletionContentPart[]): string {
    if (typeof content === "string") return content;
    return content.map(p => p.type === "text" ? p.text : "[image]").join(" ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 3.5); // Rough heuristic for English text
}
