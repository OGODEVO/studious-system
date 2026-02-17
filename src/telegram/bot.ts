import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "dotenv";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { ApprovalInterface, ApprovalDecision } from "../utils/approval.js";
import { agentBus, type ToolStartEvent, type ToolEndEvent } from "../utils/events.js";
import { runAgent, type Message } from "../agent.js";
import { setApprovalInterface, setGlobalAllow, getGlobalAllowStatus } from "../tools/shell.js";
import { startScheduler, stopScheduler, pushSchedulerHistory } from "../runtime/scheduler.js";
import { history, saveSession, loadSession, startAutosave, stopAutosave } from "../utils/context.js";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";

config();
const execAsync = promisify(exec);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SCRIPTS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../scripts");

if (!BOT_TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN is missing in .env");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------------------------------------------------------------------------
// Approval Implementation
// ---------------------------------------------------------------------------

class TelegramApproval implements ApprovalInterface {
    private pendingReqs = new Map<string, (d: ApprovalDecision) => void>();

    async requestApproval(command: string): Promise<ApprovalDecision> {
        if (!ALLOWED_CHAT_ID) {
            console.error("❌ TELEGRAM_CHAT_ID is missing, cannot ask for approval");
            return "DENY";
        }

        const reqId = Math.random().toString(36).substring(7);

        return new Promise((resolve) => {
            this.pendingReqs.set(reqId, resolve);

            bot.telegram.sendMessage(
                ALLOWED_CHAT_ID,
                `⚠️ <b>Execute Command?</b>\n<code>${command}</code>`,
                {
                    parse_mode: "HTML",
                    ...Markup.inlineKeyboard([
                        [
                            Markup.button.callback("✅ Allow Once", `allow:${reqId}`),
                            Markup.button.callback("🛑 Deny", `deny:${reqId}`),
                        ],
                        [Markup.button.callback("🔓 Allow ALL (Until Revoked)", `allow_all:${reqId}`)],
                    ]),
                }
            ).catch(err => {
                console.error("Failed to send approval request:", err);
                resolve("DENY");
            });
        });
    }

    resolveReq(reqId: string, decision: ApprovalDecision) {
        const resolve = this.pendingReqs.get(reqId);
        if (resolve) {
            resolve(decision);
            this.pendingReqs.delete(reqId);
        }
    }
}

const tgApproval = new TelegramApproval();
setApprovalInterface(tgApproval);

// ---------------------------------------------------------------------------
// Bot Events — Approval Callbacks
// ---------------------------------------------------------------------------

bot.action(/^(allow|deny|allow_all):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const reqId = ctx.match[2];

    let decision: ApprovalDecision = "DENY";
    let label = "";

    if (action === "allow") {
        decision = "ALLOW";
        label = "✅ Allowed once.";
    } else if (action === "allow_all") {
        decision = "ALLOW_ALL";
        label = "🔓 Allowed ALL commands for this session.";
    } else {
        decision = "DENY";
        label = "🛑 Denied.";
    }

    // Answer the callback query immediately (stops the button spinner)
    await ctx.answerCbQuery(label);

    tgApproval.resolveReq(reqId, decision);

    try {
        const msg = ctx.callbackQuery.message;
        if (msg && "text" in msg) {
            // Replace the approval message with the decision (no parse_mode — plain text is safer)
            await ctx.editMessageText(`${msg.text}\n\n👉 ${label}`);
        }
    } catch {
        // ignore if message too old
    }
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.command("start", (ctx) => {
    ctx.reply(
        "🌴 *Oasis Agent Online*\n\n" +
        "Send me text, photos, or documents\\.\n\n" +
        "*Commands:*\n" +
        "/status \\- Check permission status\n" +
        "/revoke \\- Revoke 'Allow All' permission\n" +
        "/update \\- Pull latest code \\& restart\n" +
        "/save \\- Save chat history to disk\n" +
        "/reset \\- Clear chat history",
        { parse_mode: "MarkdownV2" }
    );
});

bot.command("revoke", (ctx) => {
    setGlobalAllow(false);
    ctx.reply("🔒 Global execution permission REVOKED. Tools will require approval again.");
});

bot.command("status", (ctx) => {
    const isFree = getGlobalAllowStatus();
    ctx.reply(isFree
        ? "🔓 Status: UNLOCKED (All commands allowed)"
        : "🔒 Status: SECURE (Approval required)");
});

bot.command("update", async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }

    await ctx.reply("🔄 Checking for updates...");

    try {
        const { stdout } = await execAsync("git pull");

        if (stdout.includes("Already up to date")) {
            await ctx.reply("✅ Already up to date.");
            return;
        }

        await ctx.reply(`⬇️ Updates found:\n<pre>${stdout}</pre>\n\n📦 Installing dependencies...`, { parse_mode: "HTML" });
        await execAsync("npm install");

        await ctx.reply("♻️ Restarting to apply changes...");
        saveSession();
        process.exit(0); // PM2 will restart us
    } catch (err) {
        await ctx.reply(`❌ Update failed: ${(err as Error).message}`);
    }
});

