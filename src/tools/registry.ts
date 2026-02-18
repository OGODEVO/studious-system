import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
    navigate,
    click,
    typeText,
    extractText,
    screenshot,
    getLinks,
    searchGoogle,
    getCurrentUrl,
} from "./browser.js";
import { perplexitySearch } from "./perplexity.js";
import {
    moltbookRegister,
    moltbookMe,
    moltbookStatus,
    moltbookPost,
    moltbookComment,
    moltbookUpvote,
    moltbookFeed,
} from "./moltbook.js";
import { runCommand, selfUpdate, getApprovalInterface } from "./shell.js";
import {
    getAddress,
    getBalance,
    sendTransaction,
    callContract,
    normalizeSendAmount,
    normalizeRecipientAddress,
} from "./wallet.js";
import {
    getHeartbeatStatus,
    setHeartbeat,
    disableHeartbeat,
    scheduleOneTimeReminderInMinutes,
    scheduleOneTimeReminderAt,
    listOneTimeReminders,
    cancelOneTimeReminder,
} from "../runtime/scheduler.js";
import { writeGoalEntry, writeMemoryEntry } from "../memory/manager.js";
import type { LaneName } from "../runtime/taskQueue.js";

// ---------------------------------------------------------------------------
// Schema — exposed to OpenAI function calling
// ---------------------------------------------------------------------------

