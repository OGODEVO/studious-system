import { chromium, type Browser, type Page } from "playwright";
import { config } from "../utils/config.js";
import * as path from "path";
import * as fs from "fs";

let browser: Browser | null = null;
let page: Page | null = null;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function launchBrowser(): Promise<void> {
    if (browser) return;
    browser = await chromium.launch({ headless: config.headless });
    const context = await browser.newContext({
        viewport: config.viewport,
        userAgent: config.userAgent,
    });
    page = await context.newPage();
}

export async function closeBrowser(): Promise<void> {
    if (browser) {
        await browser.close();
        browser = null;
        page = null;
    }
}

function getPage(): Page {
    if (!page) throw new Error("Browser not initialized. Call ensureBrowser() first.");
    return page;
}

/**
 * Lazy browser initialization — called automatically by browser tools.
 * Safe to call multiple times; only launches once.
 */
export async function ensureBrowser(): Promise<void> {
    if (browser && page) return;
    await launchBrowser();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function navigate(args: { url: string }): Promise<string> {
    await ensureBrowser();
    const p = getPage();
    try {
        await p.goto(args.url, { waitUntil: "domcontentloaded", timeout: config.timeout });
    } catch (err) {
        return `Navigation error: ${(err as Error).message}`;
    }
    const title = await p.title();
    const snippet = await p.evaluate((maxChars: number) => {
        const el = document.querySelector("body");
        return el ? el.innerText.slice(0, maxChars) : "(empty page)";
    }, Math.min(config.extractMaxChars, 500));
    return `✅ Navigated to: ${p.url()}\nTitle: ${title}\n\n${snippet}`;
}

export async function click(args: { selector: string }): Promise<string> {
    await ensureBrowser();
    const p = getPage();
    try {
        await p.click(args.selector, { timeout: 5_000 });
        await p.waitForTimeout(500);
        return `✅ Clicked: ${args.selector}`;
    } catch (err) {
        return `Click failed on "${args.selector}": ${(err as Error).message}`;
    }
}

export async function typeText(args: {
    selector: string;
    text: string;
    submit?: boolean;
}): Promise<string> {
    await ensureBrowser();
    const p = getPage();
    try {
        await p.fill(args.selector, args.text, { timeout: 5_000 });
        if (args.submit) {
            await p.press(args.selector, "Enter");
            await p.waitForTimeout(1_000);
        }
        return `✅ Typed "${args.text}" into ${args.selector}${args.submit ? " and submitted" : ""}`;
    } catch (err) {
        return `Type failed on "${args.selector}": ${(err as Error).message}`;
    }
}

export async function extractText(args: { selector?: string }): Promise<string> {
    await ensureBrowser();
    const p = getPage();
    const maxChars = config.extractMaxChars;
    try {
        const sel = args.selector ?? "body";
        const text = await p.locator(sel).first().innerText({ timeout: 5_000 });
        const trimmed = text.slice(0, maxChars);
        return trimmed + (text.length > maxChars ? "\n\n...(truncated)" : "");
    } catch (err) {
        return `Extract failed: ${(err as Error).message}`;
    }
}

export async function screenshot(): Promise<string> {
    await ensureBrowser();
    const p = getPage();
    const dir = path.resolve("screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const filename = `screenshot_${Date.now()}.png`;
    const filepath = path.join(dir, filename);
    await p.screenshot({ path: filepath, fullPage: false });
    return `✅ Screenshot saved: ${filepath}`;
}

export async function getLinks(): Promise<string> {
    await ensureBrowser();
    const p = getPage();
    const maxLinks = config.maxLinks;
    const links = await p.evaluate((limit: number) => {
        return Array.from(document.querySelectorAll("a[href]"))
            .slice(0, limit)
            .map((a) => ({
                text: (a as HTMLAnchorElement).innerText.trim().slice(0, 60),
                href: (a as HTMLAnchorElement).href,
            }))
            .filter((l) => l.text && l.href);
    }, maxLinks);
    if (links.length === 0) return "No links found on page.";
    return links.map((l, i) => `${i + 1}. [${l.text}](${l.href})`).join("\n");
}

export async function searchGoogle(args: { query: string }): Promise<string> {
    await ensureBrowser();
    const p = getPage();
    const url = `https://www.google.com/search?q=${encodeURIComponent(args.query)}`;
    try {
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: config.timeout });
    } catch (err) {
        return `Search navigation error: ${(err as Error).message}`;
    }

    const maxResults = config.searchResults;
    const results = await p.evaluate((limit: number) => {
        const items = document.querySelectorAll("div.g");
        return Array.from(items)
            .slice(0, limit)
            .map((el) => {
                const titleEl = el.querySelector("h3");
                const linkEl = el.querySelector("a");
                const snippetEl = el.querySelector("[data-sncf], .VwiC3b, span.st");
                return {
                    title: titleEl?.textContent?.trim() ?? "",
                    url: (linkEl as HTMLAnchorElement)?.href ?? "",
                    snippet: snippetEl?.textContent?.trim().slice(0, 150) ?? "",
                };
            })
            .filter((r) => r.title && r.url);
    }, maxResults);

    if (results.length === 0) return "No search results found.";
    return results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");
}

export async function getCurrentUrl(): Promise<string> {
    await ensureBrowser();
    const p = getPage();
    return `Current URL: ${p.url()}\nTitle: ${await p.title()}`;
}
