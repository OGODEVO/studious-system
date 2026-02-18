import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Agent Event Bus — decoupled notifications for any UI
// ---------------------------------------------------------------------------

export type ToolEventType = "tool:start" | "tool:end" | "agent:thinking" | "agent:streaming" | "agent:idle";

export interface ToolStartEvent {
    tool: string;
    args: Record<string, unknown>;
    label: string;   // Human-friendly label like "🌐 Browsing google.com…"
}

export interface ToolEndEvent {
    tool: string;
    durationMs: number;
    success: boolean;
    outputPreview?: string;
}

const TOOL_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
    navigate: (a) => `🌐 Browsing ${(a.url as string || "").slice(0, 60)}…`,
    click: (a) => `👆 Clicking \`${a.selector}\`…`,
    type_text: (a) => `⌨️ Typing into \`${a.selector}\`…`,
    extract_text: () => `📄 Extracting page text…`,
    screenshot: () => `📸 Taking screenshot…`,
    get_links: () => `🔗 Getting page links…`,
    search_google: (a) => `🔍 Searching: "${a.query}"…`,
    perplexity_search: (a) => `🔎 Perplexity search: "${(a.query as string || "").slice(0, 80)}"…`,
    get_current_url: () => `📍 Getting current URL…`,
    moltbook_register: (a) => `🦞 Moltbook register: "${(a.name as string || "").slice(0, 40)}"…`,
    moltbook_me: () => `🦞 Fetching Moltbook profile…`,
    moltbook_status: () => `🦞 Checking Moltbook claim status…`,
    moltbook_post: (a) => `🦞 Posting to r/${(a.submolt as string || "general")}…`,
    moltbook_comment: (a) => `🦞 Commenting on post ${(a.post_id as string || "").slice(0, 16)}…`,
    moltbook_upvote: (a) => `🦞 Upvoting post ${(a.post_id as string || "").slice(0, 16)}…`,
    moltbook_feed: (a) => `🦞 Reading Moltbook feed (${(a.sort as string || "hot")})…`,
    run_command: (a) => `⚡ Running: \`${(a.command as string || "").slice(0, 60)}\`…`,
    heartbeat_status: () => `💓 Checking heartbeat status…`,
    heartbeat_set: (a) => `💓 Setting heartbeat to ${(a.interval_minutes as number) || "?"} minute(s)…`,
    heartbeat_disable: () => `💓 Disabling heartbeat…`,
    reminder_once_in: (a) => `⏱️ Scheduling one-time reminder in ${(a.minutes as number) || "?"} minute(s)…`,
    reminder_once_at: (a) => `⏱️ Scheduling one-time reminder at ${(a.run_at_iso as string || "").slice(0, 40)}…`,
    reminder_once_list: () => `📋 Listing one-time reminders…`,
    reminder_once_cancel: (a) => `🗑️ Cancelling one-time reminder ${(a.id as string || "").slice(0, 24)}…`,
    memory_write: (a) => `🧠 Saving memory (${String(a.store || "semantic")})…`,
    goal_write: (a) => `🎯 Updating goal: "${String(a.title || "").slice(0, 60)}"…`,
};

export function getToolLabel(tool: string, args: Record<string, unknown>): string {
    const fn = TOOL_LABELS[tool];
    return fn ? fn(args) : `🔧 Using ${tool}…`;
}

class AgentEventBus extends EventEmitter {
    emitToolStart(tool: string, args: Record<string, unknown>) {
        const label = getToolLabel(tool, args);
        this.emit("tool:start", { tool, args, label } satisfies ToolStartEvent);
    }

    emitToolEnd(tool: string, durationMs: number, success: boolean, outputPreview?: string) {
        this.emit("tool:end", { tool, durationMs, success, outputPreview } satisfies ToolEndEvent);
    }

    emitStatus(status: "thinking" | "streaming" | "idle") {
        this.emit(`agent:${status}`);
    }
}

export const agentBus = new AgentEventBus();
