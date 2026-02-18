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
import {
    runAgent,
    estimateTokenContext,
    type Message,
    type PlanningMode,
    type TokenUsageEstimate,
} from "../agent.js";
import { setApprovalInterface, setGlobalAllow, getGlobalAllowStatus } from "../tools/shell.js";
import { getAddress, getBalance, getNetworkStatus, getTransactionStatus } from "../tools/wallet.js";
import { AVAILABLE_TOOLS } from "../tools/registry.js";
import { startScheduler, stopScheduler, pushSchedulerHistory } from "../runtime/scheduler.js";
import { history, saveSession, loadSession, startAutosave, stopAutosave } from "../utils/context.js";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { getGoalSnapshots } from "../memory/manager.js";

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
const SEARCH_TRACE_TOOLS = new Set(["perplexity_search", "search_google"]);
const SHOW_SEARCH_TOOL_EVENTS = process.env.OASIS_SHOW_SEARCH_TOOL_EVENTS === "true";
const ALWAYS_VISIBLE_TOOL_CALLS = new Set(["perplexity_search"]);

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
                            Markup.button.callback("✅ Approve", `allow:${reqId}`),
                            Markup.button.callback("🛑 No", `deny:${reqId}`),
                        ]
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

    hasPending(): boolean {
        return this.pendingReqs.size > 0;
    }

    resolveLatest(decision: ApprovalDecision): boolean {
        const latestReqId = Array.from(this.pendingReqs.keys()).at(-1);
        if (!latestReqId) return false;
        this.resolveReq(latestReqId, decision);
        return true;
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
        "/mode <fast|auto|autonomous> \\- Set planning mode\n" +
        "/wallet \\- Show agent wallet address\n" +
        "/balance \\- Show ETH balance\n" +
        "/balance <token_address> \\- Show ERC\\-20 balance\n" +
        "/rpc \\- Show active chain and RPC endpoint\n" +
        "/tx <hash> \\- Inspect a transaction on current RPC\n" +
        "/revoke \\- Revoke 'Allow All' permission\n" +
        "/update \\- Pull latest code \\& restart\n" +
        "/goals \\- Show tracked persistent goals\n" +
        "/tokencount \\- Show context token usage\n" +
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

bot.command("mode", async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }

    const text = ctx.message.text || "";
    const arg = text.split(" ").slice(1).join(" ").trim().toLowerCase();

    if (!arg) {
        await ctx.reply(`⚙️ Current mode: ${planningMode}\nUse: /mode fast | /mode auto | /mode autonomous`);
        return;
    }

    if (arg !== "fast" && arg !== "auto" && arg !== "autonomous") {
        await ctx.reply("Usage: /mode fast | /mode auto | /mode autonomous");
        return;
    }

    planningMode = arg;
    await ctx.reply(`⚙️ Mode set to: ${planningMode}`);
});

bot.command("wallet", async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }
    try {
        await performWalletAddress(ctx);
    } catch (err) {
        await ctx.reply(`❌ Wallet error: ${(err as Error).message}`);
    }
});

bot.command("balance", async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }
    try {
        const text = ctx.message.text || "";
        const token = text.split(" ").slice(1).join(" ").trim() || undefined;
        await performBalance(ctx, token);
    } catch (err) {
        await ctx.reply(`❌ Balance error: ${(err as Error).message}`);
    }
});

bot.command("rpc", async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }
    try {
        const status = await getNetworkStatus();
        await ctx.reply(`🌐 ${status}`);
    } catch (err) {
        await ctx.reply(`❌ RPC error: ${(err as Error).message}`);
    }
});

bot.command("tx", async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }
    try {
        const text = ctx.message.text || "";
        const hash = text.split(" ").slice(1).join(" ").trim();
        if (!hash) {
            await ctx.reply("Usage: /tx <transaction_hash>");
            return;
        }
        const report = await getTransactionStatus(hash);
        await ctx.reply(`🧾 ${report}`);
    } catch (err) {
        await ctx.reply(`❌ TX error: ${(err as Error).message}`);
    }
});

