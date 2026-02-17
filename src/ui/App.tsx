import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import QueueSidebar from "./components/QueueSidebar.js";
import ChatPanel from "./components/ChatPanel.js";
import Avatar from "./components/Avatar.js";
import { useStore } from "./store.js";
import { submitTask, getQueueStatus } from "../runtime/taskQueue.js";
import { type OnTokenCallback, getAgentHealthMetrics } from "../agent.js";
import { config } from "../utils/config.js";
import {
    setHeartbeat,
    disableHeartbeat,
    getHeartbeatStatus,
    getSchedulerHealthMetrics,
} from "../runtime/scheduler.js";
import { gradeResilience } from "../runtime/resilienceGrade.js";
import { getMemoryHealthMetrics } from "../memory/manager.js";
import { colors, DIVIDER, AVATAR_INLINE } from "./theme.js";

// ---------------------------------------------------------------------------
// Command handlers (unchanged logic, just extracted)
// ---------------------------------------------------------------------------

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
            ? `♥ Heartbeat is ON every ${hb.intervalMinutes} minute(s).`
            : "♥ Heartbeat is OFF.";
    }

    const args = argsRaw.split(/\s+/);
    const first = args[0].toLowerCase();

    if (first === "off" || first === "disable" || first === "stop") {
        disableHeartbeat();
        return "♥ Heartbeat disabled.";
    }

    const minutes = parseIntervalMinutes(first);
    if (!minutes || minutes < 1) {
        return "Invalid interval. Use `/heartbeat 30`, `/heartbeat 1h`, or `/heartbeat off`.";
    }

    const prompt = args.slice(1).join(" ").trim();
    setHeartbeat(minutes, prompt || undefined);
    return prompt
        ? `♥ Heartbeat set to every ${minutes}m with custom prompt.`
        : `♥ Heartbeat set to every ${minutes}m.`;
}

function handleGradeCommand(input: string): string | null {
    const trimmed = input.trim().toLowerCase();
    if (trimmed !== "/grade") return null;

    const metrics = getSchedulerHealthMetrics();
    const hasSchedulerMetrics = Object.keys(metrics).length > 0;
    const agentMetrics = getAgentHealthMetrics();
    const hasAgentMetrics = Object.keys(agentMetrics).length > 0;
    const memoryMetrics = getMemoryHealthMetrics();
    const hasMemoryMetrics = Object.keys(memoryMetrics).length > 0;

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
    lines.push(`◈ Resilience Grade: ${report.overall}/100`);
    for (const c of report.components) {
        lines.push(
            `  ${c.component}: ${c.score}/100 │ missing: ${c.missing.length === 0 ? "none" : c.missing.join(", ")}`
        );
    }
    lines.push(
        hasSchedulerMetrics
            ? `  scheduler ops: ${Object.keys(metrics).join(", ")}`
            : "  scheduler ops: none yet"
    );
    lines.push(
        hasAgentMetrics
            ? `  agent ops: ${Object.keys(agentMetrics).join(", ")}`
            : "  agent ops: none yet"
    );
    lines.push(
        hasMemoryMetrics
            ? `  memory ops: ${Object.keys(memoryMetrics).join(", ")}`
            : "  memory ops: none yet"
    );
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// App Component
// ---------------------------------------------------------------------------

const App: React.FC = () => {
    const [inputValue, setInputValue] = useState("");
    const [clock, setClock] = useState(
        new Date().toLocaleTimeString("en-US", { hour12: false })
    );
    const {
        addMessage,
        appendToken,
        setQueueStatus,
        setAgentStatus,
        clearStreaming,
        history,
        agentStatus
    } = useStore();

    useEffect(() => {
        const timer = setInterval(() => {
            setQueueStatus(getQueueStatus());
            setClock(new Date().toLocaleTimeString("en-US", { hour12: false }));
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    const handleSubmit = async (input: string) => {
        if (!input.trim()) return;

        const userMsg = input.trim();
        setInputValue("");

        const heartbeatCmd = handleHeartbeatCommand(userMsg);
        if (heartbeatCmd !== null) {
            addMessage({ role: "system", content: heartbeatCmd });
            return;
        }

        const gradeCmd = handleGradeCommand(userMsg);
        if (gradeCmd !== null) {
            addMessage({ role: "system", content: gradeCmd });
            return;
        }

        addMessage({ role: "user", content: userMsg });
        setAgentStatus("thinking");

        const onToken: OnTokenCallback = (token) => {
            setAgentStatus("streaming");
            appendToken(token);
        };

        const apiHistory = history.filter(
            (m): m is typeof m => m.role === "user" || m.role === "assistant"
        );

        try {
            const result = await submitTask(userMsg, apiHistory, "fast", onToken);

            clearStreaming();
            if (result.status === "completed") {
                addMessage({ role: "assistant", content: result.reply });
            } else {
                addMessage({ role: "system", content: "Error: " + result.error });
            }
        } catch (err) {
            addMessage({ role: "system", content: "Critical Error: " + (err as Error).message });
        } finally {
            setAgentStatus("idle");
        }
    };

    // Status indicator
    const statusColor =
        agentStatus === "streaming" ? colors.success
            : agentStatus === "thinking" ? colors.warning
                : colors.muted;
    const statusLabel =
        agentStatus === "idle" ? "● idle" : agentStatus;

    return (
        <Box flexDirection="column">
            {/* ── Header ────────────────────────────────────────── */}
            <Box>
                <Box marginRight={1}>
                    <Avatar status={agentStatus} />
                </Box>
                <Box flexDirection="column">
                    <Box>
                        <Text bold color={colors.primary}>{AVATAR_INLINE} OASIS</Text>
                        <Text color={colors.muted}>  {clock}  </Text>
                        <Text color={colors.dim}>model:</Text>
                        <Text color={colors.text}>{config.model}  </Text>
                        <Text color={colors.dim}>ctx:</Text>
                        <Text color={colors.text}>{config.contextWindow}  </Text>
                    </Box>
                    <Box>
                        <Text color={statusColor}>
                            {agentStatus === "idle" ? (
                                statusLabel
                            ) : (
                                <>
                                    <Spinner type={agentStatus === "streaming" ? "dots" : "line"} /> {statusLabel}
                                </>
                            )}
                        </Text>
                    </Box>
                </Box>
            </Box>

            <Text color={colors.muted}>{DIVIDER}</Text>

            {/* ── Main Content ──────────────────────────────────── */}
            <Box flexGrow={1} marginTop={1}>
                <ChatPanel />
                <Box marginLeft={1}>
                    <QueueSidebar />
                </Box>
            </Box>

            <Text color={colors.muted}>{DIVIDER}</Text>

            {/* ── Input ─────────────────────────────────────────── */}
            <Box marginTop={1}>
                <Text bold color={colors.primary}>{"❯ "}</Text>
                <TextInput
                    value={inputValue}
                    onChange={setInputValue}
                    onSubmit={handleSubmit}
                />
            </Box>

            {/* ── Help ──────────────────────────────────────────── */}
            <Box marginTop={1}>
                <Text color={colors.dim}>enter send  │  /heartbeat 30  │  /heartbeat off  │  /grade</Text>
            </Box>
        </Box>
    );
};

export default App;
