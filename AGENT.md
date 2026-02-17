# Oasis Agent (v2.1)

**Identity**: Oasis is a reactive, autonomous agent capable of long-running tasks, self-correction, and context-aware execution. It runs on its own dedicated server and communicates via Telegram.

## Core Capabilities

### 🌐 Autonomous Browsing
- Navigate, click, type, and extract text from any website.
- Take screenshots and search Google.
- **Vision**: Uses `minimax-m2.5` (or configured VLM) to "see" and understand web pages.

### 🐚 Shell & Filesystem
- Full access to the local filesystem and terminal.
- Can run git, npm, python scripts, and manage its own process.
- **Self-Update**: Can pull the latest code from GitHub and restart itself via `/update`.

### 📷 Native Vision & Documents
- **Images**: Send photos directly in Telegram. Oasis analyzes them using native multimodal LLM capabilities.
- **Docs**: Upload PDF, DOCX, or TXT files. Oasis reads them using `docling` and `pdf-parse`.

### 🔐 ETH Wallet (Base)
Oasis has its own EVM wallet (private key in `.env`).
- **Address**: `0xDBE72487AaEA26891a7FCCc45cdBa857476021cC` (Base Mainnet)
- **Check Balance**: "Check my ETH/USDC balance".
- **Send Crypto**: "Send 0.01 ETH to..." (Always requires Telegram approval).
- **Smart Contracts**: Can read/write to any contract. "Swap 10 USDC for ETH on Uniswap" (Write calls require approval).

---

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Wake up the bot and see available commands. |
| `/status` | Check current permission mode (Allow All vs Ask). |
| `/revoke` | Revoke "Allow All" mode (returns to "Assist" mode). |
| `/save` | Manually save chat history to disk immediately. |
| `/reset` | Clear chat history and delete the session file (fresh start). |
| `/update` | Pull latest code from git, install deps, and restart. |

---

## Technical Architecture

### 1. Omni-Interface
The agent loop (`agent.ts`) is decoupled from the interface. Currently uses **Telegram** (`src/telegram/bot.ts`) as the primary UI, but supports CLI (`src/cli.ts`) for debugging.

### 2. Persistence & Memory
- **Session**: Chat history is auto-saved every 5 minutes to `memory/chat_session.json` (atomic writes).
- **Semantic**: Facts stored in `memory/memory.md`.
- **Procedural**: Rules stored in `memory/rules.md`.

### 3. Security
- **Human-in-the-Loop**: High-stakes tools (shell, wallet sends) trigger an approval flow.
- **Global Allow**: Can be enabled via `setGlobalAllow(true)` shell tool, but **Wallet Send** and **Contract Writes** ALWAYS require explicit approval regardless of this setting.

### 4. Deployment
Managed via **PM2**.
- **Logs**: `pm2 logs oasis`
- **Restart**: `pm2 restart oasis`
- **Config**: `config/config.yaml` and `.env` (API keys).

0x742d35Cc6634C0532925a3b844Bc9e7595f8dEe