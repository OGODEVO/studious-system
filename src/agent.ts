import OpenAI from "openai";
import { encoding_for_model, get_encoding } from "tiktoken";
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
- Moltbook social tools (register, profile/status, post, comment, upvote, feed)
- A shell (run commands — git, npm, scripts, etc.)
- An ETH wallet on Base — this is YOUR wallet. You can check your balance, send ETH or tokens, and call any smart contract (read state, swap tokens, mint NFTs, interact with DeFi protocols). Write transactions always need your owner's approval via Telegram, but read-only calls are yours to make freely. If you don't know a contract address, look it up yourself using the browser.
- Scheduled reminders and a heartbeat system
- Persistent memory tools (memory_write, goal_write) for storing durable user facts/preferences and mission progress

Guidelines:
- Act autonomously. Use your tools to gather real data — never guess or hallucinate.
- Learn your user. Pay attention to their habits, preferences, interests, and schedule. Adapt to their rhythm.
- Be in sync. You and your user are a team — anticipate their needs, remember what matters to them, and align with their goals.
- When browsing, always use full URLs (https://) and extract_text after navigating.
- Prefer perplexity_search for fast real-time web lookup before full browser automation.
- Use Moltbook tools for Moltbook actions; do not simulate posts/comments in plain text.
- Use search_google when you need raw SERP behavior from Google specifically.
- For "what's today's date/time" or other local time/date questions, answer from Runtime Time Context and do not use web search tools.
- For any wallet-specific question (address, balance, token holdings, tx hash), ALWAYS call the corresponding wallet tool first. Never guess or reuse a previously stated wallet value without re-checking.
- For heartbeat scheduling requests, use heartbeat_status / heartbeat_set / heartbeat_disable tools instead of telling the user to edit config files.
- For one-time internal cron tasks, use reminder_once_in / reminder_once_at / reminder_once_list / reminder_once_cancel (agent-only scheduling).
- When the user states durable preferences, constraints, or long-term goals, use memory_write / goal_write to persist them.
- In Telegram runtime, critical intents may be routed deterministically (update/wallet/balance) before LLM planning; align with those direct tool-backed paths.
- Shell commands (run_command) may require user approval depending on the current permission mode.
- If the user asks you to perform a tool-capable action, execute it in the same turn and return the result. Do not send placeholder responses like "I'll check" without actually running the tool.
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

export interface TokenUsageEstimate {
    contextTokens: number;
    replyTokens: number;
    totalTokens: number;
    threshold: number;
    contextPercent: number;
    remainingToThreshold: number;
    countMode: "exact-ish" | "estimate";
}

export interface AgentRunResult {
    reply: string;
    history: Message[];
    tokenUsage: TokenUsageEstimate;
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
    if (isLocalDateTimeQuery(userText)) {
        return [
            "## Tool Routing Hint (Current Request)",
            "- Do not use web search for this request.",
            "- Reason: this is a local date/time question and Runtime Time Context is authoritative.",
            "- Answer directly from runtime clock context.",
        ].join("\n");
    }

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
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments); } catch { /* empty args */ }
        const output = await executeSingleTool(tc.function.name, args);

        results.push({
            role: "tool",
            tool_call_id: tc.id,
            content: output,
        });
    }

    return results;
}

async function executeSingleTool(
    toolName: string,
    args: Record<string, unknown>
): Promise<string> {
    const fn = AVAILABLE_TOOLS[toolName];
    let output: string;

    agentBus.emitToolStart(toolName, args);
    const t0 = Date.now();

    if (fn) {
        try {
            output = await fn(args);
        } catch (err) {
            output = "Error executing " + toolName + ": " + (err as Error).message;
        }
    } else {
        output = "Unknown tool: " + toolName;
    }

    agentBus.emitToolEnd(
        toolName,
        Date.now() - t0,
        !output.startsWith("Error"),
        output.slice(0, 1200)
    );
    console.log("   Tool: " + toolName + " -> " + output.slice(0, 80) + "...");
    return output;
}

