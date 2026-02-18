import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "../utils/config.js";
import type { Message } from "../agent.js";
import { ResilientExecutor } from "../runtime/resilience.js";

type GoalStatus = "active" | "completed" | "paused" | "cancelled";
type GoalProgressSource = "user" | "assistant" | "system";

interface GoalProgressEntry {
    at: string;
    source: GoalProgressSource;
    note: string;
}

interface GoalRecord {
    id: string;
    title: string;
    status: GoalStatus;
    createdAt: string;
    updatedAt: string;
    tags: string[];
    progress: GoalProgressEntry[];
}

export interface GoalSnapshot {
    id: string;
    title: string;
    status: GoalStatus;
    updatedAt: string;
    latestProgress: string;
}

interface GoalsState {
    version: number;
    goals: GoalRecord[];
}

interface MemoryHealthMetrics {
    semanticWrites: number;
    proceduralWrites: number;
    episodicWrites: number;
    goalCreates: number;
    goalUpdates: number;
    duplicateSkips: number;
    errors: number;
    lastWriteAt: string | null;
}

const memoryHealth: MemoryHealthMetrics = {
    semanticWrites: 0,
    proceduralWrites: 0,
    episodicWrites: 0,
    goalCreates: 0,
    goalUpdates: 0,
    duplicateSkips: 0,
    errors: 0,
    lastWriteAt: null,
};

const OASIS_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const MEMORY_DIR = path.join(OASIS_ROOT, "memory");

const SEMANTIC_DIR = path.join(MEMORY_DIR, "semantic");
const SEMANTIC_FILE = path.join(SEMANTIC_DIR, "memory.md");
const SESSION_CONTEXT_FILE = path.join(SEMANTIC_DIR, "session_context.md");

const EPISODIC_DIR = path.join(MEMORY_DIR, "episodic");

const PROCEDURAL_DIR = path.join(MEMORY_DIR, "procedural");
const RULES_FILE = path.join(PROCEDURAL_DIR, "rules.md");

const GOALS_DIR = path.join(MEMORY_DIR, "goals");
const GOALS_FILE = path.join(GOALS_DIR, "goals.md");

const SNAPSHOTS_DIR = path.join(MEMORY_DIR, "snapshots");

const DEFAULT_SEMANTIC_DOC = `# Oasis Memory

## User Preferences

## Known Facts

## Workflow Notes
`;

const DEFAULT_PROCEDURAL_DOC = `# Procedural Memory

Rules and learned behaviors that guide how Oasis operates.

## Operating Rules

## Learned Behaviors
`;

const DEFAULT_GOALS_DOC = `# Goals Memory

Persistent mission tracking for Oasis.

## Goals
`;

const GOAL_PROGRESS_LIMIT = 24;

const SESSION_SUMMARY_PROMPT = `You are summarizing an AI-agent/user conversation for persistent memory.

Output concise markdown with these sections:
## Current Goal
- Main objective the user is pursuing now

## Important Facts About User
- Stable preferences, constraints, location/timezone, workflow style

## Progress and Next Steps
- What was completed
- What remains

Be factual, specific, and avoid fluff.`;

