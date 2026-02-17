import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as path from "path";
import { submitTask, getQueueStatus, type TaskResult } from "../runtime/taskQueue.js";
import { type Message, type OnTokenCallback, getAgentHealthMetrics } from "../agent.js";
import {
    setHeartbeat,
    disableHeartbeat,
    getHeartbeatStatus,
    getSchedulerHealthMetrics,
} from "../runtime/scheduler.js";
import { gradeResilience } from "../runtime/resilienceGrade.js";
import { getMemoryHealthMetrics } from "../memory/manager.js";
import { config } from "../utils/config.js";

// ---------------------------------------------------------------------------
// Shared conversation history (server-side, shared across WS clients)
// ---------------------------------------------------------------------------

let conversationHistory: Message[] = [];
let agentStatus: "idle" | "thinking" | "streaming" = "idle";

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------

export function createApp() {
    const app = express();
    app.use(express.json());

    // Serve static frontend files
    const webDir = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../../web"
    );
    app.use(express.static(webDir));

    // ── GET /api/status ────────────────────────────────────────────────
    app.get("/api/status", (_req, res) => {
        const queue = getQueueStatus();
        const heartbeat = getHeartbeatStatus();
        res.json({
            agent: {
                status: agentStatus,
                model: config.model,
                contextWindow: config.contextWindow,
            },
            queue,
            heartbeat,
        });
    });

    // ── POST /api/heartbeat ────────────────────────────────────────────
    app.post("/api/heartbeat", (req, res) => {
        const { action, interval, prompt } = req.body || {};

        if (action === "off" || action === "disable") {
            disableHeartbeat();
            return res.json({ ok: true, message: "Heartbeat disabled." });
        }

        const minutes = Number(interval);
        if (!minutes || minutes < 1) {
            return res.status(400).json({ ok: false, message: "Invalid interval." });
        }

        setHeartbeat(minutes, prompt || undefined);
        return res.json({
            ok: true,
            message: `Heartbeat set to every ${minutes}m.`,
        });
    });

    // ── POST /api/grade ────────────────────────────────────────────────
    app.post("/api/grade", (_req, res) => {
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

        const schedulerMetrics = getSchedulerHealthMetrics();
        const agentMetrics = getAgentHealthMetrics();
        const memoryMetrics = getMemoryHealthMetrics();

        res.json({
            report,
            metrics: {
                scheduler: Object.keys(schedulerMetrics),
                agent: Object.keys(agentMetrics),
                memory: Object.keys(memoryMetrics),
            },
        });
    });

    // ── GET /api/history ───────────────────────────────────────────────
    app.get("/api/history", (_req, res) => {
        // Return only user/assistant messages for display
        const display = conversationHistory.filter(
            (m) => m.role === "user" || m.role === "assistant"
        );
        res.json(display);
    });

    return app;
}

// ---------------------------------------------------------------------------
// WebSocket Handler
// ---------------------------------------------------------------------------

export function attachWebSocket(server: ReturnType<typeof createServer>) {
    const wss = new WebSocketServer({ server, path: "/ws" });

    wss.on("connection", (ws) => {
        // Send current history on connect
        const display = conversationHistory.filter(
            (m) => m.role === "user" || m.role === "assistant"
        );
        ws.send(JSON.stringify({ type: "history", data: display }));
        ws.send(JSON.stringify({ type: "status", data: agentStatus }));

        ws.on("message", async (raw) => {
            let parsed: { type: string; message?: string };
            try {
                parsed = JSON.parse(raw.toString());
            } catch {
                ws.send(JSON.stringify({ type: "error", data: "Invalid JSON" }));
                return;
            }

            if (parsed.type !== "chat" || !parsed.message?.trim()) return;

            const userMessage = parsed.message.trim();

            // Broadcast user message to all clients
            broadcast(wss, { type: "user_message", data: userMessage });

            agentStatus = "thinking";
            broadcast(wss, { type: "status", data: "thinking" });

            const onToken: OnTokenCallback = (token) => {
                agentStatus = "streaming";
                broadcast(wss, { type: "token", data: token });
            };

            // Only send user/assistant messages to the API
            const apiHistory = conversationHistory.filter(
                (m) => m.role === "user" || m.role === "assistant"
            );

            try {
                const result: TaskResult = await submitTask(
                    userMessage,
                    apiHistory,
                    "fast",
                    onToken
                );

                if (result.status === "completed") {
                    conversationHistory = result.history;
                    broadcast(wss, { type: "reply", data: result.reply });
                } else {
                    broadcast(wss, {
                        type: "error",
                        data: result.error || "Agent failed",
                    });
                }
            } catch (err) {
                broadcast(wss, {
                    type: "error",
                    data: (err as Error).message,
                });
            } finally {
                agentStatus = "idle";
                broadcast(wss, { type: "status", data: "idle" });
            }
        });
    });
}

function broadcast(wss: WebSocketServer, msg: Record<string, unknown>) {
    const payload = JSON.stringify(msg);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}
