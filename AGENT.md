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

### 3. Infinite Context & Memory
- **Token-Based Compaction**: Triggered dynamically when context usage hits 90% of model window.
- **Carry-Over Summarization**: Before flushing old messages, we generate a `session_context.md` summary which is permanently injected into the prompt.
- **Layered Memory**:
    - **Semantic**: Facts & Preferences (`memory.md`).
    - **Episodic**: Recent experiences (`episodic/*.md`).
    - **Procedural**: Learned rules (`rules.md`).

### 4. Security & Trust
- **Trust but Verify**: The agent is powerful but gated.
- **Human-in-the-Loop**: High-stakes actions (shell commands, money, external comms) require explicit approval via the configured interface.

## Tech Stack Standards
- **Runtime**: Node.js / TypeScript.
- **Browser**: Playwright (Headless/Headed).
- **LLM**: Provider-agnostic (OpenAI, Anthropic, Novita, etc.).



model="moonshotai/kimi-k2.5",

Hey! 👋 I'm here! Sorry for the delay — looks like there was a hiccup with the image earlier. I can see it now though!

## Image Description

This is a **3D rendered character** of an elderly man with a whimsical, cartoony style:

| Feature | Description |
|---------|-------------|
| **Hat** | Orange/red knit beanie |
| **Hair** | Long, wild white/grey hair sticking out |
| **Face** | Large expressive blue eyes behind round glasses, prominent pink nose, bushy white mustache and long beard |
| **Clothing** | Red quilted jacket with blue collar |
| **Style** | Pixar/DreamWorks-style CGI — very detailed textures and warm lighting |

He has a surprised or curious expression. The rendering quality is excellent — looks like professional character work, possibly from an animated film or game.

---

What's up? Need anything else? 😊