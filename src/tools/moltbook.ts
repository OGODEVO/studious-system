import { config } from "../utils/config.js";

const REQUIRED_PROTOCOL = "https:";
const REQUIRED_HOSTNAME = "www.moltbook.com";
const REQUIRED_BASE_PATH = "/api/v1";

interface MoltbookRegisterArgs {
    name: string;
    description?: string;
}

interface MoltbookPostArgs {
    submolt: string;
    title: string;
    content?: string;
    url?: string;
}

interface MoltbookCommentArgs {
    post_id: string;
    content: string;
    parent_id?: string;
}

interface MoltbookUpvoteArgs {
    post_id: string;
}

interface MoltbookFeedArgs {
    sort?: "hot" | "new" | "top" | "rising";
    limit?: number;
    submolt?: string;
}

function getValidatedBaseUrl(): string {
    const raw = (config.moltbookBaseUrl || "").trim();
    const fallback = "https://www.moltbook.com/api/v1";
    const value = raw || fallback;

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Invalid Moltbook base URL.");
    }

    const normalizedPath = url.pathname.replace(/\/+$/, "");
    const isValid =
        url.protocol === REQUIRED_PROTOCOL &&
        url.hostname === REQUIRED_HOSTNAME &&
        normalizedPath === REQUIRED_BASE_PATH;

    if (!isValid) {
        throw new Error("Security guard: Moltbook base URL must be https://www.moltbook.com/api/v1");
    }

    return `${url.origin}${REQUIRED_BASE_PATH}`;
}

function buildApiUrl(endpoint: string, query?: URLSearchParams): string {
    const base = getValidatedBaseUrl();
    const safeEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const url = new URL(base + safeEndpoint);

    if (query) {
        url.search = query.toString();
    }

    const pathOk = url.pathname.startsWith(`${REQUIRED_BASE_PATH}/`) || url.pathname === REQUIRED_BASE_PATH;
    const hostOk = url.protocol === REQUIRED_PROTOCOL && url.hostname === REQUIRED_HOSTNAME;
    if (!hostOk || !pathOk) {
        throw new Error("Security guard: refusing non-Moltbook request target.");
    }

    return url.toString();
}

function requireApiKey(): string {
    const key = (config.moltbookApiKey || "").trim();
    if (!key) {
        throw new Error("MOLTBOOK_API_KEY is not configured.");
    }
    return key;
}

function summarizeData(data: unknown, fallback = "ok"): string {
    if (data === null || data === undefined) return fallback;
    if (typeof data === "string") return data;
    try {
        return JSON.stringify(data, null, 2).slice(0, 2000);
    } catch {
        return fallback;
    }
}

async function moltbookRequest(
    method: "GET" | "POST",
    endpoint: string,
    options?: {
        requireAuth?: boolean;
        body?: Record<string, unknown>;
        query?: URLSearchParams;
    }
): Promise<unknown> {
    const requireAuth = options?.requireAuth !== false;
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };

    if (requireAuth) {
        headers.Authorization = `Bearer ${requireApiKey()}`;
    }

    const url = buildApiUrl(endpoint, options?.query);
    const response = await fetch(url, {
        method,
        headers,
        body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    let payload: unknown = text;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        // keep text fallback
    }

    if (!response.ok) {
        const details = summarizeData(payload, text || response.statusText);
        throw new Error(`Moltbook API ${response.status}: ${details}`);
    }

    return payload;
}

export async function moltbookRegister(args: MoltbookRegisterArgs): Promise<string> {
    const name = (args.name || "").trim();
    if (!name) {
        return "Error: name is required.";
    }

    const description = (args.description || "").trim();
    const payload = await moltbookRequest("POST", "/agents/register", {
        requireAuth: false,
        body: {
            name,
            ...(description ? { description } : {}),
        },
    });

    const p = payload as Record<string, unknown> | null;
    const agent = (p?.agent || {}) as Record<string, unknown>;
    const claimUrl = typeof agent.claim_url === "string" ? agent.claim_url : "(missing)";
    const verification = typeof agent.verification_code === "string" ? agent.verification_code : "(missing)";
    const apiKey = typeof agent.api_key === "string" ? agent.api_key : "(missing)";

    return [
        "Moltbook agent registered.",
        `claim_url: ${claimUrl}`,
        `verification_code: ${verification}`,
        `api_key: ${apiKey}`,
        "Important: save the API key securely as MOLTBOOK_API_KEY.",
    ].join("\n");
}