function detectWalletGuardIntent(userText: string): "wallet_address" | "wallet_balance" | null {
    const t = userText.toLowerCase();
    const walletish =
        t.includes("wallet") ||
        t.includes("address") ||
        t.includes("balance") ||
        t.includes("bal") ||
        t.includes("eth");
    if (!walletish) return null;

    const asksAddress =
        /\baddress\b/.test(t) ||
        /\bwhat(?:'s| is)\s+your\s+wallet\b/.test(t);
    if (asksAddress) return "wallet_address";

    const asksBalance =
        /\bbalance\b/.test(t) ||
        /\bbal\b/.test(t) ||
        /\beth balance\b/.test(t) ||
        /\bhow much\b/.test(t) ||
        /\bcheck\b.*\bbal(?:ance)?\b/.test(t) ||
        /\bwhat(?:'s| is)\s+(?:your|my)\s+bal(?:ance)?\b/.test(t);
    if (asksBalance) return "wallet_balance";

    // Default wallet-ish asks to balance unless clearly address-specific.
    return "wallet_balance";
}

function detectWalletDeterministicIntent(userText: string): "wallet_address" | "wallet_balance" | null {
    const t = userText.toLowerCase();
    if (/\b(send|transfer|withdraw|pay)\b/.test(t)) return null;

    const asksAddress =
        (t.includes("wallet") && t.includes("address")) ||
        /\bwhat(?:'s| is)\s+your\s+wallet\b/.test(t);
    if (asksAddress) return "wallet_address";

    const asksBalance =
        /\bwhat(?:'s| is)\s+(?:your|my)\s+(?:wallet\s+)?bal(?:ance)?\b/.test(t) ||
        /\bcheck\b.*\bbal(?:ance)?\b/.test(t) ||
        /\beth balance\b/.test(t) ||
        /\bhow much eth\b/.test(t);
    if (asksBalance) return "wallet_balance";

    return null;
}

type DeterministicToolRoute = {
    tool: keyof typeof AVAILABLE_TOOLS;
    args: Record<string, unknown>;
};

function extractFieldValue(text: string, field: string): string | null {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = new RegExp(`${escaped}\\s*:\\s*"([^"]+)"`, "i");
    const singleQuoted = new RegExp(`${escaped}\\s*:\\s*'([^']+)'`, "i");
    const plain = new RegExp(`${escaped}\\s*:\\s*([^,\\n]+)`, "i");

    const q = text.match(quoted);
    if (q?.[1]) return q[1].trim();
    const sq = text.match(singleQuoted);
    if (sq?.[1]) return sq[1].trim();
    const p = text.match(plain);
    if (p?.[1]) return p[1].trim();
    return null;
}

function parseMoltbookRoute(userText: string): DeterministicToolRoute | null {
    const t = userText.toLowerCase();
    if (!t.includes("moltbook")) return null;

    if (/\bmoltbook\b.*\b(me|profile)\b/.test(t)) {
        return { tool: "moltbook_me", args: {} };
    }
    if (/\bmoltbook\b.*\bstatus\b/.test(t)) {
        return { tool: "moltbook_status", args: {} };
    }
    if (/\bmoltbook\b.*\bfeed\b/.test(t)) {
        const sort =
            /\brising\b/.test(t) ? "rising"
                : /\btop\b/.test(t) ? "top"
                    : /\bnew\b/.test(t) ? "new"
                        : "hot";
        const limitMatch = t.match(/\blimit\s*[:=]?\s*(\d{1,2})\b/);
        const submolt = extractFieldValue(userText, "submolt") ?? extractFieldValue(userText, "community");
        return {
            tool: "moltbook_feed",
            args: {
                sort,
                ...(limitMatch ? { limit: Number(limitMatch[1]) } : {}),
                ...(submolt ? { submolt } : {}),
            },
        };
    }
    if (/\bmoltbook\b.*\bupvote\b/.test(t)) {
        const postId = extractFieldValue(userText, "post_id") ?? extractFieldValue(userText, "post");
        if (!postId) return null;
        return { tool: "moltbook_upvote", args: { post_id: postId } };
    }
    if (/\bmoltbook\b.*\bcomment\b/.test(t)) {
        const postId = extractFieldValue(userText, "post_id") ?? extractFieldValue(userText, "post");
        const content = extractFieldValue(userText, "content");
        const parentId = extractFieldValue(userText, "parent_id");
        if (!postId || !content) return null;
        return {
            tool: "moltbook_comment",
            args: {
                post_id: postId,
                content,
                ...(parentId ? { parent_id: parentId } : {}),
            },
        };
    }
    if (/\bmoltbook\b.*\bpost\b/.test(t)) {
        const submolt = extractFieldValue(userText, "submolt");
        const title = extractFieldValue(userText, "title");
        const content = extractFieldValue(userText, "content");
        const url = extractFieldValue(userText, "url");
        if (!submolt || !title || (!content && !url)) return null;
        return {
            tool: "moltbook_post",
            args: {
                submolt,
                title,
                ...(content ? { content } : {}),
                ...(url ? { url } : {}),
            },
        };
    }
    if (/\bmoltbook\b.*\bregister\b/.test(t)) {
        const name = extractFieldValue(userText, "name");
        const description = extractFieldValue(userText, "description");
        if (!name) return null;
        return {
            tool: "moltbook_register",
            args: {
                name,
                ...(description ? { description } : {}),
            },
        };
    }
    return null;
}

function parseSchedulerRoute(userText: string): DeterministicToolRoute | null {
    const t = userText.toLowerCase().trim();

    if ((t.includes("heartbeat") && /\b(off|disable|stop)\b/.test(t)) || t === "/heartbeat off") {
        return { tool: "heartbeat_disable", args: {} };
    }

    if (t === "/heartbeat" || /\bheartbeat status\b/.test(t)) {
        return { tool: "heartbeat_status", args: {} };
    }

    const hbSetMatch = t.match(/\bheartbeat\b.*?(\d{1,4}(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/);
    if (hbSetMatch) {
        const prompt = extractFieldValue(userText, "prompt");
        return {
            tool: "heartbeat_set",
            args: {
                interval_minutes: Number(hbSetMatch[1]),
                ...(prompt ? { prompt } : {}),
            },
        };
    }

    if (/\breminder\b.*\blist\b/.test(t) || t === "/reminders") {
        return { tool: "reminder_once_list", args: {} };
    }

    if (/\breminder\b.*\bcancel\b/.test(t)) {
        const id = extractFieldValue(userText, "id");
        if (!id) return null;
        return { tool: "reminder_once_cancel", args: { id } };
    }

    const inMatch = userText.match(
        /\b(?:remind(?:er)?(?: me)?|schedule)\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\s+(?:to\s+)?(.+)$/i
    );
    if (inMatch?.[1] && inMatch?.[2] && inMatch?.[3]) {
        const raw = Number(inMatch[1]);
        const unit = inMatch[2].toLowerCase();
        const prompt = inMatch[3].trim();
        if (Number.isFinite(raw) && prompt) {
            const minutes = unit.startsWith("h") ? raw * 60 : raw;
            return { tool: "reminder_once_in", args: { minutes, prompt } };
        }
    }

    const atIsoField = extractFieldValue(userText, "run_at_iso");
    const atPromptField = extractFieldValue(userText, "prompt");
    if (atIsoField && atPromptField) {
        return {
            tool: "reminder_once_at",
            args: { run_at_iso: atIsoField, prompt: atPromptField },
        };
    }

    const atMatch = userText.match(
        /\b(?:remind(?:er)?(?: me)?|schedule)\s+(?:at|on)\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:\-.+Z]+)\s+(?:to\s+)?(.+)$/i
    );
    if (atMatch?.[1] && atMatch?.[2]) {
        return {
            tool: "reminder_once_at",
            args: { run_at_iso: atMatch[1].trim(), prompt: atMatch[2].trim() },
        };
    }

    return null;
}

function getTexasNowReply(): string {
    const now = new Date();
    const tz = "America/Chicago";
    const date = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "2-digit",
    }).format(now);
    const time = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZoneName: "short",
    }).format(now);
    return `Texas local date/time: ${date}, ${time}.`;
}

