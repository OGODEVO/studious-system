import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import yaml from "js-yaml";

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
        temperature: number;
        max_tokens: number;
    };
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
        compaction_threshold: number;
        max_recent_episodes: number;
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

export const config = {
    // Secrets from .env only
    openaiKey: process.env.OPENAI_API_KEY ?? "",

    // From YAML (env can override)
    model: process.env.OASIS_MODEL ?? yamlConfig.system.model,
    temperature: yamlConfig.system.temperature,
    maxTokens: yamlConfig.system.max_tokens,

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
    memoryApiKey: yamlConfig.memory.extraction_api_key || process.env.OPENAI_API_KEY || "",
    memoryTemperature: yamlConfig.memory.extraction_temperature,
    memoryMaxTokens: yamlConfig.memory.extraction_max_tokens,
    extractEveryNTurns: yamlConfig.memory.extract_every_n_turns,
    compactionThreshold: yamlConfig.memory.compaction_threshold,
    maxRecentEpisodes: yamlConfig.memory.max_recent_episodes,
} as const;

if (!config.openaiKey) {
    console.error("❌  OPENAI_API_KEY is not set in oasis/.env");
    process.exit(1);
}
