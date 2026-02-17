import { createServer } from "http";
import { createApp, attachWebSocket } from "./server.js";
import { config } from "../utils/config.js";
import { startScheduler, stopScheduler } from "../runtime/scheduler.js";
import { closeBrowser } from "../tools/browser.js";
import { saveSessionSnapshot } from "../memory/manager.js";

const PORT = Number(process.env.OASIS_PORT) || 3000;

async function main() {
    console.log("🌴 Oasis GUI starting...");
    console.log(`   Model: ${config.model}`);
    console.log(`   Context: ${config.contextWindow} tokens`);

    // Start scheduler
    startScheduler();

    // Create Express app + HTTP server
    const app = createApp();
    const server = createServer(app);

    // Attach WebSocket
    attachWebSocket(server);

    // Start listening
    server.listen(PORT, () => {
        console.log(`🌴 Oasis GUI ready at http://localhost:${PORT}`);
    });

    // Graceful shutdown
    const shutdown = async () => {
        console.log("\n🌴 Shutting down...");
        stopScheduler();
        await closeBrowser();
        server.close();
        process.exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
