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
- Never claim a tool was called unless it was actually executed in this turn.
- For real-time facts (prices, news, current events), ensure a live search/browse tool call is executed before finalizing.

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

interface ExecutionPlan {
    goal: string;
    steps: string[];
    completion_criteria?: string[];
}

export type PlanningMode = "fast" | "auto" | "autonomous";

interface RunAgentOptions {
    planningMode?: PlanningMode;
}

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

function getTexasDateTimeContext(): string {
    const now = new Date();
    const texasTz = "America/Chicago";

    const dateFmt = new Intl.DateTimeFormat("en-US", {
        timeZone: texasTz,
        year: "numeric",
        month: "long",
        day: "2-digit",
        weekday: "long",
    });

    const timeFmt = new Intl.DateTimeFormat("en-US", {
        timeZone: texasTz,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZoneName: "short",
    });

    const isoUtc = now.toISOString();
    const texasDate = dateFmt.format(now);
    const texasTime = timeFmt.format(now);

    return [
        "## Runtime Time Context",
        `- Texas local date: ${texasDate}`,
        `- Texas local time: ${texasTime}`,
        `- Current UTC timestamp: ${isoUtc}`,
        "- Always reason using this runtime time context instead of model training cutoff assumptions.",
    ].join("\n");
}

function formatExecutionPlanContext(plan: ExecutionPlan | null): string {
    if (!plan || plan.steps.length === 0) return "";

    const lines: string[] = [];
    lines.push("## Active Execution Plan");
    lines.push(`Goal: ${plan.goal}`);
    lines.push("Steps:");
    for (let i = 0; i < plan.steps.length; i++) {
        lines.push(`${i + 1}. ${plan.steps[i]}`);
    }
    if (plan.completion_criteria && plan.completion_criteria.length > 0) {
        lines.push("Completion criteria:");
        for (const c of plan.completion_criteria) lines.push(`- ${c}`);
    }
    lines.push("Follow this plan step-by-step. If blocked, explain blocker and continue with best alternative.");
    return lines.join("\n");
}

function needsBrowserInteraction(userText: string): boolean {
    const t = userText.toLowerCase();
    const browserSignals = [
        "click",
        "fill",
        "type into",
        "login",
        "log in",
        "sign in",
        "submit",
        "form",
        "screenshot",
        "open website",
        "navigate",
        "scrape this page",
        "extract from website",
    ];
    return browserSignals.some((s) => t.includes(s));
}

function needsGoogleSerp(userText: string): boolean {
    const t = userText.toLowerCase();
    return (
        t.includes("google") ||
        t.includes("serp") ||
        t.includes("search results page")
    );
}

function getToolRoutingHintContext(userText: string): string {
    if (needsGoogleSerp(userText)) {
        return [
            "## Tool Routing Hint (Current Request)",
            "- Preferred tool: search_google",
            "- Reason: user explicitly asked for Google SERP behavior.",
            "- Escalate to browser tools only if page interaction or rendering checks are required.",
        ].join("\n");
    }

    if (needsBrowserInteraction(userText)) {
        return [
            "## Tool Routing Hint (Current Request)",
            "- Preferred tool family: browser automation (navigate/click/type_text/extract_text/screenshot).",
            "- Reason: this request appears to need webpage interaction or rendered page state.",
            "- Use perplexity_search only for quick discovery when interaction is not needed.",
        ].join("\n");
    }

    if (needsRealtimeSearchVerification(userText)) {
        return [
            "## Tool Routing Hint (Current Request)",
            "- Preferred tool: perplexity_search first.",
            "- Reason: this request looks like a real-time/current-information query.",
            "- Escalate to browser automation only if direct page interaction is needed after lookup.",
        ].join("\n");
    }

    return [
        "## Tool Routing Hint (Current Request)",
        "- Default preference: use perplexity_search for current web facts, then escalate to browser only for interaction.",
        "- Keep tool use minimal and directly tied to the user request.",
    ].join("\n");
}

