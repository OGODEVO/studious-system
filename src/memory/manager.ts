import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import type {
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from "openai/resources/chat/completions";
import { config } from "../utils/config.js";
import type { Message } from "../agent.js";
import { ResilientExecutor } from "../runtime/resilience.js";

// ---------------------------------------------------------------------------
// Dedicated memory extraction client (supports any OpenAI v1 endpoint)
// ---------------------------------------------------------------------------

let _memoryClient: OpenAI | null = null;
const memoryCompletionExecutor = new ResilientExecutor({
    retry: {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        jitterRatio: 0.2,
    },
    circuitBreaker: {
        failureThreshold: 4,
        cooldownMs: 60 * 1000,
    },
});

function getMemoryClient(): OpenAI {
    if (!_memoryClient) {
        _memoryClient = new OpenAI({
            apiKey: config.memoryApiKey,
            ...(config.memoryBaseUrl ? { baseURL: config.memoryBaseUrl } : {}),
        });
    }
    return _memoryClient;
}

export function getMemoryHealthMetrics() {
    return memoryCompletionExecutor.getAllMetrics();
}

// ---------------------------------------------------------------------------
// Paths — CoALA-aligned directory structure
// ---------------------------------------------------------------------------

const OASIS_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const MEMORY_DIR = path.join(OASIS_ROOT, "memory");

const SEMANTIC_DIR = path.join(MEMORY_DIR, "semantic");
const SEMANTIC_FILE = path.join(SEMANTIC_DIR, "memory.md");

const EPISODIC_DIR = path.join(MEMORY_DIR, "episodic");

const PROCEDURAL_DIR = path.join(MEMORY_DIR, "procedural");
const RULES_FILE = path.join(PROCEDURAL_DIR, "rules.md");

const SNAPSHOTS_DIR = path.join(MEMORY_DIR, "snapshots");
const SESSION_CONTEXT_FILE = path.join(SEMANTIC_DIR, "session_context.md");

function ensureDirs(): void {
    for (const dir of [SEMANTIC_DIR, EPISODIC_DIR, PROCEDURAL_DIR, SNAPSHOTS_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayDateString(): string {
    return new Date().toISOString().slice(0, 10);
}

function readFileOrEmpty(filepath: string): string {
    try {
        return fs.readFileSync(filepath, "utf-8");
    } catch {
        return "";
    }
}

function getRecentEpisodes(count: number): string {
    try {
        const files = fs.readdirSync(EPISODIC_DIR)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .reverse()
            .slice(0, count);

        return files
            .map((f) => readFileOrEmpty(path.join(EPISODIC_DIR, f)).trim())
            .filter(Boolean)
            .join("\n\n---\n\n");
    } catch {
        return "";
    }
}

// ---------------------------------------------------------------------------
// ① Bootstrap Loading — build context from all memory layers
// ---------------------------------------------------------------------------

export function loadBootstrapContext(): string {
    ensureDirs();
    const parts: string[] = [];

    const semantic = readFileOrEmpty(SEMANTIC_FILE);
    if (semantic.trim()) {
        parts.push("=== SEMANTIC MEMORY (facts & preferences) ===\n" + semantic.trim());
    }

    const procedural = readFileOrEmpty(RULES_FILE);
    if (procedural.trim()) {
        parts.push("=== PROCEDURAL MEMORY (rules & behaviors) ===\n" + procedural.trim());
    }

    const episodes = getRecentEpisodes(config.maxRecentEpisodes);
    if (episodes.trim()) {
        parts.push("=== EPISODIC MEMORY (recent experiences) ===\n" + episodes);
    }

    // Session context (conversation summary from last compaction)
    const sessionCtx = readFileOrEmpty(SESSION_CONTEXT_FILE);
    if (sessionCtx.trim()) {
        parts.push("=== ACTIVE SESSION CONTEXT ===\n" + sessionCtx.trim());
    }

    return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Memory Agent Tools — the LLM uses these to search before writing
// ---------------------------------------------------------------------------

const MEMORY_TOOLS: ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "search_memory",
            description: "Search across ALL memory files (semantic, episodic, procedural) for a keyword or phrase. Returns matching lines with their source file. Use this BEFORE writing to check if something already exists.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "The keyword or phrase to search for across all memory files",
                    },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_memory",
            description: "Read the full contents of a specific memory store. Use to understand what's already stored before deciding where to write.",
            parameters: {
                type: "object",
                properties: {
                    store: {
                        type: "string",
                        enum: ["semantic", "episodic", "procedural"],
                        description: "Which memory store to read",
                    },
                },
                required: ["store"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "write_memory",
            description: "Write a new entry to a memory store. Only call this AFTER searching/reading to confirm the content is genuinely new and valuable. Do NOT write duplicates or near-duplicates.",
            parameters: {
                type: "object",
                properties: {
                    store: {
                        type: "string",
                        enum: ["semantic", "episodic", "procedural"],
                        description: "Which memory store to write to",
                    },
                    section: {
                        type: "string",
                        description: "The ## section to append to (e.g. 'Known Facts', 'User Preferences', 'Learned Behaviors'). For episodic, this is ignored.",
                    },
                    content: {
                        type: "string",
                        description: "The bullet point to write (without the leading '- '). Must be self-contained and concise.",
                    },
                },
                required: ["store", "content"],
            },
        },
    },
];

// Tool implementations
function executeMemoryTool(name: string, args: Record<string, string>): string {
    ensureDirs();

    switch (name) {
        case "search_memory": {
            const query = args.query.toLowerCase();
            const results: string[] = [];

            // Search semantic
            const semantic = readFileOrEmpty(SEMANTIC_FILE);
            const semanticHits = semantic.split("\n")
                .filter((line) => line.toLowerCase().includes(query))
                .map((line) => `[semantic] ${line.trim()}`);
            results.push(...semanticHits);

            // Search procedural
            const procedural = readFileOrEmpty(RULES_FILE);
            const proceduralHits = procedural.split("\n")
                .filter((line) => line.toLowerCase().includes(query))
                .map((line) => `[procedural] ${line.trim()}`);
            results.push(...proceduralHits);

            // Search recent episodic files
            try {
                const files = fs.readdirSync(EPISODIC_DIR)
                    .filter((f) => f.endsWith(".md"))
                    .sort()
                    .reverse()
                    .slice(0, 5);

                for (const f of files) {
                    const content = readFileOrEmpty(path.join(EPISODIC_DIR, f));
                    const hits = content.split("\n")
                        .filter((line) => line.toLowerCase().includes(query))
                        .map((line) => `[episodic/${f}] ${line.trim()}`);
                    results.push(...hits);
                }
            } catch { /* empty dir */ }

            if (results.length === 0) {
                return `No matches found for "${args.query}" in any memory store.`;
            }
            return `Found ${results.length} match(es):\n${results.slice(0, 15).join("\n")}`;
        }

        case "read_memory": {
            switch (args.store) {
                case "semantic":
                    return readFileOrEmpty(SEMANTIC_FILE) || "(empty — no semantic memory yet)";
                case "procedural":
                    return readFileOrEmpty(RULES_FILE) || "(empty — no procedural memory yet)";
                case "episodic":
                    return getRecentEpisodes(3) || "(empty — no episodes yet)";
                default:
                    return `Unknown store: ${args.store}`;
            }
        }

        case "write_memory": {
            const bullet = `- ${args.content.trim()}`;

            switch (args.store) {
                case "semantic": {
                    let memory = readFileOrEmpty(SEMANTIC_FILE);
                    if (!memory.trim()) {
                        memory = "# Oasis Memory\n\n## User Preferences\n\n## Known Facts\n\n## Workflow Notes\n";
                    }
                    if (memory.includes(bullet)) {
                        return `SKIPPED (duplicate): "${args.content}"`;
                    }
                    const section = args.section || "Known Facts";
                    memory = appendToSection(memory, section, bullet);
                    fs.writeFileSync(SEMANTIC_FILE, memory, "utf-8");
                    return `✅ Written to semantic/${section}: "${args.content}"`;
                }

                case "episodic": {
                    logEpisode(`📝 ${args.content.trim()}`);
                    return `✅ Written to episodic log: "${args.content}"`;
                }

                case "procedural": {
                    let rules = readFileOrEmpty(RULES_FILE);
                    if (rules.includes(bullet)) {
                        return `SKIPPED (duplicate): "${args.content}"`;
                    }
                    const section = args.section || "Learned Behaviors";
                    rules = appendToSection(rules, section, bullet);
                    fs.writeFileSync(RULES_FILE, rules, "utf-8");
                    return `✅ Written to procedural/${section}: "${args.content}"`;
                }

                default:
                    return `Unknown store: ${args.store}`;
            }
        }

        default:
            return `Unknown tool: ${name}`;
    }
}

// ---------------------------------------------------------------------------
// ② Memory Agent Loop — tool-using extraction
// ---------------------------------------------------------------------------

const MEMORY_AGENT_PROMPT = `You are a memory manager for an AI agent called Oasis. Your job is to decide what's worth persisting from a conversation.

You have tools to SEARCH, READ, and WRITE memory. Your workflow:

1. First, SEARCH for key topics from the conversation to see what's already stored.
2. READ any relevant memory stores to understand current state.
3. Only WRITE if the information is:
   - WORTH remembering (not trivial, not small talk)
   - GENUINELY NEW (not already stored — you verified by searching)
   - Correctly CATEGORIZED:
     * semantic — stable facts, preferences, project details
     * episodic — "Task: X | Approach: Y | Outcome: Z"
     * procedural — "Rule: <when X, do Y>" or "Pattern: <observation>"

If nothing worth writing is found, just respond with "No new memories."
Be extremely selective — noise degrades memory quality.`;

export async function flushBeforeCompaction(history: Message[]): Promise<void> {
    if (history.length < 4) return;

    const client = getMemoryClient();

    const conversationText = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : ""}`)
        .join("\n");

    const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: MEMORY_AGENT_PROMPT },
        { role: "user", content: `Here is the conversation to process:\n\n${conversationText}` },
    ];

    try {
        // Tool-call loop — memory agent searches, reads, then writes
        for (let i = 0; i < 8; i++) {
            const completion = await memoryCompletionExecutor.execute(
                "memory:flush_compaction",
                () =>
                    client.chat.completions.create({
                        model: config.memoryModel,
                        messages,
                        tools: MEMORY_TOOLS,
                        tool_choice: i < 6 ? "auto" : "none", // force finish after 6 iterations
                        temperature: config.memoryTemperature,
                        max_completion_tokens: config.memoryMaxTokens,
                    })
            );

            const msg = completion.choices[0].message;

            if (msg.tool_calls && msg.tool_calls.length > 0) {
                messages.push({
                    role: "assistant",
                    content: msg.content ?? null,
                    tool_calls: msg.tool_calls,
                } as ChatCompletionMessageParam);

                for (const tc of msg.tool_calls) {
                    const args = JSON.parse(tc.function.arguments);
                    const result = executeMemoryTool(tc.function.name, args);
                    console.log(`   🧠 memory.${tc.function.name}(${JSON.stringify(args)}) → ${result.slice(0, 80)}`);

                    messages.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: result,
                    });
                }
            } else {
                // Done — agent finished its work
                if (msg.content) {
                    console.log(`   💾 Memory agent: ${msg.content.slice(0, 100)}`);
                }
                break;
            }
        }
    } catch (err) {
        console.error("   Memory flush failed: " + (err as Error).message);
    }

    // --- Generate Conversation Summary for carry-over ---
    try {
        const summary = await generateConversationSummary(history);
        if (summary) {
            ensureDirs();
            fs.writeFileSync(SESSION_CONTEXT_FILE, summary, "utf-8");
            console.log("   Session context saved (" + summary.length + " chars)");
        }
    } catch (err) {
        console.error("   Session summary failed: " + (err as Error).message);
    }
}

// ---------------------------------------------------------------------------
// Conversation Summarizer — produces a concise "carry-over" paragraph
// ---------------------------------------------------------------------------

const SUMMARY_PROMPT = `Summarize this conversation in 2-3 concise paragraphs. Focus on:
1. What the user's current goal/task is
2. What has been accomplished so far
3. Any decisions made or preferences expressed
4. What the next steps are

Be specific and factual. This summary will be injected into a future prompt so the agent can continue the conversation seamlessly.`;

async function generateConversationSummary(history: Message[]): Promise<string | null> {
    if (history.length < 4) return null;

    const client = getMemoryClient();

    const conversationText = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => m.role + ": " + (typeof m.content === "string" ? m.content : ""))
        .join("\n");

    try {
        const completion = await memoryCompletionExecutor.execute(
            "memory:summary_generation",
            () =>
                client.chat.completions.create({
                    model: config.memoryModel,
                    messages: [
                        { role: "system", content: SUMMARY_PROMPT },
                        { role: "user", content: conversationText },
                    ],
                    temperature: 0.2,
                    max_completion_tokens: config.memoryMaxTokens,
                })
        );

        return completion.choices[0]?.message?.content || null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Per-turn episodic extraction (tool-using flow)
// ---------------------------------------------------------------------------

const EPISODIC_TURN_PROMPT = `You are a memory manager. Given a single exchange, decide if it's worth storing as an episodic memory.

Your workflow:
1. SEARCH for keywords from the exchange to check if a similar episode exists.
2. If it's new and non-trivial, WRITE it to the episodic store.
3. Format: "Task: <what user wanted> | Approach: <what was done> | Outcome: <result>"

If trivial or duplicate, just respond "No new memories."`;

let turnCounter = 0;

export async function extractEpisodicFromTurn(
    userMessage: string,
    agentReply: string
): Promise<void> {
    turnCounter++;
    if (turnCounter % config.extractEveryNTurns !== 0) return;

    const client = getMemoryClient();
    const exchange = `User: ${userMessage}\nAssistant: ${agentReply}`;

    const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: EPISODIC_TURN_PROMPT },
        { role: "user", content: exchange },
    ];

    try {
        for (let i = 0; i < 4; i++) {
            const completion = await memoryCompletionExecutor.execute(
                "memory:episodic_extraction",
                () =>
                    client.chat.completions.create({
                        model: config.memoryModel,
                        messages,
                        tools: MEMORY_TOOLS,
                        tool_choice: i < 3 ? "auto" : "none",
                        temperature: config.memoryTemperature,
                        max_completion_tokens: config.memoryMaxTokens,
                    })
            );

            const msg = completion.choices[0].message;

            if (msg.tool_calls && msg.tool_calls.length > 0) {
                messages.push({
                    role: "assistant",
                    content: msg.content ?? null,
                    tool_calls: msg.tool_calls,
                } as ChatCompletionMessageParam);

                for (const tc of msg.tool_calls) {
                    const args = JSON.parse(tc.function.arguments);
                    const result = executeMemoryTool(tc.function.name, args);

                    messages.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: result,
                    });
                }
            } else {
                if (msg.content && !msg.content.includes("No new memories")) {
                    console.log(`   📝 ${msg.content.slice(0, 100)}`);
                }
                break;
            }
        }
    } catch {
        // Silent fail — don't interrupt the user experience
    }
}

// ---------------------------------------------------------------------------
// ③ Session Snapshot
// ---------------------------------------------------------------------------

export function saveSessionSnapshot(history: Message[]): string | null {
    if (history.length === 0) return null;

    ensureDirs();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filepath = path.join(SNAPSHOTS_DIR, `session_${timestamp}.md`);

    const content = history
        .map((m) => {
            const role = m.role.toUpperCase();
            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return `### ${role}\n${text}`;
        })
        .join("\n\n");

    const header = `# Session Snapshot\n- saved_at: ${new Date().toISOString()}\n- messages: ${history.length}\n\n`;

    fs.writeFileSync(filepath, header + content, "utf-8");
    return filepath;
}

