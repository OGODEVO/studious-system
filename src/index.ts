import * as readline from "readline";
import { runAgent, type Message } from "./agent.js";
import { launchBrowser, closeBrowser } from "./tools/browser.js";
import {
    saveSessionSnapshot,
    rememberThis,
} from "./memory/manager.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function prompt(q: string): Promise<string> {
    return new Promise((resolve) => rl.question(q, resolve));
}

async function main() {
    console.log("🌴 Oasis Agent — Browser Automation + LLM + Memory");
    console.log("   Commands:");
    console.log("     /clear           — save snapshot & reset history");
    console.log("     /remember <text> — persist a fact to memory");
    console.log("     /memory          — show current memory.md");
    console.log("     exit / quit      — save & exit\n");

    console.log("   Launching browser...");
    await launchBrowser();
    console.log("   ✅ Browser ready.\n");

    let history: Message[] = [];

    // Graceful shutdown
    const shutdown = async () => {
        if (history.length > 0) {
            const snap = saveSessionSnapshot(history);
            if (snap) console.log(`   📸 Session saved: ${snap}`);
        }
        console.log("\n   Closing browser...");
        await closeBrowser();
        console.log("   👋 Goodbye!\n");
        rl.close();
        process.exit(0);
    };

    process.on("SIGINT", () => { void shutdown(); });

    while (true) {
        const userInput = await prompt("You → ");
        const trimmed = userInput.trim();

        if (!trimmed) continue;

        // ---- Exit ----
        if (["exit", "quit", "q"].includes(trimmed.toLowerCase())) {
            await shutdown();
            break;
        }

        // ---- /clear ----
        if (trimmed.toLowerCase() === "/clear") {
            if (history.length > 0) {
                const snap = saveSessionSnapshot(history);
                if (snap) console.log(`   📸 Session snapshot saved: ${snap}`);
            }
            history = [];
            console.log("   🔄 History cleared. Memory persists.\n");
            continue;
        }

        // ---- /remember ----
        if (trimmed.toLowerCase().startsWith("/remember ")) {
            const fact = trimmed.slice("/remember ".length).trim();
            if (fact) {
                const result = rememberThis(fact);
                console.log(`   ${result}\n`);
            } else {
                console.log("   Usage: /remember <fact to persist>\n");
            }
            continue;
        }

        // ---- /memory ----
        if (trimmed.toLowerCase() === "/memory") {
            const fs = await import("fs");
            const path = await import("path");
            const memPath = path.resolve(
                path.dirname(new URL(import.meta.url).pathname),
                "../memory/memory.md"
            );
            try {
                const content = fs.readFileSync(memPath, "utf-8");
                console.log(`\n${content}\n`);
            } catch {
                console.log("   (no memory file found)\n");
            }
            continue;
        }

        // ---- Normal message → agent ----
        console.log("\n   🤔 Thinking...\n");

        try {
            const result = await runAgent(trimmed, history);
            history = result.history;
            console.log(`\n🌴 Oasis:\n${result.reply}\n`);
        } catch (err) {
            console.error(`   ❌ Error: ${(err as Error).message}\n`);
        }
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