let _memoryClient: OpenAI | null = null;
const memorySummaryExecutor = new ResilientExecutor({
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

function nowIso(): string {
    return new Date().toISOString();
}

function getMemoryClient(): OpenAI {
    if (!_memoryClient) {
        _memoryClient = new OpenAI({
            apiKey: config.memoryApiKey,
            ...(config.memoryBaseUrl ? { baseURL: config.memoryBaseUrl } : {}),
        });
    }
    return _memoryClient;
}

function todayDateString(): string {
    return new Date().toISOString().slice(0, 10);
}

function bumpWriteMetric(kind: "semantic" | "procedural" | "episodic"): void {
    if (kind === "semantic") memoryHealth.semanticWrites += 1;
    if (kind === "procedural") memoryHealth.proceduralWrites += 1;
    if (kind === "episodic") memoryHealth.episodicWrites += 1;
    memoryHealth.lastWriteAt = nowIso();
}

function ensureDirs(): void {
    for (const dir of [SEMANTIC_DIR, EPISODIC_DIR, PROCEDURAL_DIR, GOALS_DIR, SNAPSHOTS_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(SEMANTIC_FILE)) {
        fs.writeFileSync(SEMANTIC_FILE, DEFAULT_SEMANTIC_DOC, "utf-8");
    }
    if (!fs.existsSync(RULES_FILE)) {
        fs.writeFileSync(RULES_FILE, DEFAULT_PROCEDURAL_DOC, "utf-8");
    }
    if (!fs.existsSync(GOALS_FILE)) {
        writeAtomicFile(GOALS_FILE, DEFAULT_GOALS_DOC);
    }
}

function readFileOrEmpty(filepath: string): string {
    try {
        return fs.readFileSync(filepath, "utf-8");
    } catch {
        return "";
    }
}

function writeAtomicFile(filepath: string, content: string): void {
    const tmp = filepath + ".tmp";
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, filepath);
}

function serializeGoalStateMarkdown(state: GoalsState): string {
    const lines: string[] = [];
    lines.push("# Goals Memory");
    lines.push("");
    lines.push("Persistent mission tracking for Oasis.");
    lines.push("");
    lines.push("## Goals");
    lines.push("");

    const goals = [...state.goals].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const goal of goals) {
        lines.push(`## Goal: ${goal.title}`);
        lines.push(`- id: ${goal.id}`);
        lines.push(`- status: ${goal.status}`);
        lines.push(`- created_at: ${goal.createdAt}`);
        lines.push(`- updated_at: ${goal.updatedAt}`);
        lines.push(`- tags: ${goal.tags.join(", ")}`);
        lines.push("### Progress");

        if (goal.progress.length === 0) {
            lines.push("- [n/a] (system) no progress logged");
        } else {
            for (const item of goal.progress) {
                const safeNote = normalizeSpace(item.note).replace(/\|/g, "/");
                lines.push(`- [${item.at}] (${item.source}) ${safeNote}`);
            }
        }
        lines.push("");
    }

    return lines.join("\n").trimEnd() + "\n";
}

function parseGoalStateMarkdown(raw: string): GoalsState {
    const lines = raw.split(/\r?\n/);
    const goals: GoalRecord[] = [];

    let current: GoalRecord | null = null;

    const flushCurrent = () => {
        if (!current) return;
        current.progress = current.progress
            .filter((p) => p.note.trim().length > 0)
            .slice(-GOAL_PROGRESS_LIMIT);
        goals.push(current);
        current = null;
    };

    for (const line of lines) {
        const goalHeader = line.match(/^## Goal:\s+(.+)$/);
        if (goalHeader) {
            flushCurrent();
            const title = normalizeSpace(goalHeader[1] || "");
            const ts = nowIso();
            current = {
                id: `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                title,
                status: "active",
                createdAt: ts,
                updatedAt: ts,
                tags: [],
                progress: [],
            };
            continue;
        }

        if (!current) continue;

        const idMatch = line.match(/^- id:\s+(.+)$/);
        if (idMatch) {
            current.id = normalizeSpace(idMatch[1] || current.id);
            continue;
        }

        const statusMatch = line.match(/^- status:\s+(.+)$/);
        if (statusMatch) {
            const status = normalizeSpace(statusMatch[1] || "").toLowerCase();
            if (status === "active" || status === "completed" || status === "paused" || status === "cancelled") {
                current.status = status;
            }
            continue;
        }

        const createdMatch = line.match(/^- created_at:\s+(.+)$/);
        if (createdMatch) {
            current.createdAt = normalizeSpace(createdMatch[1] || current.createdAt);
            continue;
        }

        const updatedMatch = line.match(/^- updated_at:\s+(.+)$/);
        if (updatedMatch) {
            current.updatedAt = normalizeSpace(updatedMatch[1] || current.updatedAt);
            continue;
        }

        const tagsMatch = line.match(/^- tags:\s*(.*)$/);
        if (tagsMatch) {
            const rawTags = normalizeSpace(tagsMatch[1] || "");
            current.tags = rawTags
                ? rawTags.split(",").map((t) => normalizeSpace(t)).filter(Boolean)
                : [];
            continue;
        }

        const progressMatch = line.match(/^- \[(.+)\]\s+\((user|assistant|system)\)\s+(.+)$/);
        if (progressMatch) {
            const at = normalizeSpace(progressMatch[1] || nowIso());
            const source = progressMatch[2] as GoalProgressSource;
            const note = normalizeSpace(progressMatch[3] || "");
            if (note && at !== "n/a") {
                current.progress.push({ at, source, note });
            }
        }
    }

    flushCurrent();
    return { version: 2, goals };
}

function readGoalsState(): GoalsState {
    ensureDirs();
    try {
        const raw = fs.readFileSync(GOALS_FILE, "utf-8");
        return parseGoalStateMarkdown(raw);
    } catch {
        memoryHealth.errors += 1;
        return { version: 2, goals: [] };
    }
}

function writeGoalsState(state: GoalsState): void {
    ensureDirs();
    writeAtomicFile(GOALS_FILE, serializeGoalStateMarkdown(state));
    memoryHealth.lastWriteAt = nowIso();
}

function normalizeSpace(input: string): string {
    return input.replace(/\s+/g, " ").trim();
}

function normalizeForCompare(input: string): string {
    return normalizeSpace(input)
        .toLowerCase()
        .replace(/[`*_~]/g, "")
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function toTokenSet(input: string): Set<string> {
    const words = normalizeForCompare(input)
        .split(" ")
        .filter((w) => w.length >= 3);
    return new Set(words);
}

function overlapScore(a: string, b: string): number {
    const aSet = toTokenSet(a);
    const bSet = toTokenSet(b);
    if (aSet.size === 0 || bSet.size === 0) return 0;

    let overlap = 0;
    for (const token of aSet) {
        if (bSet.has(token)) overlap += 1;
    }
    const union = new Set([...aSet, ...bSet]).size;
    return union === 0 ? 0 : overlap / union;
}

function cleanLineForGoal(raw: string): string {
    return normalizeSpace(
        raw
            .replace(/^[-*]\s+/, "")
            .replace(/^\d+[.)]\s+/, "")
            .replace(/\*+/g, "")
            .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    ).replace(/[.?!,:;]+$/, "");
}

function isLikelyGoalText(text: string): boolean {
    if (text.length < 8) return false;
    const lower = text.toLowerCase();
    const trigger =
        /\b(need to|have to|goal|mission|priority|priorities|build|implement|fix|set up|setup|create|track|remember|automate)\b/.test(lower) ||
        lower.startsWith("let's ") ||
        lower.startsWith("i want ") ||
        lower.startsWith("we need ");
    return trigger;
}

function extractGoalCandidatesFromUserMessage(message: string): string[] {
    const text = message.trim();
    if (!text) return [];

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const result = new Set<string>();

    const hasPrioritySignal = /top priorities?|priorities|missions?|goals?/i.test(text);
    if (hasPrioritySignal) {
        for (const line of lines) {
            if (/^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
                const candidate = cleanLineForGoal(line);
                if (candidate.length >= 8) result.add(candidate);
            }
        }
    }

    const sentenceCandidates = normalizeSpace(text).split(/[.!?]/).map((s) => s.trim()).filter(Boolean);
    const regexes = [
        /\bwe need to\s+(.+)/i,
        /\bi want (?:you|us|the agent)?\s*to\s+(.+)/i,
        /\blet'?s\s+(.+)/i,
        /\bgoal\s*:\s*(.+)/i,
        /\bmission\s*:\s*(.+)/i,
        /\bpriority\s*:\s*(.+)/i,
    ];

    for (const sentence of sentenceCandidates) {
        for (const rx of regexes) {
            const m = sentence.match(rx);
            if (!m) continue;
            const candidate = cleanLineForGoal(m[1] || "");
            if (candidate.length >= 8) result.add(candidate);
        }
    }

    if (result.size === 0) {
        const fallback = cleanLineForGoal(text);
        if (isLikelyGoalText(fallback)) {
            result.add(fallback);
        }
    }

    return Array.from(result).slice(0, 6);
}

function isSameGoal(existingTitle: string, candidate: string): boolean {
    const a = normalizeForCompare(existingTitle);
    const b = normalizeForCompare(candidate);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true;
    return overlapScore(a, b) >= 0.72;
}

function compactProgress(goal: GoalRecord): void {
    if (goal.progress.length <= GOAL_PROGRESS_LIMIT) return;
    goal.progress = goal.progress.slice(-GOAL_PROGRESS_LIMIT);
}

function updateGoalStatusFromSignals(goal: GoalRecord, text: string): void {
    const lower = text.toLowerCase();
    if (/(done|completed|shipped|resolved|finished|fixed)\b/.test(lower)) {
        goal.status = "completed";
    } else if (/(pause|paused|hold this)\b/.test(lower)) {
        goal.status = "paused";
    } else if (/(cancel|drop|stop this)\b/.test(lower)) {
        goal.status = "cancelled";
    }
}

function upsertGoalsFromUserMessage(text: string): void {
    const candidates = extractGoalCandidatesFromUserMessage(text);
    if (candidates.length === 0) return;

    const state = readGoalsState();
    let changed = false;
    const timestamp = nowIso();

    for (const candidate of candidates) {
        const existing = state.goals.find((g) => isSameGoal(g.title, candidate));
        if (existing) {
            existing.updatedAt = timestamp;
            if (existing.status !== "active") existing.status = "active";
            const note = `Goal reaffirmed: ${candidate}`;
            const normalizedNote = normalizeForCompare(note);
            const duplicate = existing.progress.some((p) => normalizeForCompare(p.note) === normalizedNote);
            if (!duplicate) {
                existing.progress.push({ at: timestamp, source: "user", note });
                compactProgress(existing);
            } else {
                memoryHealth.duplicateSkips += 1;
            }
            memoryHealth.goalUpdates += 1;
            changed = true;
            continue;
        }

        const id = `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const newGoal: GoalRecord = {
            id,
            title: candidate,
            status: "active",
            createdAt: timestamp,
            updatedAt: timestamp,
            tags: [],
            progress: [{ at: timestamp, source: "user", note: `Created goal: ${candidate}` }],
        };
        state.goals.unshift(newGoal);
        memoryHealth.goalCreates += 1;
        changed = true;
    }

    if (changed) {
        state.goals = state.goals
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 80);
        writeGoalsState(state);
    }
}

function appendGoalProgressFromTurn(userMessage: string, assistantReply: string): void {
    const state = readGoalsState();
    const activeGoals = state.goals.filter((g) => g.status === "active");
    if (activeGoals.length === 0) return;

    const combined = `${userMessage}\n${assistantReply}`;
    const assistantSnippet = clip(firstSentence(assistantReply), 180);
    if (!assistantSnippet) return;

    let changed = false;
    const timestamp = nowIso();

    for (const goal of activeGoals) {
        const score = overlapScore(goal.title, combined);
        if (score < 0.12) continue;

        const note = `Progress: ${assistantSnippet}`;
        const normalizedNote = normalizeForCompare(note);
        const duplicate = goal.progress.some((p) => normalizeForCompare(p.note) === normalizedNote);
        if (duplicate) {
            memoryHealth.duplicateSkips += 1;
            continue;
        }

        goal.progress.push({ at: timestamp, source: "assistant", note });
        compactProgress(goal);
        goal.updatedAt = timestamp;
        updateGoalStatusFromSignals(goal, combined);
        memoryHealth.goalUpdates += 1;
        changed = true;
    }

    if (changed) {
        writeGoalsState(state);
    }
}

function getRecentEpisodes(count: number): string {
    try {
        const files = fs
            .readdirSync(EPISODIC_DIR)
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

function formatGoalsForPrompt(): string {
    const state = readGoalsState();
    if (!state.goals.length) return "";

    const active = state.goals.filter((g) => g.status === "active").slice(0, 8);
    const recentCompleted = state.goals
        .filter((g) => g.status === "completed")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 3);

    const lines: string[] = [];
    if (active.length > 0) {
        lines.push("Active goals:");
        for (const goal of active) {
            const latest = goal.progress.at(-1)?.note ?? "No progress yet";
            lines.push(`- ${goal.title} (updated ${goal.updatedAt})`);
            lines.push(`  latest: ${clip(latest, 160)}`);
        }
    }

    if (recentCompleted.length > 0) {
        lines.push("Recently completed goals:");
        for (const goal of recentCompleted) {
            lines.push(`- ${goal.title} (completed ${goal.updatedAt})`);
        }
    }

    return lines.join("\n");
}

function collectBullets(markdown: string): Set<string> {
    const bullets = markdown
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => normalizeForCompare(line.replace(/^- /, "")));
    return new Set(bullets);
}

function appendToSection(markdown: string, sectionName: string, bullet: string): string {
    const base = markdown.trim() ? markdown : DEFAULT_SEMANTIC_DOC;
    const sectionHeader = `## ${sectionName}`;
    const headerIndex = base.indexOf(sectionHeader);

    if (headerIndex === -1) {
        return base.trimEnd() + `\n\n${sectionHeader}\n${bullet}\n`;
    }

    const afterHeader = headerIndex + sectionHeader.length;
    const nextSection = base.indexOf("\n## ", afterHeader);
    const insertAt = nextSection === -1 ? base.length : nextSection;

    const before = base.slice(0, insertAt).trimEnd();
    const after = base.slice(insertAt);
    return before + "\n" + bullet + "\n" + after;
}

function appendUniqueBullet(filePath: string, section: string, rawContent: string, kind: "semantic" | "procedural"): boolean {
    const cleaned = normalizeSpace(rawContent);
    if (!cleaned) return false;

    const bullet = `- ${cleaned}`;
    const current = readFileOrEmpty(filePath);
    const existingBullets = collectBullets(current);

    if (existingBullets.has(normalizeForCompare(cleaned))) {
        memoryHealth.duplicateSkips += 1;
        return false;
    }

    const fallbackTemplate = kind === "semantic" ? DEFAULT_SEMANTIC_DOC : DEFAULT_PROCEDURAL_DOC;
    const updated = appendToSection(current || fallbackTemplate, section, bullet);
    writeAtomicFile(filePath, updated);
    bumpWriteMetric(kind);
    return true;
}

function extractUserPreferences(userMessage: string): string[] {
    const prefs: string[] = [];
    const text = normalizeSpace(userMessage);

    const patterns: Array<[RegExp, string]> = [
        [/\bi (?:really )?(?:like|love|prefer)\s+(.+)/i, "Prefers $1"],
        [/\bi (?:do not|don't|hate|dislike)\s+(.+)/i, "Dislikes $1"],
        [/\bi am in\s+([^.,\n]+)/i, "Location: $1"],
        [/\bmy (?:timezone|time zone) is\s+([^.,\n]+)/i, "Timezone: $1"],
    ];

    for (const [rx, template] of patterns) {
        const m = text.match(rx);
        if (!m || !m[1]) continue;
        prefs.push(template.replace("$1", cleanLineForGoal(m[1])));
    }
    return prefs;
}

function extractWorkflowRules(userMessage: string): string[] {
    const rules: string[] = [];
    const text = normalizeSpace(userMessage);

    const rulePhrases = text
        .split(/[.!?]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => /\b(always|never|should|must|don't|do not)\b/i.test(s));

    for (const phrase of rulePhrases) {
        const cleaned = cleanLineForGoal(phrase);
        if (cleaned.length >= 10) rules.push(cleaned);
    }

    return rules.slice(0, 4);
}

function clip(text: string, max: number): string {
    if (!text) return "";
    return text.length <= max ? text : text.slice(0, max - 3) + "...";
}

function firstSentence(text: string): string {
    const cleaned = normalizeSpace(text);
    if (!cleaned) return "";
    const sentence = cleaned.split(/[.!?]/).map((s) => s.trim()).find(Boolean);
    return sentence || cleaned;
}

function buildEpisodeSummary(userMessage: string, assistantReply: string): string {
    const task = clip(cleanLineForGoal(firstSentence(userMessage)), 120);
    const outcome = clip(cleanLineForGoal(firstSentence(assistantReply)), 150);
    const approach = /tool|called|perplexity|wallet|search|browser|update|build|commit/i.test(assistantReply)
        ? "Executed available tools/workflow"
        : "Analyzed request and responded";
    return `Task: ${task} | Approach: ${approach} | Outcome: ${outcome}`;
}

function episodeAlreadyExists(logPath: string, summary: string): boolean {
    const current = readFileOrEmpty(logPath);
    if (!current) return false;
    const normalizedSummary = normalizeForCompare(summary);
    return current
        .split("\n")
        .map((line) => normalizeForCompare(line))
        .some((line) => line.includes(normalizedSummary));
}

function writeEpisode(summary: string): void {
    ensureDirs();
    const date = todayDateString();
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    const logPath = path.join(EPISODIC_DIR, `${date}.md`);
    const header = fs.existsSync(logPath) ? "" : `# Episodes - ${date}\n\n`;
    fs.appendFileSync(logPath, `${header}**${time}** ${summary}\n\n`, "utf-8");
    bumpWriteMetric("episodic");
}

function extractFromTurn(userMessage: string, assistantReply: string): void {
    ensureDirs();
    upsertGoalsFromUserMessage(userMessage);
    appendGoalProgressFromTurn(userMessage, assistantReply);

    for (const pref of extractUserPreferences(userMessage)) {
        appendUniqueBullet(SEMANTIC_FILE, "User Preferences", pref, "semantic");
    }

    for (const rule of extractWorkflowRules(userMessage)) {
        appendUniqueBullet(RULES_FILE, "Learned Behaviors", rule, "procedural");
    }
}

function generateDeterministicSessionSummary(history: Message[]): string {
    const turns = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-20)
        .map((m) => ({
            role: m.role,
            text: typeof m.content === "string" ? normalizeSpace(m.content) : "",
        }))
        .filter((m) => m.text.length > 0);

    const latestUser = turns
        .filter((t) => t.role === "user")
        .map((t) => t.text)
        .at(-1) || "No recent user request.";
    const latestAssistant = turns
        .filter((t) => t.role === "assistant")
        .map((t) => t.text)
        .at(-1) || "No recent assistant response.";

    const goalsState = readGoalsState();
    const activeGoals = goalsState.goals
        .filter((g) => g.status === "active")
        .slice(0, 5)
        .map((g) => `- ${g.title}`);

    const completedGoals = goalsState.goals
        .filter((g) => g.status === "completed")
        .slice(0, 3)
        .map((g) => `- ${g.title}`);

    const lines: string[] = [];
    lines.push("Current request focus:");
    lines.push(`- ${clip(latestUser, 240)}`);
    lines.push("");
    lines.push("Latest assistant state:");
    lines.push(`- ${clip(latestAssistant, 240)}`);
    lines.push("");
    lines.push("Active goals:");
    lines.push(activeGoals.length > 0 ? activeGoals.join("\n") : "- none");
    lines.push("");
    lines.push("Recently completed goals:");
    lines.push(completedGoals.length > 0 ? completedGoals.join("\n") : "- none");

    return lines.join("\n");
}

async function generateSessionSummaryWithLlm(history: Message[]): Promise<string | null> {
    const turns = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-80)
        .map((m) => {
            const content = typeof m.content === "string" ? normalizeSpace(m.content) : "";
            return `${m.role}: ${content}`;
        })
        .filter((line) => line.length > 0);

    if (turns.length < 2) return null;

    const transcript = turns.join("\n");
    const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: SESSION_SUMMARY_PROMPT },
        { role: "user", content: transcript },
    ];

    try {
        const completion = await memorySummaryExecutor.execute(
            "memory:session_summary",
            () =>
                getMemoryClient().chat.completions.create({
                    model: config.memoryModel,
                    messages,
                    temperature: config.memoryTemperature,
                    max_tokens: config.memoryMaxTokens,
                })
        );
        const summary = completion.choices[0]?.message?.content;
        if (!summary || !summary.trim()) return null;
        return summary.trim();
    } catch {
        return null;
    }
}

export function getMemoryHealthMetrics() {
    const state = readGoalsState();
    return {
        ...memoryHealth,
        activeGoals: state.goals.filter((g) => g.status === "active").length,
        completedGoals: state.goals.filter((g) => g.status === "completed").length,
        totalGoals: state.goals.length,
    };
}

export function getGoalSnapshots(limit = 10): GoalSnapshot[] {
    const state = readGoalsState();
    return state.goals
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, Math.max(1, limit))
        .map((goal) => ({
            id: goal.id,
            title: goal.title,
            status: goal.status,
            updatedAt: goal.updatedAt,
            latestProgress: goal.progress.at(-1)?.note ?? "No progress yet",
        }));
}

function isValidGoalStatus(value: string): value is GoalStatus {
    return value === "active" || value === "completed" || value === "paused" || value === "cancelled";
}

function sanitizeTags(tags?: string[]): string[] {
    if (!Array.isArray(tags)) return [];
    const out = new Set<string>();
    for (const raw of tags) {
        const tag = normalizeSpace(String(raw || "")).toLowerCase();
        if (!tag) continue;
        out.add(tag);
        if (out.size >= 12) break;
    }
    return Array.from(out);
}

export function writeMemoryEntry(input: {
    store: "semantic" | "procedural";
    content: string;
    section?: string;
}): string {
    ensureDirs();
    const store = input.store;
    const content = normalizeSpace(input.content || "");
    if (!content) return "Error: content is required.";

    if (store === "semantic") {
        const section = normalizeSpace(input.section || "Known Facts");
        const wrote = appendUniqueBullet(SEMANTIC_FILE, section, content, "semantic");
        return wrote
            ? `Saved to semantic memory (${section}).`
            : "Skipped duplicate semantic memory entry.";
    }

    const section = normalizeSpace(input.section || "Learned Behaviors");
    const wrote = appendUniqueBullet(RULES_FILE, section, content, "procedural");
    return wrote
        ? `Saved to procedural memory (${section}).`
        : "Skipped duplicate procedural memory entry.";
}

export function writeGoalEntry(input: {
    title: string;
    progress?: string;
    status?: GoalStatus;
    tags?: string[];
}): string {
    ensureDirs();
    const title = normalizeSpace(input.title || "");
    if (!title) return "Error: title is required.";

    const state = readGoalsState();
    const timestamp = nowIso();
    const progress = normalizeSpace(input.progress || "");
    const tags = sanitizeTags(input.tags);
    const incomingStatus = normalizeSpace(input.status || "").toLowerCase();
    const requestedStatus = incomingStatus && isValidGoalStatus(incomingStatus)
        ? incomingStatus
        : undefined;

    let goal = state.goals.find((g) => isSameGoal(g.title, title));
    if (!goal) {
        goal = {
            id: `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            title,
            status: requestedStatus ?? "active",
            createdAt: timestamp,
            updatedAt: timestamp,
            tags,
            progress: [],
        };
        state.goals.unshift(goal);
        memoryHealth.goalCreates += 1;
    } else {
        goal.updatedAt = timestamp;
        if (requestedStatus) goal.status = requestedStatus;
        if (tags.length > 0) {
            const merged = new Set([...(goal.tags || []), ...tags]);
            goal.tags = Array.from(merged).slice(0, 12);
        }
        memoryHealth.goalUpdates += 1;
    }

    if (progress) {
        const duplicate = goal.progress.some((p) => normalizeForCompare(p.note) === normalizeForCompare(progress));
        if (!duplicate) {
            goal.progress.push({ at: timestamp, source: "system", note: progress });
            compactProgress(goal);
        } else {
            memoryHealth.duplicateSkips += 1;
        }
    }

    goal.updatedAt = timestamp;
    state.goals = state.goals
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 120);
    writeGoalsState(state);

    return `Goal saved: [${goal.status}] ${goal.title}`;
}

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

    const goalsContext = formatGoalsForPrompt();
    if (goalsContext.trim()) {
        parts.push("=== PERSISTENT GOALS (mission tracking) ===\n" + goalsContext);
    }

    const episodes = getRecentEpisodes(config.maxRecentEpisodes);
    if (episodes.trim()) {
        parts.push("=== EPISODIC MEMORY (recent experiences) ===\n" + episodes);
    }

    const sessionCtx = readFileOrEmpty(SESSION_CONTEXT_FILE);
    if (sessionCtx.trim()) {
        parts.push("=== ACTIVE SESSION CONTEXT ===\n" + sessionCtx.trim());
    }

    return parts.join("\n\n");
}

export async function flushBeforeCompaction(history: Message[]): Promise<void> {
    if (history.length < 2) return;

    try {
        const turns = history
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-40);

        for (let i = 0; i < turns.length; i++) {
            const current = turns[i];
            if (current.role !== "user") continue;
            const userText = typeof current.content === "string" ? current.content : "";
            let assistantText = "";
            for (let j = i + 1; j < turns.length; j++) {
                if (turns[j].role === "assistant") {
                    const assistantContent = turns[j].content;
                    assistantText = typeof assistantContent === "string" ? assistantContent : "";
                    break;
                }
            }
            extractFromTurn(userText, assistantText);
        }

        const summary =
            (await generateSessionSummaryWithLlm(history)) ||
            generateDeterministicSessionSummary(history);
        writeAtomicFile(SESSION_CONTEXT_FILE, summary);
        memoryHealth.lastWriteAt = nowIso();
    } catch (err) {
        memoryHealth.errors += 1;
        console.error("Memory flush failed: " + (err as Error).message);
    }
}

let turnCounter = 0;

export async function extractEpisodicFromTurn(
    userMessage: string,
    agentReply: string
): Promise<void> {
    try {
        extractFromTurn(userMessage, agentReply);
    } catch {
        memoryHealth.errors += 1;
    }

    turnCounter += 1;
    if (turnCounter % config.extractEveryNTurns !== 0) return;

    try {
        const summary = buildEpisodeSummary(userMessage, agentReply);
        const logPath = path.join(EPISODIC_DIR, `${todayDateString()}.md`);
        if (!episodeAlreadyExists(logPath, summary)) {
            writeEpisode(summary);
        } else {
            memoryHealth.duplicateSkips += 1;
        }
    } catch {
        memoryHealth.errors += 1;
    }
}

export function saveSessionSnapshot(history: Message[]): string | null {
    if (history.length === 0) return null;

    ensureDirs();
    const timestamp = nowIso().replace(/[:.]/g, "-");
    const filepath = path.join(SNAPSHOTS_DIR, `session_${timestamp}.md`);

    const content = history
        .map((m) => {
            const role = m.role.toUpperCase();
            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return `### ${role}\n${text}`;
        })
        .join("\n\n");

    const header = `# Session Snapshot\n- saved_at: ${nowIso()}\n- messages: ${history.length}\n\n`;
    writeAtomicFile(filepath, header + content);
    return filepath;
}

export function rememberThis(text: string): string {
    ensureDirs();
    const clean = normalizeSpace(text);
    if (!clean) return "Nothing to remember.";

    const wrote = appendUniqueBullet(SEMANTIC_FILE, "Known Facts", clean, "semantic");
    upsertGoalsFromUserMessage(clean);
    writeEpisode(`User explicitly stored: "${clip(clean, 160)}"`);

    if (!wrote) {
        return `Already remembered: ${clean}`;
    }
    return `Remembered: ${clean}`;
}

export function logTurnSummary(userMessage: string, agentReply: string): void {
    try {
        const userSnippet = clip(userMessage, 120);
        const agentSnippet = clip(agentReply, 180);
        writeEpisode(`User: ${userSnippet}\n> Agent: ${agentSnippet}`);
    } catch {
        memoryHealth.errors += 1;
    }
}