bot.command("save", (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }
    saveSession();
    ctx.reply(`💾 Chat history saved (${history.length} messages).`);
});

bot.command("reset", (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }
    history.length = 0;
    saveSession();
    ctx.reply("🧹 Chat history cleared. Starting fresh.");
});

// ---------------------------------------------------------------------------
// Shared State & Helpers
// ---------------------------------------------------------------------------

let isProcessing = false;

function authCheck(chatId: string): boolean {
    return !ALLOWED_CHAT_ID || chatId === ALLOWED_CHAT_ID;
}

/** Send a prompt to the agent and reply in Telegram */
async function processAndReply(ctx: any, userContent: string | ChatCompletionContentPart[]) {
    if (isProcessing) {
        await ctx.reply("⏳ I'm still thinking… please wait.");
        return;
    }

    isProcessing = true;
    history.push({ role: "user", content: userContent });

    // Cap history at 100 messages
    while (history.length > 100) history.shift();

    await ctx.sendChatAction("typing");

    try {
        const apiHistory = history.map(m => ({ role: m.role, content: m.content }));
        const result = await runAgent(userContent, apiHistory as any);

        history.push({ role: "assistant", content: result.reply });
        pushSchedulerHistory({ role: "assistant", content: result.reply });

        if (result.reply.length > 4000) {
            const chunks = result.reply.match(/.{1,4000}/gs) || [result.reply];
            for (const chunk of chunks) await ctx.reply(chunk);
        } else {
            await ctx.reply(result.reply);
        }
    } catch (err) {
        await ctx.reply(`❌ Error: ${(err as Error).message}`);
    } finally {
        isProcessing = false;
    }
}

/** Download a Telegram file to a Buffer */
async function downloadFile(fileId: string): Promise<{ buffer: Buffer; url: string }> {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const url = fileLink.href;
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, url };
}

// ---------------------------------------------------------------------------
// 📷 Photo Handler — Vision API
// ---------------------------------------------------------------------------

bot.on(message("photo"), async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }

    const photo = ctx.message.photo.at(1) || ctx.message.photo.at(-1); // Use medium size (index 1) to avoid huge payloads, plain fallback to largest
    if (!photo) return;

    const caption = ctx.message.caption || "Describe this image.";
    ctx.reply("📷 Processing image…");

    try {
        const { buffer } = await downloadFile(photo.file_id);
        const base64 = buffer.toString("base64");

        const visionContent: ChatCompletionContentPart[] = [
            { type: "text", text: `[User sent an image with caption: "${caption}"]` },
            {
                type: "image_url",
                image_url: {
                    url: `data:image/jpeg;base64,${base64}`,
                    detail: "auto"
                }
            }
        ];

        // Fire-and-forget — don't block Telegraf's middleware
        processAndReply(ctx, visionContent);
    } catch (err: any) {
        console.error("❌ Image Error Details:", err);
        // Try to get response body if available
        const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        ctx.reply(`❌ Image error: ${details}`);
    }
});

// ---------------------------------------------------------------------------
// 📄 Document Handler — Docling
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".html", ".md", ".txt"]);

