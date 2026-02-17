import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "dotenv";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { ApprovalInterface, ApprovalDecision } from "../utils/approval.js";
import { agentBus, type ToolStartEvent } from "../utils/events.js";
import { runAgent, type Message } from "../agent.js";
import { setApprovalInterface, setGlobalAllow, getGlobalAllowStatus } from "../tools/shell.js";
import { startScheduler, stopScheduler, pushSchedulerHistory } from "../runtime/scheduler.js";

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
    let text = "";

    if (action === "allow") {
        decision = "ALLOW";
        text = "✅ Allowed once.";
    } else if (action === "allow_all") {
        decision = "ALLOW_ALL";
        text = "🔓 Allowed ALL commands for this session.";
    } else {
        decision = "DENY";
        text = "🛑 Denied.";
    }

    tgApproval.resolveReq(reqId, decision);

    try {
        const msg = ctx.callbackQuery.message;
        if (msg && "text" in msg) {
            await ctx.editMessageText(
                `${msg.text}\n\n👉 ${text}`,
                { parse_mode: "HTML" }
            );
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
        "/revoke \\- Revoke 'Allow All' permission\n" +
        "/status \\- Check permission status",
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

// ---------------------------------------------------------------------------
// Shared State & Helpers
// ---------------------------------------------------------------------------

const history: Message[] = [];
let isProcessing = false;

function authCheck(chatId: string): boolean {
    return !ALLOWED_CHAT_ID || chatId === ALLOWED_CHAT_ID;
}

/** Send a prompt to the agent and reply in Telegram */
async function processAndReply(ctx: any, userContent: string) {
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

    const photo = ctx.message.photo.at(-1); // Largest resolution
    if (!photo) return;

    const caption = ctx.message.caption || "Describe this image.";
    await ctx.reply("📷 Processing image…");

    try {
        const { buffer } = await downloadFile(photo.file_id);
        const base64 = buffer.toString("base64");
        const dataUri = `data:image/jpeg;base64,${base64}`;

        // Build vision content for the model
        const visionPrompt = `[User sent an image with caption: "${caption}"]\n\nImage data (base64) is attached. Please analyze the image and respond to the caption.`;

        // Push a text summary into history (we can't store images in our simple history)
        history.push({ role: "user", content: `[Sent an image: "${caption}"]` });

        if (isProcessing) {
            await ctx.reply("⏳ I'm still thinking… please wait.");
            return;
        }

        isProcessing = true;
        await ctx.sendChatAction("typing");

        try {
            const apiHistory = history.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

            // Build messages with vision content part
            const result = await runAgent(visionPrompt, apiHistory as any);

            history.push({ role: "assistant", content: result.reply });
            pushSchedulerHistory({ role: "assistant", content: result.reply });

            if (result.reply.length > 4000) {
                const chunks = result.reply.match(/.{1,4000}/gs) || [result.reply];
                for (const chunk of chunks) await ctx.reply(chunk);
            } else {
                await ctx.reply(result.reply);
            }
        } finally {
            isProcessing = false;
        }
    } catch (err) {
        await ctx.reply(`❌ Image error: ${(err as Error).message}`);
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
            await processAndReply(ctx, `${caption}\n\n--- File: ${fileName} ---\n${truncated}`);
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
        await processAndReply(ctx, `${caption}\n\n--- Extracted from: ${fileName} ---\n${truncated}`);

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

    await processAndReply(ctx, text);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
    console.log("🚀 Starting Oasis Telegram Bot…");

    startScheduler();

    // Subscribe to tool events — send live status to Telegram
    if (ALLOWED_CHAT_ID) {
        const chatId = ALLOWED_CHAT_ID;
        agentBus.on("tool:start", (evt: ToolStartEvent) => {
            bot.telegram.sendMessage(chatId, evt.label, { parse_mode: "HTML" }).catch(() => { });
            bot.telegram.sendChatAction(chatId, "typing").catch(() => { });
        });
    }

    bot.launch(() => {
        console.log("✅ Bot is running!");
        if (ALLOWED_CHAT_ID) {
            bot.telegram.sendMessage(ALLOWED_CHAT_ID, "🌴 Oasis Agent is now ONLINE.\n\n📷 Send photos · 📄 Send documents · 💬 Chat");
        }
    });

    process.once("SIGINT", () => { bot.stop("SIGINT"); stopScheduler(); });
    process.once("SIGTERM", () => { bot.stop("SIGTERM"); stopScheduler(); });
}

main();