// ---------------------------------------------------------------------------
// ④ User-Initiated Memory
// ---------------------------------------------------------------------------

export function rememberThis(text: string): string {
    ensureDirs();
    const bullet = `- ${text.trim()}`;
    const memory = readFileOrEmpty(SEMANTIC_FILE);

    if (memory.includes(bullet)) {
        return `Already remembered: ${text.trim()}`;
    }

    const updated = appendToSection(memory, "Known Facts", bullet);
    fs.writeFileSync(SEMANTIC_FILE, updated, "utf-8");

    logEpisode(`User explicitly stored: "${text.trim()}"`);

    return `✅ Remembered: ${text.trim()}`;
}

// ---------------------------------------------------------------------------
// Episodic log helper
// ---------------------------------------------------------------------------

function logEpisode(summary: string): void {
    ensureDirs();
    const date = todayDateString();
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    const logPath = path.join(EPISODIC_DIR, `${date}.md`);

    const header = fs.existsSync(logPath) ? "" : `# Episodes — ${date}\n\n`;
    fs.appendFileSync(logPath, `${header}**${time}** ${summary}\n\n`, "utf-8");
}

export function logTurnSummary(userMessage: string, agentReply: string): void {
    const userSnippet = userMessage.slice(0, 100) + (userMessage.length > 100 ? "..." : "");
    const agentSnippet = agentReply.slice(0, 150) + (agentReply.length > 150 ? "..." : "");
    logEpisode(`User: ${userSnippet}\n> Agent: ${agentSnippet}`);
}

// ---------------------------------------------------------------------------
// Markdown section manipulation
// ---------------------------------------------------------------------------

function appendToSection(markdown: string, sectionName: string, bullet: string): string {
    const sectionHeader = `## ${sectionName}`;
    const headerIndex = markdown.indexOf(sectionHeader);

    if (headerIndex === -1) {
        return markdown.trimEnd() + `\n\n${sectionHeader}\n${bullet}\n`;
    }

    const afterHeader = headerIndex + sectionHeader.length;
    const nextSection = markdown.indexOf("\n## ", afterHeader);
    const insertAt = nextSection === -1 ? markdown.length : nextSection;

    const before = markdown.slice(0, insertAt).trimEnd();
    const after = markdown.slice(insertAt);

    return before + "\n" + bullet + "\n" + after;
}
