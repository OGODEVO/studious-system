import { submitTask, type LaneName } from "./taskQueue.js";
import { useStore } from "../ui/store.js";
import { config } from "../utils/config.js";
import { ResilientExecutor } from "./resilience.js";
import { loadSchedulerState, saveSchedulerState } from "./schedulerState.js";

interface RuntimeReminder {
    id: string;
    prompt: string;
    intervalMinutes: number;
    lane: LaneName;
    enabled: boolean;
}

const MIN_INTERVAL_MINUTES = 1;
const HEARTBEAT_ID = "self-heartbeat";
const reminderExecutor = new ResilientExecutor({
    retry: {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        jitterRatio: 0.2,
    },
    circuitBreaker: {
        failureThreshold: 3,
        cooldownMs: 5 * 60 * 1000,
    },
});

let tickTimer: NodeJS.Timeout | null = null;
const nextRunById = new Map<string, number>();
const running = new Set<string>();
const runtimeHeartbeat = {
    enabled: config.scheduler.heartbeat.enabled,
    intervalMinutes: Math.max(
        MIN_INTERVAL_MINUTES,
        config.scheduler.heartbeat.intervalMinutes
    ),
    prompt: config.scheduler.heartbeat.prompt,
};

function nowMs(): number {
    return Date.now();
}

function toMs(minutes: number): number {
    return minutes * 60 * 1000;
}

function normalizeReminders(): RuntimeReminder[] {
    const configured = config.scheduler.reminders
        .filter((r) => r.enabled !== false)
        .map((r) => ({
            id: r.id,
            prompt: r.prompt,
            intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, r.intervalMinutes),
            lane: r.lane,
            enabled: r.enabled,
        }));

    if (runtimeHeartbeat.enabled) {
        configured.push({
            id: HEARTBEAT_ID,
            prompt: runtimeHeartbeat.prompt,
            intervalMinutes: runtimeHeartbeat.intervalMinutes,
            lane: "background",
            enabled: true,
        });
    }

    return configured;
}

function getApiHistory() {
    return useStore
        .getState()
        .history.filter((m) => m.role === "user" || m.role === "assistant");
}

function persistState(): void {
    const nextRun: Record<string, number> = {};
    for (const [id, ts] of nextRunById.entries()) {
        nextRun[id] = ts;
    }

    saveSchedulerState({
        nextRunById: nextRun,
        heartbeat: { ...runtimeHeartbeat },
    });
}

function loadPersistedState(): void {
    const state = loadSchedulerState();
    if (!state) return;

    for (const [id, ts] of Object.entries(state.nextRunById || {})) {
        if (typeof ts === "number" && Number.isFinite(ts)) {
            nextRunById.set(id, ts);
        }
    }

    if (state.heartbeat) {
        runtimeHeartbeat.enabled = !!state.heartbeat.enabled;
        runtimeHeartbeat.intervalMinutes = Math.max(
            MIN_INTERVAL_MINUTES,
            Math.floor(state.heartbeat.intervalMinutes)
        );
        if (state.heartbeat.prompt?.trim()) {
            runtimeHeartbeat.prompt = state.heartbeat.prompt.trim();
        }
    }
}

async function runReminder(reminder: RuntimeReminder): Promise<void> {
    if (running.has(reminder.id)) return;

    running.add(reminder.id);
    const store = useStore.getState();
    store.addMessage({
        role: "system",
        content: `[SCHED] Running reminder \"${reminder.id}\" on ${reminder.lane} lane`,
    });

    try {
        const result = await reminderExecutor.execute(
            `scheduler:${reminder.id}`,
            async () => {
                const res = await submitTask(
                    reminder.prompt,
                    getApiHistory(),
                    reminder.lane
                );
                if (res.status !== "completed") {
                    throw new Error(res.error || "Scheduled task failed");
                }
                return res;
            }
        );

        useStore.getState().addMessage({
            role: "assistant",
            content: `[${reminder.id}] ${result.reply}`,
        });
    } catch (err) {
        useStore.getState().addMessage({
            role: "system",
            content: `[SCHED][ERROR] ${reminder.id}: ${(err as Error).message}`,
        });
    } finally {
        running.delete(reminder.id);
    }
}

async function tick(): Promise<void> {
    if (!config.scheduler.enabled) return;

    const reminders = normalizeReminders();
    const now = nowMs();

    for (const reminder of reminders) {
        if (!reminder.enabled) continue;

        const nextRun = nextRunById.get(reminder.id);
        if (nextRun === undefined) {
            nextRunById.set(reminder.id, now + toMs(reminder.intervalMinutes));
            persistState();
            continue;
        }

        if (now < nextRun) continue;

        nextRunById.set(reminder.id, now + toMs(reminder.intervalMinutes));
        persistState();
        void runReminder(reminder);
    }
}

export function startScheduler(): void {
    if (!config.scheduler.enabled || tickTimer) return;
    loadPersistedState();

    useStore.getState().addMessage({
        role: "system",
        content: `[SCHED] Scheduler active (${config.scheduler.tickSeconds}s tick)`,
    });

    tickTimer = setInterval(() => {
        void tick();
    }, Math.max(1, config.scheduler.tickSeconds) * 1000);

    void tick();
}

export function stopScheduler(): void {
    if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
        persistState();
        useStore.getState().addMessage({
            role: "system",
            content: "[SCHED] Scheduler stopped",
        });
    }
}

export function setHeartbeat(intervalMinutes: number, prompt?: string): void {
    runtimeHeartbeat.enabled = true;
    runtimeHeartbeat.intervalMinutes = Math.max(
        MIN_INTERVAL_MINUTES,
        Math.floor(intervalMinutes)
    );
    if (prompt && prompt.trim()) {
        runtimeHeartbeat.prompt = prompt.trim();
    }

    nextRunById.delete(HEARTBEAT_ID);
    persistState();
    useStore.getState().addMessage({
        role: "system",
        content:
            `[SCHED] Heartbeat set to every ${runtimeHeartbeat.intervalMinutes} minute(s)` +
            (prompt ? " with custom prompt" : ""),
    });
}

export function disableHeartbeat(): void {
    runtimeHeartbeat.enabled = false;
    nextRunById.delete(HEARTBEAT_ID);
    persistState();
    useStore.getState().addMessage({
        role: "system",
        content: "[SCHED] Heartbeat disabled",
    });
}

export function getHeartbeatStatus(): {
    enabled: boolean;
    intervalMinutes: number;
    prompt: string;
} {
    return { ...runtimeHeartbeat };
}

export function getSchedulerHealthMetrics() {
    return reminderExecutor.getAllMetrics();
}