export async function moltbookMe(): Promise<string> {
    const payload = await moltbookRequest("GET", "/agents/me");
    return `Moltbook me:\n${summarizeData(payload)}`;
}

export async function moltbookStatus(): Promise<string> {
    const payload = await moltbookRequest("GET", "/agents/status");
    return `Moltbook status:\n${summarizeData(payload)}`;
}

export async function moltbookPost(args: MoltbookPostArgs): Promise<string> {
    const submolt = (args.submolt || "").trim();
    const title = (args.title || "").trim();
    const content = (args.content || "").trim();
    const rawUrl = (args.url || "").trim();

    if (!submolt) return "Error: submolt is required.";
    if (!title) return "Error: title is required.";
    if (!content && !rawUrl) return "Error: provide content or url.";

    let safeUrl: string | undefined;
    if (rawUrl) {
        try {
            const parsed = new URL(rawUrl);
            if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
                return "Error: url must use http/https.";
            }
            safeUrl = parsed.toString();
        } catch {
            return "Error: invalid url.";
        }
    }

    const payload = await moltbookRequest("POST", "/posts", {
        body: {
            submolt,
            title,
            ...(content ? { content } : {}),
            ...(safeUrl ? { url: safeUrl } : {}),
        },
    });

    return `Moltbook post created:\n${summarizeData(payload)}`;
}

export async function moltbookComment(args: MoltbookCommentArgs): Promise<string> {
    const postId = (args.post_id || "").trim();
    const content = (args.content || "").trim();
    const parentId = (args.parent_id || "").trim();

    if (!postId) return "Error: post_id is required.";
    if (!content) return "Error: content is required.";

    const payload = await moltbookRequest("POST", `/posts/${encodeURIComponent(postId)}/comments`, {
        body: {
            content,
            ...(parentId ? { parent_id: parentId } : {}),
        },
    });

    return `Moltbook comment created:\n${summarizeData(payload)}`;
}

export async function moltbookUpvote(args: MoltbookUpvoteArgs): Promise<string> {
    const postId = (args.post_id || "").trim();
    if (!postId) return "Error: post_id is required.";

    const payload = await moltbookRequest("POST", `/posts/${encodeURIComponent(postId)}/upvote`);
    return `Moltbook upvote sent:\n${summarizeData(payload)}`;
}

export async function moltbookFeed(args: MoltbookFeedArgs = {}): Promise<string> {
    const query = new URLSearchParams();
    const sort = args.sort || "hot";
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit as number))) : 25;
    const submolt = (args.submolt || "").trim();

    query.set("sort", sort);
    query.set("limit", String(limit));
    if (submolt) query.set("submolt", submolt);

    const payload = await moltbookRequest("GET", "/posts", { query });
    const normalized = payload as Record<string, unknown> | unknown[];

    const posts =
        Array.isArray(normalized)
            ? normalized
            : Array.isArray((normalized as Record<string, unknown>)?.posts)
                ? ((normalized as Record<string, unknown>).posts as unknown[])
                : [];

    if (!posts.length) {
        return `Moltbook feed returned no posts (sort=${sort}, limit=${limit}${submolt ? `, submolt=${submolt}` : ""}).`;
    }

    const lines = posts.slice(0, 10).map((p, i) => {
        const post = (p || {}) as Record<string, unknown>;
        const id = String(post.id ?? post.post_id ?? "unknown");
        const title = String(post.title ?? "(no title)");
        const community = String(post.submolt ?? post.community ?? "general");
        const score = post.score ?? post.upvotes ?? "n/a";
        return `${i + 1}. [${community}] ${title} (id=${id}, score=${score})`;
    });

    return [
        `Moltbook feed (sort=${sort}, limit=${limit}${submolt ? `, submolt=${submolt}` : ""}):`,
        ...lines,
    ].join("\n");
}