async function tryDeterministicRoute(userText: string): Promise<string | null> {
    if (isLocalDateTimeQuery(userText)) {
        return getTexasNowReply();
    }

    const walletIntent = detectWalletDeterministicIntent(userText);
    if (walletIntent) {
        return executeSingleTool(walletIntent, {});
    }

    const schedulerRoute = parseSchedulerRoute(userText);
    if (schedulerRoute) {
        return executeSingleTool(schedulerRoute.tool, schedulerRoute.args);
    }

    const moltbookRoute = parseMoltbookRoute(userText);
    if (moltbookRoute) {
        return executeSingleTool(moltbookRoute.tool, moltbookRoute.args);
    }

    return null;
}

function isLocalDateTimeQuery(userText: string): boolean {
    const t = userText.toLowerCase().trim();
    const asksDateOrTime =
        t.includes("today's date") ||
        t.includes("todays date") ||
        t.includes("current date") ||
        t.includes("current time") ||
        t.includes("what day is it") ||
        /\bwhat(?:'s| is)\s+(?:the\s+)?(?:date|time)\b/.test(t) ||
        /\bdate\s+today\b/.test(t);

    if (!asksDateOrTime) return false;

    const externalTopicSignals = [
        "btc",
        "bitcoin",
        "stock",
        "price",
        "market",
        "news",
        "weather",
        "score",
        "nba",
        "nfl",
        "wallet",
        "eth",
    ];
    return !externalTopicSignals.some((s) => t.includes(s));
}

function needsRealtimeSearchVerification(userText: string): boolean {
    const t = userText.toLowerCase();
    if (isLocalDateTimeQuery(t)) return false;
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

function claimsMoltbookUsage(text: string): boolean {
    const t = text.toLowerCase();
    return (
        t.includes("moltbook") &&
        (
            t.includes("post") ||
            t.includes("comment") ||
            t.includes("upvote") ||
            t.includes("feed") ||
            t.includes("status") ||
            t.includes("registered")
        )
    );
}

function claimsSchedulerAction(text: string): boolean {
    const t = text.toLowerCase();
    return (
        t.includes("heartbeat") ||
        t.includes("scheduled") ||
        t.includes("reminder set") ||
        t.includes("i'll remind") ||
        t.includes("i will remind")
    );
}

function isPromiseWithoutAction(text: string): boolean {
    const t = text.toLowerCase();
    const promiseSignals = [
        "i'll",
        "i will",
        "let me",
        "i can check",
        "i can do that",
        "i'm going to",
        "i will now",
    ];
    const actionSignals = [
        "check",
        "pull",
        "update",
        "search",
        "browse",
        "send",
        "post",
        "comment",
        "upvote",
        "schedule",
        "set",
        "run",
        "fetch",
    ];
    const hasPromise = promiseSignals.some((s) => t.includes(s));
    const hasAction = actionSignals.some((s) => t.includes(s));
    return hasPromise && hasAction;
}

function isLikelyToolCapableRequest(userText: string): boolean {
    const t = userText.toLowerCase();
    const signals = [
        "wallet",
        "balance",
        "address",
        "send",
        "transfer",
        "search",
        "latest",
        "price",
        "news",
        "browse",
        "open",
        "navigate",
        "moltbook",
        "post",
        "comment",
        "upvote",
        "heartbeat",
        "reminder",
        "schedule",
        "update",
        "pull",
        "run command",
    ];
    return signals.some((s) => t.includes(s));
}

async function rewriteReplyWithLiveSearch(
    userText: string,
    draftReply: string,
    liveSearchOutput: string
): Promise<string> {
    const prompt = [
        "Revise the assistant reply using verified live-search results.",
        "Return only the final user-facing answer.",
        "Rules:",
        "- Do not mention tools, traces, or internal verification.",
        "- Do not include raw URLs unless the user explicitly asked for links.",
        "- Keep it concise and directly answer the user.",
        "",
        "User request:",
        userText,
        "",
        "Draft reply:",
        draftReply || "(empty)",
        "",
        "Verified live-search results:",
        liveSearchOutput,
    ].join("\n");

    try {
        const completion = await agentCompletionExecutor.execute(
            "agent:live_search_rewrite",
            () =>
                client.chat.completions.create({
                    model: config.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.2,
                    max_tokens: 450,
                })
        );
        const revised = completion.choices[0]?.message?.content?.trim();
        return revised || draftReply;
    } catch {
        return draftReply;
    }
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

export function estimateTokenContext(
    userMessage: string | ChatCompletionContentPart[],
    history: Message[],
    options?: RunAgentOptions
): TokenUsageEstimate {
    const tokenCounter = getTokenCounter(config.model);
    const textContent = getTextContent(userMessage);
    const planningMode = options?.planningMode ?? "auto";
    const matchedSkill = selectSkill(textContent, skillRegistry);
    const executionPlanContext = shouldGenerateExecutionPlan(textContent, planningMode)
        ? "## Active Execution Plan\n(estimated)"
        : undefined;
    const systemPrompt = buildSystemPrompt(
        matchedSkill?.body,
        executionPlanContext,
        getToolRoutingHintContext(textContent)
    );
    const contextTokens =
        tokenCounter.count(systemPrompt) +
        tokenCounter.count(JSON.stringify(history)) +
        tokenCounter.count(textContent);
    const threshold = config.compactionTokenThreshold;
    const remainingToThreshold = Math.max(0, threshold - contextTokens);
    const contextPercent = threshold > 0 ? Number(((contextTokens / threshold) * 100).toFixed(1)) : 0;
    return {
        contextTokens,
        replyTokens: 0,
        totalTokens: contextTokens,
        threshold,
        contextPercent,
        remainingToThreshold,
        countMode: tokenCounter.mode,
    };
}

export async function runAgent(
    userMessage: string | ChatCompletionContentPart[],
    history: Message[],
    onToken?: OnTokenCallback,
    options?: RunAgentOptions
): Promise<AgentRunResult> {
    // Pre-compaction flush when history gets long
    // --- Token Management & Compaction ---
    // We estimate tokens to decide when to flush.
    // (System Prompt + History + User Message)

    // 1. Calculate current context size
    // Note: We build a temporary system prompt to measure it.
    // In a real app, we might cache this, but string concat is cheap enough.
    const textContent = getTextContent(userMessage);
    const tokenCounter = getTokenCounter(config.model);
    const planningMode = options?.planningMode ?? "auto";
    const matchedSkill = selectSkill(textContent, skillRegistry);
    const tempSystem = buildSystemPrompt(
        matchedSkill?.body,
        undefined,
        getToolRoutingHintContext(textContent)
    );
    const estimatedTokens =
        tokenCounter.count(tempSystem) +
        tokenCounter.count(JSON.stringify(history)) +
        tokenCounter.count(textContent);

    if (estimatedTokens >= config.compactionTokenThreshold) {
        console.log("   💾 Context size (" + estimatedTokens + " tokens) exceeded threshold " + config.compactionTokenThreshold + ". Flushing...");
        await flushBeforeCompaction(history);
        history = history.slice(-10); // Keep last 10 messages after flush
    }

    // Select a skill if the user's message matches one
    if (matchedSkill) {
        console.log("   Skill matched: " + matchedSkill.name + " (" + matchedSkill.id + ")");
    }

    // Deterministic high-confidence router for obvious tool-intents.
    // This removes model guessing for wallet/date-time/moltbook/scheduler intents.
    const deterministicReply = await tryDeterministicRoute(textContent);
    if (deterministicReply) {
        const deterministicSystem = buildSystemPrompt(
            matchedSkill?.body,
            undefined,
            getToolRoutingHintContext(textContent)
        );
        const updatedHistory: Message[] = [
            ...history,
            { role: "user", content: userMessage },
            { role: "assistant", content: deterministicReply },
        ];
        const contextTokens =
            tokenCounter.count(deterministicSystem) +
            tokenCounter.count(JSON.stringify(history)) +
            tokenCounter.count(textContent);
        const replyTokens = tokenCounter.count(deterministicReply);
        const threshold = config.compactionTokenThreshold;
        const tokenUsage: TokenUsageEstimate = {
            contextTokens,
            replyTokens,
            totalTokens: contextTokens + replyTokens,
            threshold,
            contextPercent: threshold > 0 ? Number(((contextTokens / threshold) * 100).toFixed(1)) : 0,
            remainingToThreshold: Math.max(0, threshold - contextTokens),
            countMode: tokenCounter.mode,
        };

        logTurnSummary(getTextContent(userMessage), deterministicReply);
        extractEpisodicFromTurn(getTextContent(userMessage), deterministicReply).catch(() => { });
        return { reply: deterministicReply, history: updatedHistory, tokenUsage };
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
    let schedulerToolCalledInTurn = false;
    let moltbookToolCalledInTurn = false;
    const realtimeGuard = needsRealtimeSearchVerification(textContent);
    let realtimeSearchToolCalledInTurn = false;
    let perplexityCalledInTurn = false;
    let anyToolCalledInTurn = false;
    let actionRecoveryRetries = 0;
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
            anyToolCalledInTurn = true;
            if (toolCalls.some((tc) => tc.function.name.startsWith("wallet_"))) {
                walletToolCalledInTurn = true;
            }
            if (toolCalls.some((tc) =>
                tc.function.name.startsWith("heartbeat_") ||
                tc.function.name.startsWith("reminder_once_")
            )) {
                schedulerToolCalledInTurn = true;
            }
            if (toolCalls.some((tc) => tc.function.name.startsWith("moltbook_"))) {
                moltbookToolCalledInTurn = true;
            }
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
                    anyToolCalledInTurn = true;
                    reply = `${guarded}\n\n${reply}`;
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
                    anyToolCalledInTurn = true;
                    perplexityCalledInTurn = true;
                    reply = await rewriteReplyWithLiveSearch(textContent, reply, guarded);
                } catch {
                    // Keep draft reply if fallback search verification fails.
                }
            }

            // Integrity guard: if the assistant claims Perplexity usage without an in-turn call,
            // force an actual call and silently rewrite the reply from verified results.
            if (claimsPerplexityUsage(reply) && !perplexityCalledInTurn) {
                try {
                    const guarded = await AVAILABLE_TOOLS.perplexity_search({
                        query: textContent,
                        max_results: 5,
                    });
                    anyToolCalledInTurn = true;
                    perplexityCalledInTurn = true;
                    reply = await rewriteReplyWithLiveSearch(textContent, reply, guarded);
                } catch {
                    // Keep original reply if correction call fails.
                }
            }

            // Integrity guard: if the assistant claims Moltbook actions without tool execution,
            // force a deterministic Moltbook tool call when possible.
            if (claimsMoltbookUsage(reply) && !moltbookToolCalledInTurn) {
                try {
                    const route = parseMoltbookRoute(textContent);
                    if (route) {
                        const guarded = await executeSingleTool(route.tool, route.args);
                        reply = `${guarded}\n\n${reply}`;
                        anyToolCalledInTurn = true;
                        moltbookToolCalledInTurn = true;
                    }
                } catch {
                    // Keep original reply on guard failure.
                }
            }

            // Integrity guard: if scheduler actions are claimed without scheduler tool execution,
            // force the matching scheduler tool call when intent is parseable.
            if (claimsSchedulerAction(reply) && !schedulerToolCalledInTurn) {
                try {
                    const route = parseSchedulerRoute(textContent);
                    if (route) {
                        const guarded = await executeSingleTool(route.tool, route.args);
                        reply = `${guarded}\n\n${reply}`;
                        anyToolCalledInTurn = true;
                        schedulerToolCalledInTurn = true;
                    }
                } catch {
                    // Keep original reply on guard failure.
                }
            }

            const shouldRecoverAction =
                isLikelyToolCapableRequest(textContent) &&
                !anyToolCalledInTurn &&
                isPromiseWithoutAction(reply) &&
                !reply.trim().toUpperCase().startsWith("BLOCKED:");

            if (shouldRecoverAction && actionRecoveryRetries < 2) {
                actionRecoveryRetries += 1;
                messages.push({ role: "assistant", content: reply });
                messages.push({
                    role: "user",
                    content: [
                        "SYSTEM OVERRIDE:",
                        "You promised an action but no tool was executed in this turn.",
                        "Call the correct tool now.",
                        "If execution is truly impossible, reply exactly as: BLOCKED: <reason>",
                    ].join("\n"),
                });
                continue;
            }

            if (executionPlan && executionPlan.steps.length > 0) {
                const statusLines = executionPlan.steps.map((step, i) => {
                    const done = i < completedPlanSteps;
                    return `${done ? "[done]" : "[pending]"} ${i + 1}. ${step}`;
                });
                reply += `\n\nPlan status:\n${statusLines.join("\n")}`;
            }

            const updatedHistory: Message[] = [
                ...history,
                { role: "user", content: userMessage },
                { role: "assistant", content: reply },
            ];

            const contextTokens =
                tokenCounter.count(systemPrompt) +
                tokenCounter.count(JSON.stringify(history)) +
                tokenCounter.count(textContent);
            const replyTokens = tokenCounter.count(reply);
            const threshold = config.compactionTokenThreshold;
            const totalTokens = contextTokens + replyTokens;
            const tokenUsage: TokenUsageEstimate = {
                contextTokens,
                replyTokens,
                totalTokens,
                threshold,
                contextPercent: threshold > 0 ? Number(((contextTokens / threshold) * 100).toFixed(1)) : 0,
                remainingToThreshold: Math.max(0, threshold - contextTokens),
                countMode: tokenCounter.mode,
            };

            // Log this turn to the daily episodic log
            logTurnSummary(getTextContent(userMessage), reply);

            // Fire per-turn episodic extraction (non-blocking)
            extractEpisodicFromTurn(getTextContent(userMessage), reply).catch(() => { });

            return { reply, history: updatedHistory, tokenUsage };
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

interface TokenCounter {
    mode: "exact-ish" | "estimate";
    count: (text: string) => number;
}

const tokenCounterCache = new Map<string, TokenCounter>();

function getTokenCounter(modelId: string): TokenCounter {
    const cacheKey = modelId.trim().toLowerCase();
    const cached = tokenCounterCache.get(cacheKey);
    if (cached) return cached;

    const modelName = modelId.split("/").pop()?.trim() || modelId.trim();
    const tokenizer = createTokenizerCounter(modelName);
    tokenCounterCache.set(cacheKey, tokenizer);
    return tokenizer;
}

function createTokenizerCounter(modelName: string): TokenCounter {
    try {
        let encoding;
        try {
            encoding = encoding_for_model(modelName as never);
        } catch {
            if (/^(gpt-5|gpt-4o|o\d)/i.test(modelName)) {
                encoding = get_encoding("o200k_base");
            } else if (/^(gpt-4|gpt-3\.5|text-embedding)/i.test(modelName)) {
                encoding = get_encoding("cl100k_base");
            } else {
                throw new Error("No tokenizer mapping for model");
            }
        }

        return {
            mode: "exact-ish",
            count: (text: string) => encoding.encode(text).length,
        };
    } catch {
        return {
            mode: "estimate",
            count: estimateTokenCount,
        };
    }
}
