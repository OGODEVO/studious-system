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
    get_current_url: () => `📍 Getting current URL…`,
    run_command: (a) => `⚡ Running: \`${(a.command as string || "").slice(0, 60)}\`…`,
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