function buildSystemPrompt(
    skillContext?: string,
    executionPlanContext?: string,
    toolRoutingHintContext?: string
): string {
    let prompt = BASE_SYSTEM_PROMPT;

    // Inject current date/time every turn to keep temporal reasoning grounded.
    prompt += "\n\n" + getTexasDateTimeContext();

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

    if (executionPlanContext) {
        prompt += "\n\n" + executionPlanContext;
    }

    if (toolRoutingHintContext) {
        prompt += "\n\n" + toolRoutingHintContext;
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
            output.slice(0, 1200)
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

function needsRealtimeSearchVerification(userText: string): boolean {
    const t = userText.toLowerCase();
    const realtimeSignals = [
        "latest",
        "today",
        "current",
        "right now",
        "price",
        "market cap",
        "news",
        "score",
    ];
    const hasSignal = realtimeSignals.some((s) => t.includes(s));
    const excluded = t.includes("wallet") || t.includes("balance");
    return hasSignal && !excluded;
}

function claimsPerplexityUsage(text: string): boolean {
    const t = text.toLowerCase();
    return (
        t.includes("perplexity_search") ||
        t.includes("perplexity search") ||
        t.includes("from perplexity") ||
        t.includes("using perplexity")
    );
}

function needsExecutionPlan(userText: string): boolean {
    const t = userText.toLowerCase();
    const keywords = [
        "autonomous",
        "plan",
        "workflow",
        "step by step",
        "research",
        "then",
        "and then",
        "execute",
        "interact with api",
        "place a bet",
        "multi-step",
    ];
    return keywords.some((k) => t.includes(k));
}

function shouldGenerateExecutionPlan(userText: string, planningMode: PlanningMode): boolean {
    if (planningMode === "fast") return false;
    if (planningMode === "autonomous") return true;
    return needsExecutionPlan(userText);
}

function stripCodeFences(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("```")) return trimmed;
    return trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
}

function parseExecutionPlan(raw: string, fallbackGoal: string): ExecutionPlan | null {
    const cleaned = stripCodeFences(raw);
    try {
        const parsed = JSON.parse(cleaned) as Partial<ExecutionPlan>;
        const goal = (parsed.goal || fallbackGoal).toString().trim();
        const steps = Array.isArray(parsed.steps)
            ? parsed.steps.map((s) => String(s).trim()).filter(Boolean).slice(0, 8)
            : [];
        const completion = Array.isArray(parsed.completion_criteria)
            ? parsed.completion_criteria.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
            : [];
        if (steps.length === 0) return null;
        return { goal, steps, completion_criteria: completion };
    } catch {
        return null;
    }
}

async function generateExecutionPlan(userText: string, history: Message[]): Promise<ExecutionPlan | null> {
    const recentContext = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-6)
        .map((m) => `${m.role}: ${getTextContent(m.content)}`)
        .join("\n");

    const prompt = [
        "Create a concise execution plan for this request.",
        "Return JSON only with this exact schema:",
        '{"goal":"...", "steps":["..."], "completion_criteria":["..."]}',
        "Constraints:",
        "- 3 to 6 steps",
        "- action-oriented and tool-friendly",
        "- no markdown, no extra text",
        "",
        "Recent context:",
        recentContext || "(none)",
        "",
        "User request:",
        userText,
    ].join("\n");

    try {
        const completion = await agentCompletionExecutor.execute(
            "agent:execution_plan_generation",
            () =>
                client.chat.completions.create({
                    model: config.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.2,
                    max_tokens: 500,
                })
        );

        const raw = completion.choices[0]?.message?.content || "";
        return parseExecutionPlan(raw, userText);
    } catch {
        return null;
    }
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
    onToken?: OnTokenCallback,
    options?: RunAgentOptions
): Promise<{ reply: string; history: Message[] }> {
    // Pre-compaction flush when history gets long
    // --- Token Management & Compaction ---
    // We estimate tokens to decide when to flush.
    // (System Prompt + History + User Message)

    // 1. Calculate current context size
    // Note: We build a temporary system prompt to measure it.
    // In a real app, we might cache this, but string concat is cheap enough.
    const textContent = getTextContent(userMessage);
    const planningMode = options?.planningMode ?? "auto";
    const matchedSkill = selectSkill(textContent, skillRegistry);
    const tempSystem = buildSystemPrompt(matchedSkill?.body);
    const estimatedTokens = estimateTokenCount(tempSystem) + estimateTokenCount(JSON.stringify(history)) + estimateTokenCount(textContent);

    if (estimatedTokens >= config.compactionTokenThreshold) {
        console.log("   💾 Context size (" + estimatedTokens + " tokens) exceeded threshold " + config.compactionTokenThreshold + ". Flushing...");
        await flushBeforeCompaction(history);
        history = history.slice(-10); // Keep last 10 messages after flush
    }

    // Select a skill if the user's message matches one
    if (matchedSkill) {
        console.log("   Skill matched: " + matchedSkill.name + " (" + matchedSkill.id + ")");
    }

    let executionPlan: ExecutionPlan | null = null;
    if (shouldGenerateExecutionPlan(textContent, planningMode)) {
        executionPlan = await generateExecutionPlan(textContent, history);
        if (executionPlan) {
            console.log("   Execution plan generated (" + executionPlan.steps.length + " steps)");
        }
    }
    const toolRoutingHintContext = getToolRoutingHintContext(textContent);

    const systemPrompt = buildSystemPrompt(
        matchedSkill?.body,
        formatExecutionPlanContext(executionPlan),
        toolRoutingHintContext
    );

    const messages: Message[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userMessage },
    ];
    const walletGuardIntent = detectWalletGuardIntent(textContent);
    let walletToolCalledInTurn = false;
    const realtimeGuard = needsRealtimeSearchVerification(textContent);
    let realtimeSearchToolCalledInTurn = false;
    let perplexityCalledInTurn = false;
    const calledToolNames = new Set<string>();
    let completedPlanSteps = 0;

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
            for (const tc of toolCalls) calledToolNames.add(tc.function.name);
            if (toolCalls.some((tc) =>
                tc.function.name === "perplexity_search" ||
                tc.function.name === "search_google" ||
                tc.function.name === "navigate" ||
                tc.function.name === "extract_text"
            )) {
                realtimeSearchToolCalledInTurn = true;
            }
            if (toolCalls.some((tc) => tc.function.name === "perplexity_search")) {
                perplexityCalledInTurn = true;
            }
            if (executionPlan && executionPlan.steps.length > 0) {
                completedPlanSteps = Math.min(
                    executionPlan.steps.length,
                    completedPlanSteps + 1
                );
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

            if (realtimeGuard && !realtimeSearchToolCalledInTurn) {
                try {
                    const guarded = await AVAILABLE_TOOLS.perplexity_search({
                        query: textContent,
                        max_results: 5,
                    });
                    calledToolNames.add("perplexity_search");
                    perplexityCalledInTurn = true;
                    reply = `${reply}\n\n(Verified via perplexity_search)\n${guarded}`;
                } catch {
                    reply += "\n\n(No live search tool call was successfully executed for this real-time query.)";
                }
            }

            // Integrity guard: if the assistant claims Perplexity usage without an in-turn call,
            // force an actual call and append the raw tool-backed output.
            if (claimsPerplexityUsage(reply) && !perplexityCalledInTurn) {
                try {
                    const guarded = await AVAILABLE_TOOLS.perplexity_search({
                        query: textContent,
                        max_results: 5,
                    });
                    calledToolNames.add("perplexity_search");
                    perplexityCalledInTurn = true;
                    reply += `\n\n(Tool integrity correction: Perplexity was mentioned without an executed call. Verified now via perplexity_search)\n${guarded}`;
                } catch {
                    reply += "\n\n(Tool integrity correction failed: perplexity_search execution failed.)";
                }
            }

            if (executionPlan && executionPlan.steps.length > 0) {
                const statusLines = executionPlan.steps.map((step, i) => {
                    const done = i < completedPlanSteps;
                    return `${done ? "[done]" : "[pending]"} ${i + 1}. ${step}`;
                });
                reply += `\n\nPlan status:\n${statusLines.join("\n")}`;
            }

            if (calledToolNames.size > 0) {
                reply += `\n\nTools executed this turn: ${Array.from(calledToolNames).join(", ")}`;
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

function getTextContent(content: unknown): string {
    if (content === null || content === undefined) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((p) => {
                if (!p || typeof p !== "object") return "";
                const part = p as ChatCompletionContentPart;
                if (part.type === "text") {
                    return "text" in part && typeof part.text === "string" ? part.text : "";
                }
                return "[image]";
            })
            .join(" ");
    }
    if (typeof content === "object") {
        try {
            return JSON.stringify(content);
        } catch {
            return String(content);
        }
    }
    return String(content);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 3.5); // Rough heuristic for English text
}
