# Oasis — Browser Automation Agent

A general-purpose browser agent powered by **Playwright** + **OpenAI**. Ask it anything that requires browsing the web.

## Quick Start

```bash
cd oasis

# Install dependencies + Chromium
npm install

# Set your OpenAI key
cp .env .env.local  # edit .env with your key

# Run
npm start
```

## Usage

```
You → Go to espn.com/nba and tell me today's scores
   🤔 Thinking...
   🔧 navigate → ✅ Navigated to https://www.espn.com/nba/...
   🔧 extract_text → NBA Scores...
🌴 Oasis:
Here are today's NBA scores: ...
```

### Commands
- Type any request → agent browses + reasons
- `/clear` → reset conversation history
- `exit` / `quit` → stop

## Available Tools

| Tool | What it does |
|------|-------------|
| `navigate(url)` | Go to a URL |
| `click(selector)` | Click an element |
| `type_text(selector, text)` | Type into an input |
| `extract_text(selector?)` | Read page content |
| `screenshot()` | Save a screenshot |
| `get_links()` | List all links on page |
| `search_google(query)` | Google search |
| `get_current_url()` | Current page info |

## Config (`.env`)

```
OPENAI_API_KEY=sk-...
OASIS_MODEL=gpt-4o          # any OpenAI model
OASIS_HEADLESS=true          # false to see the browser
```
