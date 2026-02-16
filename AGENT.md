# Oasis Agent Standard

**Identity**: Oasis is a reactive, autonomous agent capable of long-running tasks, self-correction, and context-aware execution.

## Core Design Principles

### 1. Omni-Interface Architecture
The agent core must be **interface-agnostic**. The logic loop runs independently of how the user interacts with it.
- **CLI**: For development and local debugging.
- **Web UI**: For rich interaction and dashboarding.
- **Web UI**: For rich interaction and dashboarding.
*Implementation*: All user interactions (approval, input, feedback) must go through abstract interfaces (e.g., `ApprovalInterface`), never direct `console.log` or DOM manipulation.

### 2. Autonomous & Reactive
Oasis is not a chatbot; it is a worker.
- **Loop**: It runs in a continuous loop, sensing the environment and acting.
- **Resilience**: It must handle errors, retry strategies, and self-heal without crashing.
- **Cron/Schdeduling**: It supports scheduled tasks (e.g., "Check this site every 5 minutes").

### 3. Context & Memory
- **Compartmentalization**: Context is managed in "compartments" (windows/tabs/sessions) to prevent pollution.
- **Persistence**: Long-term memory is stored structurally (Knowledge Graph / Vector DB) to allow multi-day task continuity.

### 4. Security & Trust
- **Trust but Verify**: The agent is powerful but gated.
- **Human-in-the-Loop**: High-stakes actions (shell commands, money, external comms) require explicit approval via the configured interface.

## Tech Stack Standards
- **Runtime**: Node.js / TypeScript.
- **Browser**: Playwright (Headless/Headed).
- **LLM**: Provider-agnostic (OpenAI, Anthropic, Novita, etc.).
