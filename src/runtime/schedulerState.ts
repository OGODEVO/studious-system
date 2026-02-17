import * as fs from "fs";
import * as path from "path";

export interface PersistedSchedulerState {
    nextRunById: Record<string, number>;
    heartbeat?: {
        enabled: boolean;
        intervalMinutes: number;
        prompt: string;
    };
    updatedAt: string;
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const STATE_DIR = path.join(ROOT, "memory", "scheduler");
const STATE_FILE = path.join(STATE_DIR, "state.json");

export function loadSchedulerState(): PersistedSchedulerState | null {
    try {
        const raw = fs.readFileSync(STATE_FILE, "utf-8");
        const parsed = JSON.parse(raw) as PersistedSchedulerState;
        if (!parsed || typeof parsed !== "object") return null;
        return parsed;
    } catch {
        return null;
    }
}

export function saveSchedulerState(state: Omit<PersistedSchedulerState, "updatedAt">): void {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const payload: PersistedSchedulerState = {
        ...state,
        updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), "utf-8");
}
