import "dotenv/config";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { submitTask, getQueueStatus } from "../runtime/taskQueue.js";
import { closeBrowser } from "../tools/browser.js";
import {
    startScheduler,
    stopScheduler,
    setHeartbeat,
    disableHeartbeat,
    getHeartbeatStatus,
    getSchedulerHealthMetrics,
} from "../runtime/scheduler.js";
import { getAgentHealthMetrics, type Message } from "../agent.js";
import { getMemoryHealthMetrics } from "../memory/manager.js";
import { gradeResilience } from "../runtime/resilienceGrade.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const WEB_DIR = path.join(ROOT, "web");
const PORT = Number(process.env.PORT || 3000);

type UiRole = "user" | "assistant" | "system";

const history: Array<{ role: UiRole; content: string }> = [];
let agentStatus: "idle" | "thinking" | "streaming" = "idle";

function addMessage(role: UiRole, content: string) {
    history.push({ role, content });
}

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error("Payload too large"));
            }
        });
        req.on("end", () => {
            if (!body.trim()) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Invalid JSON"));
            }
        });
        req.on("error", reject);
    });
}

function sendJson(res: http.ServerResponse, code: number, payload: unknown) {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
}

function sendFile(res: http.ServerResponse, filename: string, contentType: string) {
    const filepath = path.join(WEB_DIR, filename);
    if (!fs.existsSync(filepath)) {
        res.statusCode = 404;
        res.end("Not found");
        return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.end(fs.readFileSync(filepath));
}

function parseIntervalMinutes(token: string): number | null {
    const raw = token.trim().toLowerCase();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number(raw);
    const minuteMatch = raw.match(/^(\d+)(m|min|mins|minute|minutes)$/);
    if (minuteMatch) return Number(minuteMatch[1]);
    const hourMatch = raw.match(/^(\d+)(h|hr|hrs|hour|hours)$/);
    if (hourMatch) return Number(hourMatch[1]) * 60;
    return null;
}

function handleHeartbeatCommand(input: string): string | null {
    const trimmed = input.trim();
    const match = trimmed.match(/^\/heartbeat(?:\s+(.+))?$/i);
    if (!match) return null;

    const argsRaw = (match[1] || "").trim();
    if (!argsRaw) {
        const hb = getHeartbeatStatus();
        return hb.enabled
            ? `Heartbeat is ON every ${hb.intervalMinutes} minute(s).`
            : "Heartbeat is OFF.";
    }

    const args = argsRaw.split(/\s+/);
    const first = args[0].toLowerCase();

    if (first === "off" || first === "disable" || first === "stop") {
        disableHeartbeat();
        return "Heartbeat disabled.";
    }

    const minutes = parseIntervalMinutes(first);
    if (!minutes || minutes < 1) {
        return "Invalid heartbeat interval. Use /heartbeat 30, /heartbeat 45m, /heartbeat 1h, or /heartbeat off.";
    }

    const prompt = args.slice(1).join(" ").trim();
    setHeartbeat(minutes, prompt || undefined);
    return prompt
        ? `Heartbeat set to every ${minutes} minute(s) with custom prompt.`
        : `Heartbeat set to every ${minutes} minute(s).`;
}

function handleGradeCommand(input: string): string | null {
    if (input.trim().toLowerCase() !== "/grade") return null;

    const schedulerMetrics = getSchedulerHealthMetrics();
    const agentMetrics = getAgentHealthMetrics();
    const memoryMetrics = getMemoryHealthMetrics();

    const report = gradeResilience([
        {
            component: "scheduler",
            capabilities: {
                retry_logic: true,
                exponential_backoff: true,
                circuit_breaker: true,
                health_metrics: true,
                state_persistence: true,
            },
        },
        {
            component: "agent-tool-loop",
            capabilities: {
                retry_logic: true,
                exponential_backoff: true,
                circuit_breaker: true,
                health_metrics: true,
                state_persistence: false,
            },
        },
        {
            component: "memory-extraction",
            capabilities: {
                retry_logic: true,
                exponential_backoff: true,
                circuit_breaker: true,
                health_metrics: true,
                state_persistence: true,
            },
        },
    ]);

    const lines: string[] = [];
    lines.push(`Resilience Grade: ${report.overall}/100`);
    for (const c of report.components) {
        lines.push(`${c.component}: ${c.score}/100 | missing: ${c.missing.length ? c.missing.join(", ") : "none"}`);
    }
    lines.push(`scheduler metrics ops: ${Object.keys(schedulerMetrics).join(", ") || "none yet"}`);
    lines.push(`agent metrics ops: ${Object.keys(agentMetrics).join(", ") || "none yet"}`);
    lines.push(`memory metrics ops: ${Object.keys(memoryMetrics).join(", ") || "none yet"}`);
    return lines.join("\n");
}

async function handleChat(message: string) {
    const heartbeatCmd = handleHeartbeatCommand(message);
    if (heartbeatCmd !== null) {
        addMessage("system", heartbeatCmd);
        return;
    }

    const gradeCmd = handleGradeCommand(message);
    if (gradeCmd !== null) {
        addMessage("system", gradeCmd);
        return;
    }

    addMessage("user", message);
    agentStatus = "thinking";

    const apiHistory = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content })) as Message[];

    const result = await submitTask(message, apiHistory, "fast");
    if (result.status === "completed") {
        addMessage("assistant", result.reply);
    } else {
        addMessage("system", `Error: ${result.error}`);
    }

    agentStatus = "idle";
}

const server = http.createServer(async (req, res) => {
    try {
        const url = req.url || "/";
        const method = req.method || "GET";

        if (method === "GET" && url === "/") {
            sendFile(res, "index.html", "text/html; charset=utf-8");
            return;
        }
        if (method === "GET" && url === "/app.js") {
            sendFile(res, "app.js", "application/javascript; charset=utf-8");
            return;
        }
        if (method === "GET" && url === "/styles.css") {
            sendFile(res, "styles.css", "text/css; charset=utf-8");
            return;
        }

        if (method === "GET" && url === "/api/state") {
            sendJson(res, 200, {
                history: history.slice(-120),
                queue: getQueueStatus(),
                status: agentStatus,
                heartbeat: getHeartbeatStatus(),
                now: new Date().toISOString(),
            });
            return;
        }

        if (method === "POST" && url === "/api/chat") {
            const body = await parseJsonBody(req);
            const message = String(body?.message || "").trim();
            if (!message) {
                sendJson(res, 400, { error: "message required" });
                return;
            }

            await handleChat(message);
            sendJson(res, 200, { ok: true });
            return;
        }

        res.statusCode = 404;
        res.end("Not found");
    } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
    }
});

async function shutdown() {
    stopScheduler();
    await closeBrowser();
    server.close(() => process.exit(0));
}

startScheduler();
addMessage("system", "Oasis web UI ready.");
server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Oasis web UI running on http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
    void shutdown();
});
process.on("SIGTERM", () => {
    void shutdown();
});
