import React from "react";
import { render } from "ink";
import App from "./ui/App.js";
import { closeBrowser } from "./tools/browser.js";
import { saveSessionSnapshot } from "./memory/manager.js";
import { useStore } from "./ui/store.js";
import { config } from "./utils/config.js";
import { startScheduler, stopScheduler } from "./runtime/scheduler.js";

// --- Console Patching ---
// Redirect console logs to the UI store so they don't break the TUI layout
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function formatArgs(args: any[]) {
    return args.map(a =>
        typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(" ");
}

console.log = (...args: any[]) => {
    useStore.getState().addMessage({ role: "system", content: `[LOG] ${formatArgs(args)}` });
};
console.error = (...args: any[]) => {
    // Only log if it's not a known noise
    const msg = formatArgs(args);
    useStore.getState().addMessage({ role: "system", content: `[ERR] ${msg}` });
};
console.warn = (...args: any[]) => {
    useStore.getState().addMessage({ role: "system", content: `[WARN] ${formatArgs(args)}` });
};

async function main() {
    // No eager browser launch — browser starts lazily when a tool needs it
    useStore.getState().addMessage({ role: "system", content: "🌴 Oasis Agent ready." });
    startScheduler();

    // Render UI
    const { unmount, waitUntilExit } = render(<App />);

    // 3. Graceful Shutdown Logic
    let isShuttingDown = false;
    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        const history = useStore.getState().history;
        if (history.length > 0) {
            const snap = saveSessionSnapshot(history);
            if (snap) originalLog(`Snapshot saved: ${snap}`); // Log to original stdout if UI is gone
        }
        stopScheduler();
        await closeBrowser();
        unmount();
        process.exit(0);
    };

    // Ink captures Ctrl+C usually, but we want to ensure we save state.
    // We can rely on App to handle "exit" command, or use process signal.
    process.on("SIGINT", () => {
        void shutdown();
    });

    await waitUntilExit();
    await shutdown();
}

main().catch(err => {
    originalError("Fatal Error:", err);
    process.exit(1);
});
