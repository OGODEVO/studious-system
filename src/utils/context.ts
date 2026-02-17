import * as fs from "fs";
import * as path from "path";
import { type Message } from "../agent.js";

const SESSION_FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../memory/chat_session.json");
const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGES = 100;

export const history: Message[] = [];

let autosaveTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Sanitize — strip huge base64 blobs from saved messages
// ---------------------------------------------------------------------------

function sanitizeForStorage(messages: Message[]): any[] {
    return messages.map((m) => {
        if (!m.content || typeof m.content === "string") return m;

        // If content is an array (multimodal), strip image data
        if (Array.isArray(m.content)) {
            const cleaned = (m.content as any[]).map((part: any) => {
                if (part.type === "image_url") {
                    return { type: "text", text: "[image was attached]" };
                }
                return part;
            });
            return { ...m, content: cleaned };
        }

        return m;
    });
}

// ---------------------------------------------------------------------------
// Atomic Write — write to temp file, then rename
// ---------------------------------------------------------------------------

function atomicWrite(filePath: string, data: string) {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Save / Load
// ---------------------------------------------------------------------------

export function saveSession() {
    try {
        const trimmed = history.slice(-MAX_MESSAGES);
        const safe = sanitizeForStorage(trimmed);
        atomicWrite(SESSION_FILE, JSON.stringify(safe, null, 2));
        console.log(`💾 Session saved (${safe.length} messages).`);
    } catch (err) {
        console.error("Failed to save session:", err);
    }
}

export function loadSession() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const raw = fs.readFileSync(SESSION_FILE, "utf-8");
            const data = JSON.parse(raw);

            if (Array.isArray(data)) {
                // Validate: only keep messages with a valid role
                const valid = data.filter(
                    (m: any) => m && typeof m.role === "string" && ["user", "assistant", "system", "tool"].includes(m.role)
                );

                history.length = 0;
                history.push(...valid.slice(-MAX_MESSAGES));
                console.log(`📂 Loaded ${history.length} messages from session.`);
            }
        }
    } catch (err) {
        console.error("Failed to load session (starting fresh):", err);
        // If corrupt, nuke it
        try { fs.unlinkSync(SESSION_FILE); } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// Auto-save — periodic background save
// ---------------------------------------------------------------------------

export function startAutosave() {
    if (autosaveTimer) return;
    autosaveTimer = setInterval(() => {
        if (history.length > 0) saveSession();
    }, AUTOSAVE_INTERVAL_MS);
    console.log(`⏱️  Auto-save enabled (every ${AUTOSAVE_INTERVAL_MS / 60000} min).`);
}

export function stopAutosave() {
    if (autosaveTimer) {
        clearInterval(autosaveTimer);
        autosaveTimer = null;
    }
}
