import * as fs from "fs";
import * as path from "path";
import { type Message } from "../agent.js";

const SESSION_FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../memory/chat_session.json");

export const history: Message[] = [];

export function saveSession() {
    try {
        fs.writeFileSync(SESSION_FILE, JSON.stringify(history, null, 2));
        console.log("💾 Session saved.");
    } catch (err) {
        console.error("Failed to save session:", err);
    }
}

export function loadSession() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
            if (Array.isArray(data)) {
                // Clear existing and push new to maintain reference
                history.length = 0;
                history.push(...data);
                console.log(`📂 Loaded ${data.length} messages from session.`);
            }
        }
    } catch (err) {
        console.error("Failed to load session:", err);
    }
}
