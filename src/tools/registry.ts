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
import { runCommand, selfUpdate } from "./shell.js";

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
            name: "get_current_url",
            description: "Get the current page URL and title.",
            parameters: { type: "object", properties: {} },
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
            description: "Updates the agent's code from the git repository, installs dependencies, and restarts the process. Use when the user asks to update.",
            parameters: { type: "object", properties: {} },
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
    get_current_url: () => getCurrentUrl(),
    run_command: (a) => runCommand(a as { command: string }),
    self_update: () => selfUpdate(),
};