bot.command("update", async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }
    try {
        await performUpdate(ctx);
    } catch (err) {
        await ctx.reply(`❌ Update failed: ${(err as Error).message}`);
    }
});

bot.command("tokencount", async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }
    const snapshot = estimateTokenContext("", history, { planningMode });
    const lines = [
        `Token usage (${snapshot.countMode}):`,
        `Context: ${snapshot.contextTokens} / ${snapshot.threshold} (${snapshot.contextPercent}%)`,
        `Remaining before compaction: ${snapshot.remainingToThreshold}`,
    ];
    if (lastTokenUsage) {
        lines.push(
            `Last turn: context=${lastTokenUsage.contextTokens}, reply=${lastTokenUsage.replyTokens}, total=${lastTokenUsage.totalTokens}`
        );
    }
    await ctx.reply(lines.join("\n"));
});

bot.command("goals", async (ctx) => {
    if (!authCheck(ctx.chat.id.toString())) { ctx.reply("⛔️ Unauthorized."); return; }
    const goals = getGoalSnapshots(12);
    if (goals.length === 0) {
        await ctx.reply("No persistent goals tracked yet.");
        return;
    }

    const lines = ["Persistent goals:"];
    for (const g of goals) {
        lines.push(`- [${g.status}] ${g.title}`);
        lines.push(`  updated: ${g.updatedAt}`);
        lines.push(`  latest: ${g.latestProgress}`);
    }
    await ctx.reply(lines.join("\n"));
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
let planningMode: PlanningMode = "auto";
interface PendingSendDraft {
    to?: string;
    amount?: string;
}
let pendingSendDraft: PendingSendDraft | null = null;
let lastTokenUsage: TokenUsageEstimate | null = null;

function authCheck(chatId: string): boolean {
    return !ALLOWED_CHAT_ID || chatId === ALLOWED_CHAT_ID;
}

async function performWalletAddress(ctx: any): Promise<void> {
    const address = await getAddress();
    await ctx.reply(`👛 Wallet address: ${address}`);
}

async function performBalance(ctx: any, token?: string): Promise<void> {
    const balance = await getBalance(token);
    await ctx.reply(token ? `💰 Token balance: ${balance}` : `💰 ETH balance: ${balance}`);
}

function extractRecipientAddress(text: string): string | undefined {
    const addressMatch = text.match(/0x[a-fA-F0-9]{40}/);
    return addressMatch?.[0];
}

function extractAmount(text: string): string | undefined {
    const normalized = text.trim().toLowerCase();
    const canonical = normalized.replace(/[^\w.\s]/g, " ").replace(/\s+/g, " ").trim();

    if (/\b(max|all|maximum)\b/i.test(canonical)) return "max";

    // Accept numeric amount only when explicitly provided:
    // - "<amount> eth" inside a sentence, or
    // - amount-only message like "0.005"
    const withUnit = canonical.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*eth(?:\s|$)/i);
    if (withUnit) return withUnit[1];

    const amountOnly = canonical.match(/^(\d+(?:\.\d+)?)$/);
    if (amountOnly) return amountOnly[1];

    return undefined;
}

function isEthSendIntent(text: string): boolean {
    const hasSendSignal = /\b(send|transfer|payout)\b/i.test(text);
    const hasEthSignal = /\beth(?:ereum)?\b/i.test(text);
    const hasAddress = /0x[a-fA-F0-9]{40}/.test(text);
    return hasSendSignal && (hasEthSignal || hasAddress);
}

async function performSendEth(ctx: any, to: string, amount: string): Promise<void> {
    await ctx.reply(`Preparing transfer: ${amount} ETH to ${to}`);
    const result = await AVAILABLE_TOOLS.wallet_send({ to, amount });
    await ctx.reply(result);
}

async function performUpdate(ctx: any): Promise<void> {
    await ctx.reply("🔄 Checking for updates...");

    const { stdout } = await execAsync("git pull");
    if (stdout.includes("Already up to date")) {
        await ctx.reply("✅ Already up to date.");
        return;
    }

    await ctx.reply(`⬇️ Updates found:\n<pre>${stdout}</pre>\n\n📦 Installing dependencies...`, { parse_mode: "HTML" });
    await execAsync("npm install");

    await ctx.reply("♻️ Restarting to apply changes...");
    saveSession();
    process.exit(0); // PM2/systemd should restart us
}

function contentToText(userContent: string | ChatCompletionContentPart[]): string {
    if (typeof userContent === "string") return userContent;
    return userContent
        .map((p) => p.type === "text" ? p.text : "")
        .join(" ")
        .trim();
}

function isWalletBalanceIntent(text: string): boolean {
    const t = text.toLowerCase();
    return (
        t.includes("wallet balance") ||
        /\bbalance\b/.test(t) ||
        /\bbal\b/.test(t) ||
        /\beth balance\b/.test(t) ||
        /\bhow much eth\b/.test(t) ||
        /\bcheck\b.*\bbal(?:ance)?\b/.test(t) ||
        /\bwhat(?:'s| is)\s+(?:your|my)\s+bal(?:ance)?\b/.test(t) ||
        /\bwhat(?:'s| is)\s+your\s+balance\b/.test(t)
    );
}

async function routeDeterministicIntent(ctx: any, userContent: string | ChatCompletionContentPart[]): Promise<boolean> {
    const rawText = contentToText(userContent);
    const text = rawText.toLowerCase();
    if (!text) return false;

    if (/(^|\b)(switch to|set)(\s+)?autonomous mode(\b|$)/i.test(text)) {
        planningMode = "autonomous";
        await ctx.reply("⚙️ Mode set to: autonomous");
        return true;
    }

    if (/(^|\b)(switch to|set)(\s+)?fast mode(\b|$)/i.test(text)) {
        planningMode = "fast";
        await ctx.reply("⚙️ Mode set to: fast");
        return true;
    }

    if (/(^|\b)(switch to|set)(\s+)?auto mode(\b|$)/i.test(text)) {
        planningMode = "auto";
        await ctx.reply("⚙️ Mode set to: auto");
        return true;
    }

    const wantsUpdate =
        /(^|\b)(update yourself|self[- ]?update|update the agent|pull latest|update to latest|update now)(\b|$)/i.test(text);
    if (wantsUpdate) {
        await performUpdate(ctx);
        return true;
    }

    const wantsWalletAddress =
        (text.includes("wallet") && text.includes("address")) ||
        text.includes("what is your wallet");
    if (wantsWalletAddress) {
        await performWalletAddress(ctx);
        return true;
    }

    const wantsBalance = isWalletBalanceIntent(rawText);
    if (wantsBalance) {
        await performBalance(ctx);
        return true;
    }

    const parsedTo = extractRecipientAddress(rawText);
    const parsedAmount = extractAmount(rawText);
    const sendIntent = isEthSendIntent(rawText);

    if (sendIntent) {
        const draft: PendingSendDraft = pendingSendDraft ? { ...pendingSendDraft } : {};
        if (parsedTo) draft.to = parsedTo;
        if (parsedAmount) draft.amount = parsedAmount;
        pendingSendDraft = draft;
    }

    if (pendingSendDraft) {
        if (parsedTo) pendingSendDraft.to = parsedTo;
        if (parsedAmount) pendingSendDraft.amount = parsedAmount;

        if (!pendingSendDraft.to) {
            await ctx.reply("Send ETH: provide recipient address (0x...).");
            return true;
        }
        if (!pendingSendDraft.amount) {
            await ctx.reply(`Send ETH: provide amount or 'max' for ${pendingSendDraft.to}.`);
            return true;
        }

        try {
            const { to, amount } = pendingSendDraft;
            pendingSendDraft = null;
            await performSendEth(ctx, to, amount);
        } catch (err) {
            pendingSendDraft = null;
            await ctx.reply(`❌ Send error: ${(err as Error).message}`);
        }
        return true;
    }

    return false;
}

/** Send a prompt to the agent and reply in Telegram */
async function processAndReply(ctx: any, userContent: string | ChatCompletionContentPart[]) {
    if (isProcessing) {
        await ctx.reply("⏳ I'm still thinking… please wait.");
        return;
    }

    isProcessing = true;

    await ctx.sendChatAction("typing");

    try {
        if (await routeDeterministicIntent(ctx, userContent)) {
            history.push({ role: "user", content: userContent });
            while (history.length > 100) history.shift();
            return;
        }

        const apiHistory = history.map(m => ({ role: m.role, content: m.content }));
        const result = await runAgent(
            userContent,
            apiHistory as any,
            undefined,
            { planningMode }
        );

        lastTokenUsage = result.tokenUsage;
        const replyWithFooter = result.reply;

        history.push({ role: "user", content: userContent });
        history.push({ role: "assistant", content: replyWithFooter });
        pushSchedulerHistory({ role: "assistant", content: replyWithFooter });
        while (history.length > 100) history.shift();

        if (replyWithFooter.length > 4000) {
            const chunks = replyWithFooter.match(/.{1,4000}/gs) || [replyWithFooter];
            for (const chunk of chunks) await ctx.reply(chunk);
        } else {
            await ctx.reply(replyWithFooter);
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

    const normalized = text.trim().toLowerCase();
    const canonical = normalized.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    const approveWords = new Set(["approve", "approved", "yes"]);
    const denyWords = new Set(["deny", "no", "reject"]);
    const allowAllWords = new Set(["allow all", "always allow", "approve all"]);

    if (tgApproval.hasPending()) {
        if (allowAllWords.has(canonical)) {
            const resolved = tgApproval.resolveLatest("ALLOW_ALL");
            if (resolved) {
                await ctx.reply("✅ Approved.");
                return;
            }
        }

        if (approveWords.has(canonical)) {
            const resolved = tgApproval.resolveLatest("ALLOW");
            if (resolved) {
                await ctx.reply("✅ Approved.");
                return;
            }
        }

        if (denyWords.has(canonical)) {
            const resolved = tgApproval.resolveLatest("DENY");
            if (resolved) {
                await ctx.reply("🛑 Denied.");
                return;
            }
        }
    } else if (approveWords.has(canonical) || denyWords.has(canonical) || allowAllWords.has(canonical)) {
        await ctx.reply("No pending approval request right now.");
        return;
    }

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
            const isSearch = SEARCH_TRACE_TOOLS.has(evt.tool);
            const forceVisible = ALWAYS_VISIBLE_TOOL_CALLS.has(evt.tool);
            if (isSearch && !SHOW_SEARCH_TOOL_EVENTS && !forceVisible) return;
            bot.telegram.sendMessage(chatId, evt.label, { parse_mode: "HTML" }).catch(() => { });
            bot.telegram.sendChatAction(chatId, "typing").catch(() => { });
        });
        agentBus.on("tool:end", (evt: ToolEndEvent) => {
            // Wallet traces stay visible; Perplexity execution is always visible; other search traces are opt-in.
            const isWallet = evt.tool.startsWith("wallet_");
            const isSearch = SEARCH_TRACE_TOOLS.has(evt.tool);
            const forceVisible = ALWAYS_VISIBLE_TOOL_CALLS.has(evt.tool);
            const shouldTrace = isWallet || forceVisible || (SHOW_SEARCH_TOOL_EVENTS && isSearch);
            if (!shouldTrace) return;
            const state = evt.success ? "✅" : "❌";
            const preview = isWallet && evt.outputPreview ? `\n${evt.outputPreview}` : "";
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
