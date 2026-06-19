# 🔌 websim AI Agent v2

# Notice - BUILT ON LINUX, YOU MIGHT WANNA USE A BASH SHELL FOR WINDOWS, OR WSL2 FOR NOW.

# Double Notice - It has a queuing system, idk, theres still some rate limiting issues I think.

# Triple Notice 
### TO THE WEBSIM DEVS, IF THIS PROJECT IS AN ISSUE TORWARDS THE WEBSIM SERVICE, API, OR USERS IN ANY WAY, YOU MAY REQUEST THAT THIS PROJECT BE PRIVATED OR REMOVED IMMEDIATELY UNTIL SAFE TO USE AGAIN. THIS IS TO ENSURE THAT NOTHING GOES WRONG, THE MAIN REPO WILL BE REMOVED UNTIL ALLOWED ONCE AGAIN.

## Before you go all "YOU LEAKED AN API KEY"
<img width="930" height="207" alt="image" src="https://github.com/user-attachments/assets/ab028f28-fe58-4dc6-b59d-fe3d5f8ae500" />

### Don't worry.

**Multi-project AI agent for websim.com** — give it a natural-language prompt, and it edits your projects. Works with **any OpenAI-compatible endpoint** (OpenAI, Claude via proxy, OpenRouter, local models, etc.).

```
$ node agent.js "Add a dark mode toggle to my platformer"
🤖 Agent: Working on "Add a dark mode toggle to my platformer"
   Model: your-model-id | Project: main | Max turns: 15

🔧 Calling: list_revisions({"project":"main"})
   ↳ [main] Revisions: [{"version":5,"draft":false,...}]
🔧 Calling: create_revision({"parent_version":5})
   ↳ [main] Created revision: version=6, draft=true
...
✅ Done.
```

## Architecture

```
You (CLI prompt)
    ↓
agent.js  ←→  OpenAI-compatible API  (your proxy / any provider)
    ↓  (MCP stdio)
mcp-server.js  ←→  websim.com API  (multi-project aware)
    ↓  (reads)
projects.config.json  (aliases → project IDs)
```

The MCP server handles all websim API calls. The agent bridges your OpenAI-compatible LLM with the MCP tools — the LLM decides *which* tools to call, the agent executes them, and they loop until the job is done.

## Setup

### 1. Install

```bash
cd websim-ai-agent
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```ini
# Your OpenAI-compatible endpoint (proxy, OpenAI, OpenRouter, etc.)
OPENAI_BASE_URL=https://your-openai-compatible-endpoint/v1
OPENAI_API_KEY=REPLACE_ME
OPENAI_MODEL=your-model-id

# Does your endpoint support image/vision input?
OPENAI_VISION_SUPPORT=false

# Preferred Websim auth: install the official CLI and run `websim-cli login`.
# The agent automatically reads ~/.websim-cli.json when WEBSIM_BEARER is blank.
# Optional fallback: paste a Websim bearer/JWT here if you cannot use CLI login.
WEBSIM_BEARER=

AGENT_MAX_TURNS=15
AGENT_API_TIMEOUT_SECONDS=900
AGENT_DEBUG=false
AGENT_STATUS_RATE_LIMIT_SECONDS=60
WEBSIM_ADMIN_USERNAMES=Endoxidev