export const TOOLS_SCHEMA: ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "navigate",
            description: "Navigate the browser to a URL. Returns page title and a text snippet.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "Full URL to navigate to (include https://)" },
                },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "click",
            description: "Click an element on the page by CSS selector.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector of the element to click" },
                },
                required: ["selector"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "type_text",
            description: "Type text into an input field. Optionally press Enter to submit.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector of the input element" },
                    text: { type: "string", description: "Text to type" },
                    submit: { type: "boolean", description: "Press Enter after typing (default: false)" },
                },
                required: ["selector", "text"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "extract_text",
            description:
                "Extract visible text from the page. Optionally target a specific element with a CSS selector. Returns up to 3000 chars.",
            parameters: {
                type: "object",
                properties: {
                    selector: {
                        type: "string",
                        description: "CSS selector to extract from (default: entire page body)",
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "screenshot",
            description: "Take a screenshot of the current page and save it locally. Returns the file path.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "get_links",
            description: "Get the first 30 links on the current page with their text and URLs.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "search_google",
            description: "Search Google for a query and return the top 8 results with titles, URLs, and snippets.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "perplexity_search",
            description:
                "Real-time web search via Perplexity Search API. Prefer this over browser automation for fast current-events lookups.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Single search query" },
                    queries: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional multi-query search (use instead of query)",
                    },
                    max_results: {
                        type: "number",
                        description: "Number of results per query (1-20)",
                    },
                    max_tokens_per_page: {
                        type: "number",
                        description: "Maximum tokens to extract per page",
                    },
                    country: {
                        type: "string",
                        description: "ISO 3166-1 alpha-2 country code (e.g. US, GB)",
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_current_url",
            description: "Get the current page URL and title.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "moltbook_register",
            description: "Register a new Moltbook agent and receive api_key/claim_url/verification_code.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Agent display name." },
                    description: { type: "string", description: "Optional agent description." },
                },
                required: ["name"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "moltbook_me",
            description: "Fetch the current Moltbook agent profile (requires MOLTBOOK_API_KEY).",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "moltbook_status",
            description: "Fetch Moltbook claim status (pending_claim/claimed).",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "moltbook_post",
            description: "Create a Moltbook post (text and/or link).",
            parameters: {
                type: "object",
                properties: {
                    submolt: { type: "string", description: "Community slug, e.g. general." },
                    title: { type: "string", description: "Post title." },
                    content: { type: "string", description: "Text body content." },
                    url: { type: "string", description: "Optional link for a link post." },
                },
                required: ["submolt", "title"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "moltbook_comment",
            description: "Create a comment on a Moltbook post, optionally as a reply.",
            parameters: {
                type: "object",
                properties: {
                    post_id: { type: "string", description: "Target post id." },
                    content: { type: "string", description: "Comment body." },
                    parent_id: { type: "string", description: "Optional parent comment id for replies." },
                },
                required: ["post_id", "content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "moltbook_upvote",
            description: "Upvote a Moltbook post.",
            parameters: {
                type: "object",
                properties: {
                    post_id: { type: "string", description: "Target post id." },
                },
                required: ["post_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "moltbook_feed",
            description: "Read Moltbook feed posts.",
            parameters: {
                type: "object",
                properties: {
                    sort: {
                        type: "string",
                        enum: ["hot", "new", "top", "rising"],
                        description: "Feed sort order.",
                    },
                    limit: { type: "number", description: "Result size (1-50)." },
                    submolt: { type: "string", description: "Optional community filter." },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "run_command",
            description: "Execute a shell command. Use for git, npm, file operations. REQUIRES USER APPROVAL.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "The command to execute (e.g. 'git status', 'npm test')" },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "self_update",
            description:
                "Update agent code to the latest pushed commit on a target remote/branch (or a specific ref), then restart. Uses fast-forward-only update semantics.",
            parameters: {
                type: "object",
                properties: {
                    remote: { type: "string", description: "Git remote name (default: origin)" },
                    branch: { type: "string", description: "Target branch name (default: current branch)" },
                    ref: { type: "string", description: "Optional specific commit/tag/ref to fast-forward merge" },
                    install: { type: "boolean", description: "Run npm install after update (default: true)" },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "heartbeat_status",
            description: "Get current heartbeat scheduler status (enabled, interval, prompt).",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "heartbeat_set",
            description: "Enable/update heartbeat interval (minutes) and optional prompt.",
            parameters: {
                type: "object",
                properties: {
                    interval_minutes: { type: "number", description: "Heartbeat interval in minutes (>=1)" },
                    prompt: { type: "string", description: "Optional custom heartbeat prompt" },
                },
                required: ["interval_minutes"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "heartbeat_disable",
            description: "Disable heartbeat scheduler.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "reminder_once_in",
            description: "Schedule a one-time internal reminder for the agent to run after N minutes (agent-only cron style).",
            parameters: {
                type: "object",
                properties: {
                    minutes: { type: "number", description: "Delay in minutes (>0)." },
                    prompt: { type: "string", description: "Task prompt to run when due." },
                    lane: {
                        type: "string",
                        enum: ["fast", "slow", "background"],
                        description: "Optional scheduler lane (default: background).",
                    },
                },
                required: ["minutes", "prompt"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "reminder_once_at",
            description: "Schedule a one-time internal reminder for a specific ISO datetime (agent-only cron style).",
            parameters: {
                type: "object",
                properties: {
                    run_at_iso: { type: "string", description: "UTC or offset ISO timestamp (e.g. 2026-02-19T14:30:00Z)." },
                    prompt: { type: "string", description: "Task prompt to run when due." },
                    lane: {
                        type: "string",
                        enum: ["fast", "slow", "background"],
                        description: "Optional scheduler lane (default: background).",
                    },
                },
                required: ["run_at_iso", "prompt"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "reminder_once_list",
            description: "List pending one-time internal reminders.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "reminder_once_cancel",
            description: "Cancel a pending one-time internal reminder by id.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Reminder id returned by reminder_once_in/at/list." },
                },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "memory_write",
            description: "Persist durable memory notes. Use for stable user facts/preferences/workflow rules worth keeping across sessions.",
            parameters: {
                type: "object",
                properties: {
                    store: {
                        type: "string",
                        enum: ["semantic", "procedural"],
                        description: "Target memory store.",
                    },
                    content: {
                        type: "string",
                        description: "Concise durable memory note.",
                    },
                    section: {
                        type: "string",
                        description: "Optional markdown section name. Defaults by store.",
                    },
                },
                required: ["store", "content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "goal_write",
            description: "Create or update persistent goal state. Use to track mission progress and completion over time.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Goal title." },
                    progress: { type: "string", description: "Optional progress update note." },
                    status: {
                        type: "string",
                        enum: ["active", "completed", "paused", "cancelled"],
                        description: "Optional goal status.",
                    },
                    tags: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional tags for grouping/search.",
                    },
                },
                required: ["title"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "wallet_address",
            description: "Returns the agent's own ETH wallet public address. MUST be called whenever the user asks for wallet address; do not infer or reuse stale values.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "wallet_balance",
            description: "Checks the ETH balance of the agent's wallet. Optionally pass a token contract address to check an ERC-20 token balance.",
            parameters: {
                type: "object",
                properties: {
                    token: { type: "string", description: "Optional ERC-20 contract address" },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "wallet_send",
            description: "Sends ETH or an ERC-20 token from the agent's wallet. Accepts amount as a number string or 'max'. ALWAYS requires explicit owner approval via Telegram.",
            parameters: {
                type: "object",
                properties: {
                    to: { type: "string", description: "Recipient address (0x...)" },
                    amount: { type: "string", description: "Amount to send (e.g. '0.01')" },
                    token: { type: "string", description: "Optional ERC-20 contract address. Omit for native ETH." },
                },
                required: ["to", "amount"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "wallet_call_contract",
            description: "Interact with any smart contract. Can read state (view/pure functions) or write (state-changing — requires approval). Provide the ABI fragment, function name, and arguments.",
            parameters: {
                type: "object",
                properties: {
                    contract_address: { type: "string", description: "The smart contract address" },
                    abi: { type: "string", description: "JSON ABI fragment (array of function defs)" },
                    function_name: { type: "string", description: "Function to call" },
                    args: { type: "array", items: { type: "string" }, description: "Function arguments" },
                    value: { type: "string", description: "ETH to send (for payable functions)" },
                },
                required: ["contract_address", "abi", "function_name"],
            },
        },
    },
];

// ---------------------------------------------------------------------------
// Dispatch — maps function names to implementations
// ---------------------------------------------------------------------------

type ToolFn = (args: Record<string, unknown>) => Promise<string>;

export const AVAILABLE_TOOLS: Record<string, ToolFn> = {
    navigate: (a) => navigate(a as { url: string }),
    click: (a) => click(a as { selector: string }),
    type_text: (a) => typeText(a as { selector: string; text: string; submit?: boolean }),
    extract_text: (a) => extractText(a as { selector?: string }),
    screenshot: () => screenshot(),
    get_links: () => getLinks(),
    search_google: (a) => searchGoogle(a as { query: string }),
    perplexity_search: (a) =>
        perplexitySearch(
            a as {
                query?: string;
                queries?: string[];
                max_results?: number;
                max_tokens_per_page?: number;
                country?: string;
            }
        ),
    get_current_url: () => getCurrentUrl(),
    moltbook_register: (a) => moltbookRegister(a as { name: string; description?: string }),
    moltbook_me: () => moltbookMe(),
    moltbook_status: () => moltbookStatus(),
    moltbook_post: (a) =>
        moltbookPost(
            a as {
                submolt: string;
                title: string;
                content?: string;
                url?: string;
            }
        ),
    moltbook_comment: (a) =>
        moltbookComment(
            a as {
                post_id: string;
                content: string;
                parent_id?: string;
            }
        ),
    moltbook_upvote: (a) => moltbookUpvote(a as { post_id: string }),
    moltbook_feed: (a) =>
        moltbookFeed(
            a as {
                sort?: "hot" | "new" | "top" | "rising";
                limit?: number;
                submolt?: string;
            }
        ),
    run_command: (a) => runCommand(a as { command: string }),
    self_update: (a) =>
        selfUpdate(
            a as {
                remote?: string;
                branch?: string;
                ref?: string;
                install?: boolean;
            }
        ),
    heartbeat_status: async () => {
        const hb = getHeartbeatStatus();
        return `Heartbeat: ${hb.enabled ? "ON" : "OFF"} | interval: ${hb.intervalMinutes} minute(s) | prompt: ${hb.prompt}`;
    },
    heartbeat_set: async (a) => {
        const { interval_minutes, prompt } = a as { interval_minutes: number; prompt?: string };
        if (!Number.isFinite(interval_minutes) || interval_minutes < 1) {
            return "Error: interval_minutes must be a number >= 1.";
        }
        setHeartbeat(interval_minutes, prompt);
        const hb = getHeartbeatStatus();
        return `Heartbeat updated: ON every ${hb.intervalMinutes} minute(s).`;
    },
    heartbeat_disable: async () => {
        disableHeartbeat();
        return "Heartbeat disabled.";
    },
    reminder_once_in: async (a) => {
        const { minutes, prompt, lane } = a as {
            minutes: number;
            prompt: string;
            lane?: LaneName;
        };
        if (!Number.isFinite(minutes) || minutes <= 0) {
            return "Error: minutes must be > 0.";
        }
        if (!prompt || !prompt.trim()) {
            return "Error: prompt is required.";
        }
        const selectedLane: LaneName =
            lane === "fast" || lane === "slow" || lane === "background"
                ? lane
                : "background";
        const id = scheduleOneTimeReminderInMinutes(minutes, prompt, selectedLane);
        return `One-time reminder scheduled: ${id} (in ${minutes} min, lane=${selectedLane}).`;
    },
    reminder_once_at: async (a) => {
        const { run_at_iso, prompt, lane } = a as {
            run_at_iso: string;
            prompt: string;
            lane?: LaneName;
        };
        if (!run_at_iso || !run_at_iso.trim()) {
            return "Error: run_at_iso is required.";
        }
        const ts = Date.parse(run_at_iso);
        if (!Number.isFinite(ts)) {
            return "Error: run_at_iso must be a valid ISO datetime.";
        }
        if (!prompt || !prompt.trim()) {
            return "Error: prompt is required.";
        }
        const selectedLane: LaneName =
            lane === "fast" || lane === "slow" || lane === "background"
                ? lane
                : "background";
        const id = scheduleOneTimeReminderAt(ts, prompt, selectedLane);
        return `One-time reminder scheduled: ${id} (at ${new Date(ts).toISOString()}, lane=${selectedLane}).`;
    },
    reminder_once_list: async () => {
        const reminders = listOneTimeReminders();
        if (reminders.length === 0) {
            return "No pending one-time reminders.";
        }
        return reminders
            .map((r, i) => {
                const dueMin = Math.ceil(r.dueInMs / 60000);
                return `${i + 1}. ${r.id} | lane=${r.lane} | run_at=${new Date(r.runAtMs).toISOString()} | due_in=${dueMin}m | ${r.prompt}`;
            })
            .join("\n");
    },
    reminder_once_cancel: async (a) => {
        const { id } = a as { id: string };
        if (!id || !id.trim()) {
            return "Error: id is required.";
        }
        const ok = cancelOneTimeReminder(id.trim());
        return ok ? `Cancelled one-time reminder: ${id.trim()}` : `Reminder not found: ${id.trim()}`;
    },
    memory_write: async (a) => {
        const { store, content, section } = a as {
            store: "semantic" | "procedural";
            content: string;
            section?: string;
        };
        return writeMemoryEntry({ store, content, section });
    },
    goal_write: async (a) => {
        const { title, progress, status, tags } = a as {
            title: string;
            progress?: string;
            status?: "active" | "completed" | "paused" | "cancelled";
            tags?: string[];
        };
        return writeGoalEntry({ title, progress, status, tags });
    },
    wallet_address: async () => {
        const addr = await getAddress();
        return `Wallet address: ${addr}`;
    },
    wallet_balance: async (a) => {
        const balance = await getBalance((a as { token?: string }).token);
        return `Balance: ${balance}`;
    },
    wallet_send: async (a) => {
        const { to, amount, token } = a as { to: string; amount: string; token?: string };
        const recipient = normalizeRecipientAddress(to);
        const resolvedAmount = await normalizeSendAmount(amount, token);
        const desc = token
            ? `Send ${resolvedAmount} tokens (${token}) to ${recipient}`
            : `Send ${resolvedAmount} ETH to ${recipient}`;

        // FORCED approval — always ask, even if Global Allow is on
        const iface = getApprovalInterface();
        const approved = await iface.requestApproval(desc);
        if (!approved) return "Transaction REJECTED by owner.";

        const txHash = await sendTransaction(recipient, resolvedAmount, token);
        return `Transaction sent! TX hash: ${txHash}`;
    },
    wallet_call_contract: async (a) => {
        const { contract_address, abi, function_name, args, value } = a as {
            contract_address: string; abi: string; function_name: string;
            args?: string[]; value?: string;
        };

        // Check if it's a write call by peeking at the ABI
        const parsedAbi = JSON.parse(abi);
        const fnDef = parsedAbi.find((f: any) => f.name === function_name);
        const isWrite = fnDef && fnDef.stateMutability !== "view" && fnDef.stateMutability !== "pure";

        if (isWrite) {
            const iface = getApprovalInterface();
            const approved = await iface.requestApproval(
                `Contract call: ${function_name}() on ${contract_address}${value ? ` (sending ${value} ETH)` : ""}`
            );
            if (!approved) return "Contract call REJECTED by owner.";
        }

        return await callContract(contract_address, abi, function_name, args || [], value);
    },
};
