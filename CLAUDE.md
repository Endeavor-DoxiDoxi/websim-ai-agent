# websim AI agent — guide for AI assistants

A multi-project tool that lets an AI agent edit **websim.com** projects. It
runs as an MCP server (stdio) and includes an automated daemon that watches
project comments and builds what people request.

## Architecture

```
You (CLI or Claude Code) / daemon
    ↓
agent.js  ←→  OpenAI-compatible API (proxy, any provider)
    ↓  (MCP stdio — spawns child process)
mcp-server.js  ←→  websim.com API
    ↓  (reads)
projects.config.json  (aliases → {id, slug})
```

- `mcp-server.js` — MCP server (16 tools). Handles all websim API calls.
- `agent.js` — AI agent + daemon. Converts MCP tools to OpenAI function format, runs tool-calling loops.
- `websim-comment.js` — Comment helpers (post, reply, delete, list).
- `projects.config.json` — Project aliases → {id, slug}.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your credentials
# Edit projects.config.json with your project IDs
```

## Usage

```bash
# One-shot edit
node agent.js "Add a dark mode toggle"

# Interactive chat
node agent.js --interactive

# Daemon (auto-builds from comments, polls every N seconds)
node agent.js --watch -p opus48 --interval 10

# List projects
node agent.js --list-projects
```

## MCP Tools

The MCP server exposes these tools (the agent converts them to OpenAI function format):

| Tool | Purpose |
|------|---------|
| `list_projects` | Show all configured project aliases |
| `list_revisions` | List all revisions of a project |
| `list_files` | List files in a specific revision |
| `download_file` | Download a file to local `project/` mirror (returns contents) |
| `write_file` | Write content to local `project/` mirror |
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

## Edit Workflow

The agent follows this workflow for making changes:

1. `list_revisions` → find the live version
2. `create_revision(parent_version=live)` → new editable draft
3. `download_file` → get file contents (tool returns contents inline)
4. `write_file` → stage edits locally
5. `upload_file` → push to websim
6. `finish_revision` → publish (makes it immutable)
7. `set_current_revision` → make new version live

Safeguard: a successful build must finish and promote the exact revision it
created for that build. Do not finish or set current to an older, reverted, or
pre-existing live revision.

## Hyperframes video support

Hyperframes is supported for video-style site/composition requests. It is **not
an AI model**; it is an open-source, deterministic HTML/code-based video
generation workflow. Author Hyperframes content as plain HTML/CSS/JS with
composition/timing attributes such as:

- `data-composition-id` on the stage/root composition
- `data-start`, `data-duration`, `data-width`, `data-height`
- timed `<video>`/`<audio>`/overlay elements with `data-track-index`
- seekable CSS/JS animations (GSAP/WAAPI/etc.) that can be driven frame by frame

Prefer self-contained, teen-safe code and CSS/JS-generated visuals. Only add
remote media when necessary, and keep media URLs within the moderation and size
guardrails.

## Daemon / Bot Mode

The daemon polls comments every N seconds, triages them via the LLM, and builds
what people request. Flow:

1. **API poll** (cheap, no AI) — checks for new comments
2. **Skip self-comments** — filters out comments from `WEBSIM_BOT_USERNAME`
3. **AI triage** — decides if comment is a buildable request
4. **Reply** — posts decision with WIP prefix
5. **Build** — calls runAgent with the edit prompt
6. **Reply again** — posts completion confirmation

State is tracked in `comment-bot-seen.json`. Duplicate detection prevents
building the same feature twice. Entries auto-prune after `AGENT_STATE_MAX_AGE_DAYS`.

## Proxy Setup

This agent needs an OpenAI-compatible endpoint that supports tool/function calling.
The included proxy (`proxy.js` at `/home/doxi/.openclaw/unlimited-proxy/`) converts
OpenAI requests to Anthropic format and forwards tools properly:

- OpenAI `tools` → Anthropic `tools`
- OpenAI `tool_calls` ← Anthropic `tool_use`
- OpenAI `tool` role ← Anthropic `tool_result`

## Safety

- `WEBSIM_BEARER` in `.env` is a live login JWT — treat it like a password
- The agent can create, edit, publish, and delete revisions and comments
- `AGENT_MAX_TURNS` (default 15) prevents infinite tool-calling loops
- The daemon skips its own comments via `WEBSIM_BOT_USERNAME`
- Never commit `.env` — it's in `.gitignore`
- Media moderation is fail-closed. Remote media must be `http`/`https`, pass
  HEAD preflight with verified `content-length`/`content-type`, stay under the
  configured hard cap (default 500MB / 30 minutes), and videos must also stay
  under the smaller local probe/download budget before ffmpeg/ffprobe runs.
