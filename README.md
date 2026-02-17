# Oasis Agent

Autonomous agent runtime with:
- browser automation (Playwright)
- real-time search (Perplexity Search API)
- queue lanes + scheduler/heartbeat
- TUI and web dashboard interfaces

## Quick Start

```bash
cd studious-system
npm install
cp .env.example .env
# edit .env and set keys
```

Run TUI:

```bash
npm start
```

Run web dashboard:

```bash
npm run web
# open http://localhost:3000
```

## Environment

Required:

```bash
OPENAI_API_KEY=...
```

Optional (based on provider/tooling):

```bash
NOVITA_API_KEY=...
PERPLEXITY_API_KEY=...
PERPLEXITY_BASE_URL=https://api.perplexity.ai
OASIS_WALLET_NETWORK=base
ETH_RPC_URL=https://mainnet.base.org
OASIS_WALLET_CHAIN_ID=8453
WALLET_PRIVATE_KEY=0x...
```

## Perplexity Search vs Browser Automation

Use `perplexity_search` when you need fast, current web retrieval (ranked sources/snippets) and no page interaction.

Use browser tools (`navigate`, `click`, `type_text`, `extract_text`, `screenshot`) when you need to interact with pages, inspect rendered UI state, or capture screenshots.

Recommended flow:
1. Start with `perplexity_search` for discovery.
2. Escalate to browser automation only when interaction/verification is needed.

Runtime routing behavior:
- Tool selection stays non-deterministic (`tool_choice: auto`).
- The agent injects a per-request routing hint:
  - realtime/current facts -> prefer `perplexity_search`
  - explicit Google SERP intent -> prefer `search_google`
  - interaction/rendered-page tasks -> prefer browser tools
- Tool-integrity guard:
  - if the reply claims Perplexity usage without an actual in-turn call, the agent auto-runs `perplexity_search` and appends a verified correction block
  - replies include `Tools executed this turn: ...` for quick traceability

## Scheduler and Heartbeat

Scheduler config lives in `config/config.yaml` under `scheduler`.

Runtime commands:
- `/heartbeat` (show status)
- `/heartbeat 30` (set 30-minute heartbeat)
- `/heartbeat off` (disable)
- `/grade` (resilience scorecard)

Telegram planning modes:
- `/mode fast` → instant responses, no execution-plan generation
- `/mode auto` → generate plans only for likely multi-step tasks
- `/mode autonomous` → always generate an execution plan first

Agent heartbeat tools (LLM-callable):
- `heartbeat_status`
- `heartbeat_set(interval_minutes, prompt?)`
- `heartbeat_disable`

Update behavior:
- `self_update` supports `remote`, `branch`, optional `ref`, and `install`.
- Default update target is latest pushed commit on `origin/<current-branch>` via fast-forward only.
- Returns a before/after commit hash report.

## Wallet Tool Reliability

If the agent ever returns an incorrect wallet value in chat, treat it as a tool-usage miss (model answered without calling wallet tools), not as a canonical source of truth.

Canonical path:
- `wallet_address` for address
- `wallet_balance` for balances

The agent prompt/tool schema is configured to force wallet tool calls for wallet-specific questions.

Telegram runtime also emits explicit `wallet_*` tool completion traces (with output preview) so you can verify executed tool results separately from assistant prose.

## Wallet Network (Base vs Ethereum)

Default is Base mainnet.

- `OASIS_WALLET_NETWORK=base`
- `ETH_RPC_URL=https://mainnet.base.org`
- `OASIS_WALLET_CHAIN_ID=8453`

Clean switch to Ethereum mainnet:

- `OASIS_WALLET_NETWORK=ethereum`
- `ETH_RPC_URL=https://ethereum-rpc.publicnode.com`
- `OASIS_WALLET_CHAIN_ID=1`

Safety behavior:
- wallet tools validate chain-id on every call
- if RPC/network is mismatched, calls fail fast with a clear mismatch error instead of returning misleading balances

## Config Notes

Perplexity defaults are in `config/config.yaml`:

```yaml
perplexity:
  base_url: "https://api.perplexity.ai"
  max_results: 5
  max_tokens_per_page: 4096
  country: "US"
```

Use ISO alpha-2 country codes (`US`, `GB`, `DE`, etc.).
