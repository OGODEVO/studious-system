import PQueue from "p-queue";
import { runAgent, type Message, type OnTokenCallback } from "../agent.js";

// ---------------------------------------------------------------------------
// Lane Definitions
// ---------------------------------------------------------------------------

export type LaneName = "fast" | "slow" | "background";

export interface TaskResult {
    id: string;
    lane: LaneName;
    reply: string;
    history: Message[];
    status: "completed" | "failed";
    error?: string;
    startedAt: number;
    completedAt: number;
}

// Each lane has its own concurrency limit
const lanes: Record<LaneName, PQueue> = {
    fast: new PQueue({ concurrency: 2 }),       // Chat, quick queries
    slow: new PQueue({ concurrency: 1 }),        // Web scraping, research
    background: new PQueue({ concurrency: 1 }),  // Cron, health checks
};

// ---------------------------------------------------------------------------
// Task tracking
// ---------------------------------------------------------------------------

let taskCounter = 0;
const activeTasks: Map<string, { lane: LaneName; status: string; startedAt: number }> = new Map();

// ---------------------------------------------------------------------------
// Submit a task to a lane
// ---------------------------------------------------------------------------

export async function submitTask(
    userMessage: string,
    history: Message[],
    lane: LaneName = "fast",
    onToken?: OnTokenCallback
): Promise<TaskResult> {
    const taskId = "task-" + (++taskCounter);
    const startedAt = Date.now();

    activeTasks.set(taskId, { lane, status: "queued", startedAt });

    console.log("   [Queue] Task " + taskId + " submitted to " + lane + " lane (" + lanes[lane].size + " waiting, " + lanes[lane].pending + " running)");

    return lanes[lane].add(async () => {
        activeTasks.set(taskId, { lane, status: "running", startedAt });

        try {
            const result = await runAgent(userMessage, history, onToken);

            const taskResult: TaskResult = {
                id: taskId,
                lane,
                reply: result.reply,
                history: result.history,
                status: "completed",
                startedAt,
                completedAt: Date.now(),
            };

            activeTasks.delete(taskId);
            return taskResult;
        } catch (err) {
            const taskResult: TaskResult = {
                id: taskId,
                lane,
                reply: "",
                history,
                status: "failed",
                error: (err as Error).message,
                startedAt,
                completedAt: Date.now(),
            };

            activeTasks.delete(taskId);
            return taskResult;
        }
    }) as Promise<TaskResult>;
}

// ---------------------------------------------------------------------------
// Queue status (for diagnostics / future UI)
// ---------------------------------------------------------------------------

export function getQueueStatus(): Record<LaneName, { pending: number; queued: number }> {
    return {
        fast: { pending: lanes.fast.pending, queued: lanes.fast.size },
        slow: { pending: lanes.slow.pending, queued: lanes.slow.size },
        background: { pending: lanes.background.pending, queued: lanes.background.size },
    };
}

export function getActiveTasks(): Map<string, { lane: LaneName; status: string; startedAt: number }> {
    return activeTasks;
}
