import { create } from "zustand";
import { type Message } from "../agent.js";
import { type LaneName } from "../runtime/taskQueue.js";

interface QueueState {
    fast: { pending: number; queued: number };
    slow: { pending: number; queued: number };
    background: { pending: number; queued: number };
}

interface AppState {
    history: Message[];
    streamingToken: string;
    queueStatus: QueueState;
    agentStatus: "idle" | "thinking" | "streaming";

    // Actions
    addMessage: (msg: Message) => void;
    appendToken: (token: string) => void;
    setQueueStatus: (status: QueueState) => void;
    setAgentStatus: (status: "idle" | "thinking" | "streaming") => void;
    clearStreaming: () => void;
}

export const useStore = create<AppState>((set) => ({
    history: [],
    streamingToken: "",
    queueStatus: {
        fast: { pending: 0, queued: 0 },
        slow: { pending: 0, queued: 0 },
        background: { pending: 0, queued: 0 },
    },
    agentStatus: "idle",

    addMessage: (msg) => set((state) => ({ history: [...state.history, msg] })),
    appendToken: (token) => set((state) => ({ streamingToken: state.streamingToken + token })),
    setQueueStatus: (status) => set({ queueStatus: status }),
    setAgentStatus: (status) => set({ agentStatus: status }),
    clearStreaming: () => set({ streamingToken: "" }),
}));