bot.on(message("document"), async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }

    const doc = ctx.message.document;
    if (!doc) return;

    const fileName = doc.file_name || "file";
    const ext = path.extname(fileName).toLowerCase();
    const caption = ctx.message.caption || `Analyze this document: ${fileName}`;

    // Plain text files — read directly, no Docling needed
    if (ext === ".txt" || ext === ".md" || ext === ".csv") {
        await ctx.reply(`📄 Reading ${fileName}…`);
        try {
            const { buffer } = await downloadFile(doc.file_id);
            const text = buffer.toString("utf-8");
            const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n…(truncated)" : text;
            processAndReply(ctx, `${caption}\n\n--- File: ${fileName} ---\n${truncated}`);
        } catch (err) {
            await ctx.reply(`❌ Error reading ${fileName}: ${(err as Error).message}`);
        }
        return;
    }

    // Docling-supported formats
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
        await ctx.reply(`❌ Unsupported file type: ${ext}\nSupported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
        return;
    }

    await ctx.reply(`📄 Converting ${fileName} with Docling…`);

    // Download to temp, convert, cleanup
    const tmpPath = path.join(os.tmpdir(), `oasis_${Date.now()}${ext}`);

    try {
        const { buffer } = await downloadFile(doc.file_id);
        fs.writeFileSync(tmpPath, buffer);

        const convertScript = path.join(SCRIPTS_DIR, "convert.py");
        const { stdout, stderr } = await execAsync(`python3 "${convertScript}" "${tmpPath}"`, {
            timeout: 120_000, // 2 min max
        });

        if (stderr) console.warn("[Docling stderr]", stderr);

        const markdown = stdout.trim();
        if (!markdown) {
            await ctx.reply("⚠️ Docling returned empty output — the file may be empty or unsupported.");
            return;
        }

        const truncated = markdown.length > 8000 ? markdown.slice(0, 8000) + "\n…(truncated)" : markdown;
        processAndReply(ctx, `${caption}\n\n--- Extracted from: ${fileName} ---\n${truncated}`);

    } catch (err) {
        await ctx.reply(`❌ Docling error: ${(err as Error).message}`);
    } finally {
        // Cleanup — don't save files
        try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    }
});

// ---------------------------------------------------------------------------
// 💬 Text Handler
// ---------------------------------------------------------------------------

bot.on(message("text"), async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }

    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    // Fire-and-forget — don't block Telegraf's middleware
    processAndReply(ctx, text);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
    console.log("🚀 Starting Oasis Telegram Bot (v2.1 - Vision Enabled)…");

    loadSession(); // Restore chat history
    startAutosave(); // Periodic background saves
    startScheduler();

    // Subscribe to tool events — send live status to Telegram
    if (ALLOWED_CHAT_ID) {
        const chatId = ALLOWED_CHAT_ID;
        agentBus.on("tool:start", (evt: ToolStartEvent) => {
            bot.telegram.sendMessage(chatId, evt.label, { parse_mode: "HTML" }).catch(() => { });
            bot.telegram.sendChatAction(chatId, "typing").catch(() => { });
        });
        agentBus.on("tool:end", (evt: ToolEndEvent) => {
            // High-trust trace for wallet tools so outputs are verifiable in chat.
            if (!evt.tool.startsWith("wallet_")) return;
            const state = evt.success ? "✅" : "❌";
            const preview = evt.outputPreview ? `\n${evt.outputPreview}` : "";
            bot.telegram
                .sendMessage(chatId, `${state} ${evt.tool} finished in ${evt.durationMs}ms${preview}`)
                .catch(() => { });
        });
    }

    bot.launch(() => {
        console.log("✅ Bot is running!");
        if (ALLOWED_CHAT_ID) {
            bot.telegram.sendMessage(ALLOWED_CHAT_ID, "🌴 Oasis Agent is now ONLINE.\n\n📷 Send photos · 📄 Send documents · 💬 Chat");
        }
    });

    process.once("SIGINT", () => { bot.stop("SIGINT"); stopScheduler(); stopAutosave(); saveSession(); });
    process.once("SIGTERM", () => { bot.stop("SIGTERM"); stopScheduler(); stopAutosave(); saveSession(); });
}

main();
