import { config } from "../utils/config.js";

interface PerplexityResult {
    title?: string;
    url?: string;
    snippet?: string;
    date?: string;
    last_updated?: string;
}

interface PerplexityResponse {
    id?: string;
    results?: PerplexityResult[] | PerplexityResult[][];
}

interface PerplexitySearchArgs {
    query?: string;
    queries?: string[];
    max_results?: number;
    max_tokens_per_page?: number;
    country?: string;
}

function normalizeQueries(args: PerplexitySearchArgs): string | string[] {
    if (args.queries && args.queries.length > 0) {
        return args.queries.map((q) => q.trim()).filter(Boolean);
    }

    if (args.query && args.query.trim()) {
        return args.query.trim();
    }

    throw new Error("Provide either 'query' or 'queries'.");
}

function formatResult(item: PerplexityResult, index: number): string {
    const title = item.title || "(untitled)";
    const url = item.url || "(no url)";
    const snippet = item.snippet?.trim() || "(no snippet)";
    const date = item.date ? ` | date: ${item.date}` : "";
    const updated = item.last_updated ? ` | updated: ${item.last_updated}` : "";
    return `${index + 1}. **${title}**\n   ${url}${date}${updated}\n   ${snippet}`;
}

function formatResults(results: PerplexityResponse["results"]): string {
    if (!results || results.length === 0) {
        return "No results found.";
    }

    // Multi-query response: results is PerplexityResult[][]
    if (Array.isArray(results[0])) {
        const groups = results as PerplexityResult[][];
        return groups
            .map((group, i) => {
                const body = group.map((item, idx) => formatResult(item, idx)).join("\n\n");
                return `Query ${i + 1}:\n${body || "No results."}`;
            })
            .join("\n\n---\n\n");
    }

    // Single-query response: results is PerplexityResult[]
    return (results as PerplexityResult[])
        .map((item, idx) => formatResult(item, idx))
        .join("\n\n");
}

export async function perplexitySearch(args: PerplexitySearchArgs): Promise<string> {
    if (!config.perplexityApiKey) {
        return "Perplexity API key is missing. Set PERPLEXITY_API_KEY in your environment.";
    }

    let query: string | string[];
    try {
        query = normalizeQueries(args);
    } catch (err) {
        return `Perplexity search error: ${(err as Error).message}`;
    }

    const payload = {
        query,
        max_results: Math.max(1, Math.min(20, args.max_results ?? config.perplexityMaxResults)),
        max_tokens_per_page: args.max_tokens_per_page ?? config.perplexityMaxTokensPerPage,
        country: (args.country || config.perplexityCountry || "").toUpperCase() || undefined,
    };

    try {
        const response = await fetch(`${config.perplexityBaseUrl}/search`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.perplexityApiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const text = await response.text();
            return `Perplexity API error ${response.status}: ${text}`;
        }

        const data = (await response.json()) as PerplexityResponse;
        const formatted = formatResults(data.results);
        const idLine = data.id ? `Search ID: ${data.id}\n\n` : "";
        return idLine + formatted;
    } catch (err) {
        return `Perplexity search failed: ${(err as Error).message}`;
    }
}
