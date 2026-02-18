import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Load YAML config
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../config/config.yaml"
);

interface OasisConfig {
    system: {
        model: string;
        provider?: string;
        api_key?: string; // Fallback / Legacy
        base_url?: string; // Fallback / Legacy
        temperature: number;
        context_window: number;
        max_output_tokens: number;
    };
    providers?: Record<string, {
        base_url: string;
        api_key?: string;
    }>;
    browser: {
        headless: boolean;
        viewport: { width: number; height: number };
        timeout: number;
        user_agent: string;
    };
    tools: {
        extract_max_chars: number;
        max_links: number;
        search_results: number;
    };
    memory: {
        extraction_model: string;
        extraction_base_url: string;
        extraction_api_key: string;
        extraction_temperature: number;
        extraction_max_tokens: number;
        extract_every_n_turns: number;
        // compaction_token_threshold is derived
        max_recent_episodes: number;
    };
    scheduler?: {
        enabled?: boolean;
        tick_seconds?: number;
        reminders?: Array<{
            id: string;
            enabled?: boolean;
            interval_minutes: number;
            lane?: "fast" | "slow" | "background";
            prompt: string;
        }>;
        heartbeat?: {
            enabled?: boolean;
            interval_minutes?: number;
            prompt?: string;
        };
    };
    perplexity?: {
        base_url?: string;
        max_results?: number;
        max_tokens_per_page?: number;
        country?: string;
    };
    wallet?: {
        network?: string;
        rpc_url?: string;
        expected_chain_id?: number;
    };
    moltbook?: {
        base_url?: string;
    };
}

function loadYamlConfig(): OasisConfig {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        return yaml.load(raw) as OasisConfig;
    } catch (err) {
        console.error(`❌  Failed to load config from ${CONFIG_PATH}: ${(err as Error).message}`);
        process.exit(1);
    }
}

const yamlConfig = loadYamlConfig();

// ---------------------------------------------------------------------------
// Merged config (YAML + env overrides)
// ---------------------------------------------------------------------------

const activeProvider = yamlConfig.system.provider;
const providerConfig = (activeProvider && yamlConfig.providers && yamlConfig.providers[activeProvider]) || undefined;

// Dynamic Env Key: e.g. "novita" -> "NOVITA_API_KEY"
const envKeyName = activeProvider
    ? `${activeProvider.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_API_KEY`
    : "OPENAI_API_KEY";
const envKey = process.env[envKeyName];
const resolvedPrimaryApiKey =
    providerConfig?.api_key ||
    yamlConfig.system.api_key ||
    envKey ||
    process.env.OPENAI_API_KEY ||
    "";
const walletExpectedChainIdRaw =
    process.env.OASIS_WALLET_CHAIN_ID ??
    (yamlConfig.wallet?.expected_chain_id !== undefined
        ? String(yamlConfig.wallet.expected_chain_id)
        : "");
const walletExpectedChainId =
    walletExpectedChainIdRaw && Number.isFinite(Number(walletExpectedChainIdRaw))
        ? Number(walletExpectedChainIdRaw)
        : undefined;

export const config = {
    // Secrets from .env or YAML
    // Priority: Provider Config > System Config > Provider Env Var > OPENAI_API_KEY
    openaiKey: resolvedPrimaryApiKey,
    openaiBaseUrl: providerConfig?.base_url || yamlConfig.system.base_url || undefined,

    // From YAML (env can override)
    model: process.env.OASIS_MODEL ?? yamlConfig.system.model,
    temperature: yamlConfig.system.temperature,
    maxTokens: Math.min(
        yamlConfig.system.max_output_tokens || 4096,
        yamlConfig.system.context_window || 128000
    ),
    contextWindow: yamlConfig.system.context_window || 128000,

    // Browser
    headless: process.env.OASIS_HEADLESS !== undefined
        ? process.env.OASIS_HEADLESS !== "false"
        : yamlConfig.browser.headless,
    viewport: yamlConfig.browser.viewport,
    timeout: yamlConfig.browser.timeout,
    userAgent: yamlConfig.browser.user_agent,

    // Tools
    extractMaxChars: yamlConfig.tools.extract_max_chars,
    maxLinks: yamlConfig.tools.max_links,
    searchResults: yamlConfig.tools.search_results,

    // Memory
    memoryModel: yamlConfig.memory.extraction_model,
    memoryBaseUrl: yamlConfig.memory.extraction_base_url || undefined,
    memoryApiKey: yamlConfig.memory.extraction_api_key || resolvedPrimaryApiKey,
    memoryTemperature: yamlConfig.memory.extraction_temperature,
    memoryMaxTokens: yamlConfig.memory.extraction_max_tokens,
    extractEveryNTurns: yamlConfig.memory.extract_every_n_turns,
    // Dynamic compaction threshold: 90% of context window (leaves ~10% buffer for output)
    compactionTokenThreshold: Math.floor((yamlConfig.system.context_window || 128000) * 0.9),
    maxRecentEpisodes: yamlConfig.memory.max_recent_episodes,

    // Scheduler
    scheduler: {
        enabled: yamlConfig.scheduler?.enabled ?? true,
        tickSeconds: yamlConfig.scheduler?.tick_seconds ?? 15,
        reminders: (yamlConfig.scheduler?.reminders ?? []).map((r) => ({
            id: r.id,
            enabled: r.enabled ?? true,
            intervalMinutes: r.interval_minutes,
            lane: r.lane ?? "background",
            prompt: r.prompt,
        })),
        heartbeat: {
            enabled: yamlConfig.scheduler?.heartbeat?.enabled ?? true,
            intervalMinutes: yamlConfig.scheduler?.heartbeat?.interval_minutes ?? 30,
            prompt:
                yamlConfig.scheduler?.heartbeat?.prompt ??
                "Heartbeat check-in: review queue health, pending tasks, and blockers; then report only actionable next steps.",
        },
    },

    // Perplexity Search
    perplexityApiKey: process.env.PERPLEXITY_API_KEY || "",
    perplexityBaseUrl:
        process.env.PERPLEXITY_BASE_URL ||
        yamlConfig.perplexity?.base_url ||
        "https://api.perplexity.ai",
    perplexityMaxResults: yamlConfig.perplexity?.max_results ?? 5,
    perplexityMaxTokensPerPage: yamlConfig.perplexity?.max_tokens_per_page ?? 4096,
    perplexityCountry: yamlConfig.perplexity?.country ?? "US",

    // Wallet network/rpc
    walletNetwork: (process.env.OASIS_WALLET_NETWORK || yamlConfig.wallet?.network || "base").toLowerCase(),
    walletRpcUrl: process.env.ETH_RPC_URL || yamlConfig.wallet?.rpc_url || "",
    walletExpectedChainId,

    // Moltbook
    moltbookApiKey: process.env.MOLTBOOK_API_KEY || "",
    moltbookBaseUrl:
        process.env.MOLTBOOK_BASE_URL ||
        yamlConfig.moltbook?.base_url ||
        "https://www.moltbook.com/api/v1",
} as const;

if (!config.openaiKey) {
    console.error("❌  OPENAI_API_KEY is not set in oasis/.env");
    process.exit(1);
}