# Safety / media moderation
WEBSIM_MEDIA_MODERATION=true
WEBSIM_MEDIA_MODERATION_ENDPOINT=https://imgcheck.val.run
WEBSIM_MEDIA_MODERATION_THRESHOLD=0.55
WEBSIM_VIDEO_MODERATION_FRAMES=3
WEBSIM_MAX_MEDIA_BYTES=524288000
WEBSIM_MAX_IMAGE_BYTES=10485760
WEBSIM_MAX_VIDEO_BYTES=524288000
WEBSIM_MAX_VIDEO_PROBE_BYTES=52428800
WEBSIM_MAX_VIDEO_SECONDS=1800
WEBSIM_MAX_MEDIA_URLS=8
WEBSIM_MEDIA_MODERATION_TIMEOUT_MS=8000
WEBSIM_MODERATION_CACHE_TTL_SECONDS=21600
WEBSIM_PROJECT_CACHE_MAX_AGE_HOURS=24
```

### 3. Add your projects

Edit `projects.config.json`:

```json
{
  "defaultProject": "main",
  "projects": {
    "main": {
      "id": "abc123...",
      "slug": "@doxi/my-project",
      "label": "My Main Project"
    },
    "sm64ai": {
      "id": "def456...",
      "slug": "@doxi/sm64-ai-player",
      "label": "SM64 AI Player"
    }
  }
}
```

Each project can optionally have its own `bearer` override (if different websim accounts).

### 4. Optional: use official `websim-cli` login

This project can reuse the official [`websim-cli`](https://www.npmjs.com/package/websim-cli) browser login flow, so most users do **not** need to copy JWTs from DevTools.

```bash
npm install -g websim-cli
websim-cli login
```

`websim-cli login` opens a Websim browser login challenge and stores the resulting token in `~/.websim-cli.json` with file mode `0600`. If `WEBSIM_BEARER` is blank, this agent automatically reads that token.

Auth priority:

1. `bearer` on a specific project in `projects.config.json`
2. `WEBSIM_BEARER`, `bearer`, or `WEBSIM_TOKEN` from `.env`
3. official `websim-cli` token from `~/.websim-cli.json`

You can override the official CLI config path if needed:

```ini
WEBSIM_CLI_CONFIG=/path/to/.websim-cli.json
```

### 5. Run it!

```bash
# One-shot
node agent.js "Add a high score counter to my game"

# Target a specific project
node agent.js --project sm64ai "List all files in the current revision"

# Interactive chat mode
node agent.js --interactive

# List configured projects
node agent.js --list-projects
```

## Usage

```
USAGE:
  node agent.js [--project <alias>] "your prompt here"
  node agent.js --interactive
  node agent.js --list-projects

OPTIONS:
  --project, -p     Project alias (from projects.config.json)
  --interactive, -i  Interactive chat mode (type 'exit' to quit)
  --list-projects    Show all configured projects
  --model, -m       Override model for this run
  --help, -h        Show help
```

## Interactive Mode

```
$ node agent.js -i

🔌 websim AI agent — interactive mode
   Model: your-model-id | Endpoint: https://your-openai-compatible-endpoint/v1
   Type "exit" to quit, "projects" to list projects.

💬 You > add a jump counter to my platformer
🤖 Agent: Working on "add a jump counter to my platformer"...

💬 You > /project sm64ai
   ↳ Project set to "sm64ai"

💬 You > what files are in the latest revision?
🤖 Agent: Working on "what files are in the latest revision?"...
```

## Official `websim-cli` comparison

`websim-cli@0.2.1` is the official Websim CLI for local project workflows. It currently provides:

- Auth: `websim-cli login`
- Project file workflows: `clone`, `pull`, `sync`, `push`, `promote`, `create`, `list`, `list-current`, `get`, `get-lineage`, `revisions`
- Site commands: `sites create/get/list/list-current/get-lineage`
- Experiments: `experiment start/stop/status/stats`
- Local dev: `websim-cli dev` with Websim SDK shims and real authenticated API proxying

This agent currently integrates with the official CLI at the auth layer: users can log in once with `websim-cli login`, then run the agent without manually pasting a Websim JWT.

The agent still uses its own MCP tools for comment monitoring, revision creation, file download/upload, and exact patching because those are designed for tool-calling agents. Future integrations could optionally shell out to `websim-cli clone/pull/sync --no-promote`, or use CLI-managed `.websim.json`/`.websim-manifest.json` project directories as a local workspace backend.

Generated CLI metadata (`.websim.json`, `.websim-manifest.json`, `AGENT.md`) is ignored by default in this repo so users do not accidentally commit local Websim checkout state.

## How Editing Works

The agent follows this workflow automatically:

1. `list_revisions` → find the current/live version (`current: true`)
2. `create_revision(parent_version=live)` → new editable draft
3. `download_file` → pull files locally
4. *(LLM reviews + plans changes)*
5. `replace_in_file` or `write_file` → stage local edits
6. `upload_file` → push edited files
7. `finish_revision` → publish (makes it immutable)
8. `set_current_revision` → make new version live

It can also do simpler tasks like reading files, listing revisions, posting/replying to comments, etc.

## Hyperframes video requests

The daemon recognizes video/Hyperframes-style requests. When it builds one, it posts a public note that it is “generating hyperframes video” and clarifies that Hyperframes is not an AI model — it is deterministic HTML/code-based video generation. The build prompt teaches the agent to use plain HTML compositions with `data-composition-id`, `data-start`, `data-duration`, dimensions, tracks, and seekable CSS/JS animations while preserving the same media safety checks.

## Media safety guardrails

Remote media moderation is fail-closed. URLs must be `http`/`https`, pass HEAD preflight with verified `content-length` and media `content-type`, stay below the 500MB/30-minute hard cap, and videos must also fit the smaller local probe budget (default 50MB) before any ffmpeg/ffprobe work runs. Unknown-size, unsupported, private/local, redirect-suspicious, or over-budget media is blocked instead of downloaded.

## Available Tools

The MCP server exposes these tools (the agent converts them to OpenAI function format automatically):

| Tool | What it does |
|------|-------------|
| `list_projects` | Show all configured project aliases |
| `list_revisions` | List all revisions of a project |
| `list_files` | List files in a specific revision |
| `download_file` | Download a file to local `project/` mirror |
| `replace_in_file` | Apply exact local text replacements after downloading a file |
| `upload_file` | Upload a local file to websim |
| `delete_file` | Delete a file from a revision |
| `create_revision` | Create a new draft revision |
| `finish_revision` | Publish/finalize a draft |
| `set_current_revision` | Set the live version |
| `list_revision_history` | View edit history |
| `list_comments` | Read project comments |
| `list_comment_replies` | Read comment replies |
| `post_comment` | Post a top-level comment |
| `post_reply` | Reply to a comment |
| `delete_comment` | Delete a comment |

All tools accept an optional `project` parameter (alias from config). If omitted, uses `defaultProject`.

## Using the MCP Server Directly

The MCP server can be used standalone with any MCP-compatible client (Claude Code, etc.):

```json
{
  "mcpServers": {
    "websim-multi-project": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/websim-ai-agent/mcp-server.js"]
    }
  }
}
```

## Endpoint Compatibility

The agent sends standard OpenAI chat-completions requests with `tools`. It works with:

- **Any OpenAI-compatible proxy**
- **OpenAI** (api.openai.com)
- **OpenRouter** (openrouter.ai/api/v1)
- **Local models** (Ollama, LM Studio, vLLM via their OpenAI-compat endpoints)
- **Claude via proxy** (Anthropic models behind an OpenAI-compat adapter)

Just set `OPENAI_BASE_URL` and `OPENAI_API_KEY` in your `.env`.

If your endpoint supports vision, set `OPENAI_VISION_SUPPORT=true` — the agent can then analyze screenshots of your websim project for visual feedback.

## Comment commands

Public commands:

- `!status` / `!stats` — show queue length, completed build count, and whether the agent is building/paused/idle. Rate-limited per username.

Admin commands are restricted to usernames in `WEBSIM_ADMIN_USERNAMES` and are best-effort deleted shortly after processing so the bot does not preserve sensitive command prompts in comments:

- `!clearqueue` / `!clear` — clear waiting queue and notify queued users.
- `!pause` / `!resume` — stop/start intake and queue processing for public build requests.
- `!maintenance <message>` / `!maint <message>` — pause intake/queue and announce longer maintenance.
- `!online` / `!back` — resume after maintenance and announce the bot is back online.
- `!restart` — announce restart; if a prompt is currently building, finish it first, then restart and resume.
- `!clean` — delete stale local project mirror/cache files.
- `!fixindex [version]` / `!cleanindex [version]` — delete duplicate homepage assets such as `index (1).html`; keeps the real `index.html` untouched.
- `!queue` — show a short queue preview.
- `!drop <n>` — remove one queued item by queue number.
- `!revisions` / `!versions` — show recent revision numbers.
- `!safemode on` / `!safe on` — publish the default safe-mode page and record the previous live revision when possible.
- `!safemode off` / `!safe off` — restore the recorded previous live revision. If no previous revision is known, use `!revisions` then `!revert <version>`.
- `!revert <version>` / `!restore <version>` — set the live project back to a previous revision.
- `!ap <prompt>` / `!adminprompt <prompt>` — trusted admin override build. The bot does not echo the prompt and uses unfiltered upload mode for emergency repair/recovery.
- `!help` / `!adminhelp` — show admin commands.


## Hyperframes support

For requests that ask for video-style output, the agent nudges the builder toward Hyperframes-style compositions: plain HTML/CSS/JS with `data-composition-id`, timing attributes, tracks, and seekable animation code. It also posts a public note while building: “generating hyperframes video” and clarifies that Hyperframes is **not an AI model** — it is pure HTML video code / deterministic code-based video generation.

This support does not relax media safety. Remote media in generated HTML still goes through the moderation/upload guardrails, and large/slow/unverifiable videos fail closed.

## Safety

- The system prompt and triage prompt keep generated project content teen-friendly for a 13+ platform, roughly ages 13-18.
- The agent rejects 18+ sexual content, nudity, porn/hentai, fetish content, graphic gore, hate, exploitation, self-harm instructions, illegal activity, harassment, moderation bypass attempts, preschool/young-child-targeted content such as Numberblocks/Alphablocks, and low-effort slop/spam/shock content.
- Image/video URLs in comments are moderated before the AI sees the prompt. Blocked prompts receive a generic safety error.
- Image/video URLs in uploaded HTML/CSS/JS/JSON/Markdown/text files are moderated before `upload_file` can publish them.
- Default media moderation endpoint: `https://imgcheck.val.run` using nsfwjs classes. `Neutral` and `Drawing` are allowed; `Sexy`, `Porn`, and `Hentai` are blocked at `WEBSIM_MEDIA_MODERATION_THRESHOLD` or higher.
- Media is capped by strict defaults: `WEBSIM_MAX_MEDIA_BYTES` and `WEBSIM_MAX_VIDEO_BYTES` default to 500MB, `WEBSIM_MAX_IMAGE_BYTES` defaults to 10MB, `WEBSIM_MAX_VIDEO_PROBE_BYTES` defaults to 50MB before local video probing, and `WEBSIM_MAX_VIDEO_SECONDS` defaults to 1800 seconds / 30 minutes.
- Remote video URLs fail closed unless they pass protocol, DNS/private-host, `HEAD`, `content-type`, `content-length`, bounded download, local duration, and sampled-frame checks. Slow streams, missing sizes, oversized media, unsupported protocols, and unverifiable videos are blocked before they can hammer the Pi.
- Local project mirror files under `project/` are cache only and are pruned on startup / `!clean` when older than `WEBSIM_PROJECT_CACHE_MAX_AGE_HOURS`.
- Owner/admin command `!safemode on` (alias `!safe on`) publishes a default page that says: “Something went wrong... Images and Videos are currently disabled for the time being, sorry!” `!safemode off` restores the previously recorded live revision when known; otherwise use `!revisions` and `!revert <version>`.
- Your `WEBSIM_BEARER` JWT in `.env` is a **live login** for your websim account. Treat it like a password.
- The agent can create, edit, publish, and delete revisions and comments. Point it only at projects you own.
- Duplicate homepage paths such as `index (1).html` are blocked. The Websim entrypoint is `index.html`; use `!fixindex` if duplicates already exist on a revision.
- `AGENT_MAX_TURNS` (default 15) prevents infinite tool-calling loops.

### Notice

This project is a HEAVY work in progress!
Please be careful when hosting this!
