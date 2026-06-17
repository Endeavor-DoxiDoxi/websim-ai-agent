#!/usr/bin/env node
/**
 * websim AI agent — v2
 *
 * Spawns the multi-project MCP server, connects to it, converts its tools to
 * OpenAI function-calling format, and runs an agent loop against your
 * OpenAI-compatible endpoint (OpenAI, Claude via proxy, OpenRouter, etc.).
 *
 * Usage:
 *   node agent.js "Add a dark mode toggle to my main project"
 *   node agent.js --project sm64ai "List all files and tell me what's there"
 *   node agent.js --interactive            (chat mode)
 *   node agent.js --list-projects          (show configured projects)
 *
 * Config comes from .env — see .env.example for all options.
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fs = require('fs');
const nodePath = require('path');
require('dotenv').config();

// ── Config ─────────────────────────────────────────────────────────

const CONFIG = {
  baseUrl:        (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  apiKey:         process.env.OPENAI_API_KEY || '',
  model:          process.env.OPENAI_MODEL || 'gpt-4o',
  visionSupport:  process.env.OPENAI_VISION_SUPPORT === 'true',
  maxTurns:       parseInt(process.env.AGENT_MAX_TURNS || '15', 10),
  debug:          process.env.AGENT_DEBUG === 'true',
  watchIntervalMs: parseInt(process.env.AGENT_WATCH_INTERVAL_SECONDS || (parseInt(process.env.AGENT_WATCH_INTERVAL_MINUTES || '30', 10) * 60), 10) * 1000,
  botUsername:  process.env.WEBSIM_BOT_USERNAME || 'Opus_4_8',
};

const PROJECTS_CONFIG_PATH = nodePath.join(__dirname, 'projects.config.json');
const MCP_SERVER_PATH = nodePath.join(__dirname, 'mcp-server.js');

// ── Helpers ─────────────────────────────────────────────────────────

function log(...args) {
  if (CONFIG.debug) console.error('[agent]', ...args);
}

function loadProjectsConfig() {
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_CONFIG_PATH, 'utf8'));
  } catch {
    return { projects: {}, defaultProject: null };
  }
}

function usage() {
  console.log(`
🔌 websim AI agent v2

USAGE:
  node agent.js [--project <alias>] "your prompt here"          # one-shot edit
  node agent.js --interactive                                   # chat mode
  node agent.js --watch [--project <alias>]                     # auto-bot daemon
  node agent.js --list-projects                                 # show projects

OPTIONS:
  --project, -p    Project alias (from projects.config.json). Default: configured default.
  --interactive, -i  Interactive chat mode (type 'exit' to quit).
  --watch, -w      Automated daemon — polls comments every N minutes, actions edit requests.
  --interval <n>   Polling interval in seconds (default: from .env, only with --watch).
  --list-projects    Show all configured projects.
  --model, -m      Override model for this run.
  --help, -h       This help.

ENVIRONMENT (from .env):
  OPENAI_BASE_URL              OpenAI-compatible endpoint
  OPENAI_API_KEY               API key for the endpoint
  OPENAI_MODEL                 Default model to use
  OPENAI_VISION_SUPPORT        Whether the model supports image input
  WEBSIM_BEARER                websim JWT auth token
  AGENT_MAX_TURNS              Max tool-calling iterations (default: 15)
  AGENT_WATCH_INTERVAL_MINUTES  Daemon polling interval (default: 30)
  AGENT_DEBUG                  Verbose logging

EXAMPLES:
  node agent.js "Add a jump sound to my platformer project"
  node agent.js -p sm64ai "List all current revision files"
  node agent.js -i
  node agent.js --watch -p mygame                  # daemon, 30min default
  node agent.js --watch --interval 15 -p mygame    # daemon, every 15min
`);
}

// ── MCP Client Manager ──────────────────────────────────────────────

let mcpClient = null;
let mcpTransport = null;
let mcpTools = [];

async function startMCP() {
  log('Starting MCP server...');

  mcpTransport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    env: { ...process.env },
    stderr: 'pipe',
  });

  // Capture stderr for logging
  mcpTransport.stderr?.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error('[mcp]', msg);
  });

  mcpClient = new Client(
    { name: 'websim-agent', version: '2.0.0' },
    { capabilities: {} }
  );

  await mcpClient.connect(mcpTransport);
  const result = await mcpClient.listTools();
  mcpTools = result.tools || [];
  log(`Connected. ${mcpTools.length} tools available.`);
}

async function stopMCP() {
  try {
    if (mcpClient) await mcpClient.close();
  } catch {}
  mcpClient = null;
  mcpTransport = null;
  mcpTools = [];
}

// ── Tool conversion: MCP → OpenAI function format ───────────────────

function mcpToolToOpenAI(tool) {
  const props = {};
  const required = [];

  if (tool.inputSchema?.properties) {
    for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
      props[key] = {
        type: schema.type || 'string',
        description: schema.description || '',
      };
      if (schema.enum) props[key].enum = schema.enum;
    }
    required.push(...(tool.inputSchema.required || []));
  }

  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: {
        type: 'object',
        properties: props,
        required,
      },
    },
  };
}

// ── Agent loop (prompt-based tool calling) ──────────────────────────

// Build tool descriptions for the system prompt (works with ANY LLM)
function buildToolPrompt() {
  const lines = ['## AVAILABLE TOOLS', 'You can call these tools by outputting:', '<tool>tool_name</tool>', '<args>{"key": "value"}</args>', '', 'Tools:'];
  for (const t of mcpTools) {
    const params = t.inputSchema?.properties ? Object.keys(t.inputSchema.properties).join(', ') : '';
    lines.push(`- ${t.name}(${params}): ${(t.description||'').slice(0, 150)}`);
  }
  lines.push('', 'When you need to do something, CALL THE TOOL. After each tool result, decide what tool to call next.', 'When you are completely done, respond with: <done>Summary of what was accomplished</done>', 'NEVER pretend to have run a tool. ALWAYS use actual <tool> calls.');
  return lines.join('\n');
}

async function callModel(messages, tools = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${CONFIG.apiKey}`,
  };

  const body = {
    model: CONFIG.model,
    messages,
    max_tokens: 4096,
  };
  // When tools are provided, use NATIVE OpenAI function-calling. Without this
  // the model only ever produced prose ("Done! added bombs") and nothing was
  // actually executed — the agent loop now relies on real tool_calls.
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  log('→ API call:', CONFIG.baseUrl + '/chat/completions');

  const res = await fetch(CONFIG.baseUrl + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`API error ${res.status}: ${text.slice(0, 500)}`);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from API: ${text.slice(0, 300)}`);
  }
}

async function executeToolCall(toolCall) {
  const name = toolCall.function?.name || toolCall.name;
  const args = JSON.parse(toolCall.function?.arguments || toolCall.arguments || '{}');
  log('🔧 Calling:', name, args);

  try {
    const result = await mcpClient.callTool({ name, arguments: args });
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return text || JSON.stringify(result.content);
  } catch (err) {
    return `Error executing ${name}: ${err.message}`;
  }
}

// ── CLAUDE.md loader (agent's own guide) ───────────────────────────

let _claudeGuide = '';
function loadClaudeGuide() {
  if (_claudeGuide) return _claudeGuide;
  try {
    _claudeGuide = fs.readFileSync(nodePath.join(__dirname, 'CLAUDE.md'), 'utf8');
    log('Loaded CLAUDE.md guide');
  } catch { _claudeGuide = ''; }
  return _claudeGuide;
}

// ── Agent loop ─────────────────────────────────────────────────────

async function runAgent(prompt, projectAlias) {
  // Native OpenAI function-calling: hand the model the real tool schemas and
  // execute the tool_calls it returns. Returns { ok, summary, edited } so the
  // caller (e.g. the comment bot) can tell whether an edit ACTUALLY happened
  // instead of trusting the model's prose.
  const tools = mcpTools.map(mcpToolToOpenAI);
  const guide = loadClaudeGuide();
  const guideSection = guide ? `\n\nGUIDE (from CLAUDE.md):\n${guide.slice(0, 3000)}\n` : '';
  const messages = [
    {
      role: 'system',
      content: `You are a websim project editor. Use the provided TOOLS (function calls) to do everything — never just describe changes in prose; only upload_file + finish_revision + set_current_revision actually change the live project.

WORKFLOW:
1. list_revisions → find the latest version number
2. create_revision(parent_version=latest) → new draft
3. download_file → read current contents
4. write_file → stage your edited file locally
5. upload_file → push to websim
6. finish_revision → publish
7. set_current_revision → make it live
Then stop (no more tool calls) and give a 1-2 sentence summary of what you changed.

Default project alias: "${projectAlias || 'default'}". Always start with list_revisions.${guideSection}`,
    },
    { role: 'user', content: `TASK: ${prompt}` },
  ];

  console.log(`\n🤖 Agent building: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);
  console.log(`   Model: ${CONFIG.model} | Project: ${projectAlias || 'default'} | Max turns: ${CONFIG.maxTurns}\n`);

  // Track whether a real mutating tool actually ran — this is the anti-hallucination guard.
  const MUTATING = new Set(['upload_file', 'finish_revision', 'set_current_revision', 'delete_file', 'create_revision']);
  let edited = false;
  let published = false; // specifically: did finish_revision get called?

  for (let turn = 0; turn < CONFIG.maxTurns; turn++) {
    const response = await callModel(messages, tools);
    const msg = response.choices?.[0]?.message;
    if (!msg) { console.log('⚠️ Empty response.'); break; }

    const toolCalls = msg.tool_calls || [];

    // No tool calls => the model is done (or stalled). Either way, stop the loop.
    if (toolCalls.length === 0) {
      // If we uploaded files but didn't publish, nudge the LLM
      if (edited && !published) {
        console.log('   ⚠️ Files uploaded but NOT published — prompting to finish.');
        messages.push({ role: 'user', content: 'You uploaded files but did NOT call finish_revision or set_current_revision. The changes are NOT live! Call finish_revision and set_current_revision NOW.' });
        continue;
      }
      const summary = (msg.content || '').trim();
      if (summary) console.log(summary.slice(0, 400));
      // Push the assistant turn so the transcript is coherent, then finish.
      messages.push({ role: 'assistant', content: summary });
      console.log(edited ? '✅ Build complete (changes published).' : '⚠️ Finished with NO file changes made.');
      return { ok: edited, summary, edited };
    }

    // Record the assistant's tool_calls turn verbatim (required by the API contract).
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });

    // Execute each tool call and feed results back as role:'tool' messages.
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); }
      catch { args = {}; }
      if (!args.project && projectAlias) args.project = projectAlias; // auto-inject alias

      console.log(`   🔧 ${name}(${JSON.stringify(args).slice(0, 100)})`);
      let result;
      try {
        const res = await mcpClient.callTool({ name, arguments: args });
        result = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n') || '(ok)';
        if (MUTATING.has(name)) edited = true;
      if (name === 'finish_revision') published = true;
        console.log(`   ↳ ${result.slice(0, 200)}`);
      } catch (err) {
        result = `Error: ${err.message}`;
        console.error(`   ❌ ${result}`);
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  console.log(`⚠️ Max turns (${CONFIG.maxTurns}) reached.`);
  return { ok: edited, summary: 'Max turns reached.', edited };
}

// ── Interactive mode ────────────────────────────────────────────────

async function interactiveMode() {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n💬 You > ',
  });

  console.log('\n🔌 websim AI agent — interactive mode');
  console.log(`   Model: ${CONFIG.model} | Endpoint: ${CONFIG.baseUrl}`);
  console.log('   Type "exit" to quit, "projects" to list projects.\n');

  const projectsCfg = loadProjectsConfig();
  let currentProject = projectsCfg.defaultProject || 'main';

  rl.prompt();

  // We need to handle each line
  const handler = async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === 'exit' || input === 'quit') {
      rl.close();
      return;
    }
    if (input === 'projects') {
      console.log(JSON.stringify(Object.entries(projectsCfg.projects || {}).map(([k, v]) => ({
        alias: k, id: v.id, slug: v.slug, label: v.label, isDefault: k === projectsCfg.defaultProject,
      })), null, 2));
      rl.prompt();
      return;
    }
    // Check for /project <alias>
    if (input.startsWith('/project ')) {
      currentProject = input.slice(9).trim();
      console.log(`   ↳ Project set to "${currentProject}"`);
      rl.prompt();
      return;
    }

    try {
      await runAgent(input, currentProject);
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}`);
      if (CONFIG.debug) console.error(err);
    }
    rl.prompt();
  };

  rl.on('line', (line) => handler(line));
  rl.on('close', async () => {
    console.log('\n👋 Goodbye!');
    await stopMCP();
    process.exit(0);
  });
}

// ── Automated Daemon (Bot) Mode ─────────────────────────────────────
// State file tracks everything the bot knows, has done, and has rejected.
// This prevents re-doing work and lets it learn across sessions.

const BOT_STATE_PATH = nodePath.join(__dirname, 'comment-bot-seen.json');
const STATE_MAX_AGE_DAYS = parseInt(process.env.AGENT_STATE_MAX_AGE_DAYS || '90', 10);

function loadBotState() {
  try {
    const raw = fs.readFileSync(BOT_STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    // Normalize old format → new format
    if (!state.entries) state.entries = {};
    if (!state.checklist) state.checklist = [];
    if (!state.featureRequests) state.featureRequests = [];
    if (Array.isArray(state.seen)) {
      // Migrate legacy flat arrays
      for (const id of state.seen) {
        if (!state.entries[id]) state.entries[id] = { id, category: 'seen', at: state.lastRun || null };
      }
      delete state.seen;
    }
    if (Array.isArray(state.actioned)) {
      for (const a of state.actioned) {
        const id = a.commentId;
        if (id && !state.entries[id]) state.entries[id] = { id, category: 'actioned', at: a.at, prompt: a.prompt };
      }
      delete state.actioned;
    }
    return state;
  } catch {
    return { entries: {}, checklist: [], featureRequests: [], liveVersion: {}, lastRun: null };
  }
}

function saveBotState(state) {
  // Strip giant fields before saving
  const clean = JSON.parse(JSON.stringify(state));
  fs.writeFileSync(BOT_STATE_PATH, JSON.stringify(clean, null, 2));
}

// Prune entries older than STATE_MAX_AGE_DAYS
function pruneOldEntries(state) {
  const cutoff = Date.now() - STATE_MAX_AGE_DAYS * 86400000;
  let pruned = 0;
  for (const [id, entry] of Object.entries(state.entries)) {
    if (entry.at && new Date(entry.at).getTime() < cutoff) {
      delete state.entries[id];
      pruned++;
    }
  }
  state.checklist = (state.checklist || []).filter(c => {
    if (c.at && new Date(c.at).getTime() < cutoff) { pruned++; return false; }
    return true;
  });
  if (pruned > 0) console.log(`   🧹 Pruned ${pruned} entries older than ${STATE_MAX_AGE_DAYS}d`);
}

// Check for duplicate feature requests
function isDuplicateRequest(content, state) {
  const existing = state.featureRequests || [];
  const words = content.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  for (const req of existing) {
    const reqWords = (req.content || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const overlap = words.filter(w => reqWords.includes(w)).length;
    if (overlap >= Math.min(3, words.length * 0.5)) return req;
  }
  return null;
}

// ── Smart Triage (AI-powered) ───────────────────────────────────────

const TRIAGE_SYSTEM_PROMPT = `You are a BUILDING bot for a websim.com project. People leave comments and you BUILD what they ask for.

YOUR JOB:
1. Reason about the request — is it a good idea? Buildable? Not slop?
2. Decide whether to build it
3. Write a friendly reply explaining your decision
4. Write a precise editPrompt that another agent can execute

REASONING GUIDELINES:
- Good requests: new features, visual improvements, sounds, UI, content, mechanics
- Bad requests (reply politely why): impossible features, NSFW, harmful, extremely vague, spam/ads/links
- Vague requests: interpret generously! "make it cooler" → add effects or polish
- Slop/spam: ads, crypto, gibberish, link-only comments → reject
- Greetings: welcome them and ask what they'd like built

RESPONSE FORMAT (JSON only, no markdown):
{
  "category": "feature_request|bug_fix|ui_change|content_change|question|praise|spam|abuse|greeting|unclear",
  "actionable": true/false,
  "reasoning": "2-3 sentences: why this is a good/bad idea and what you'll do",
  "decisionReply": "your public reply to the commenter — friendly, explains your decision, 1-3 sentences",
  "editPrompt": "if actionable: precise editing instructions with specific implementation details",
  "tags": ["keywords"]
}`;

// Cached combined triage prompt (includes CLAUDE.md guide for project context)
let _cachedTriagePrompt = '';
function getTriagePrompt() {
  if (_cachedTriagePrompt) return _cachedTriagePrompt;
  const guide = loadClaudeGuide();
  _cachedTriagePrompt = guide ? `${TRIAGE_SYSTEM_PROMPT}\n\nPROJECT CONTEXT (from CLAUDE.md):\n${guide.slice(0, 3000)}` : TRIAGE_SYSTEM_PROMPT;
  return _cachedTriagePrompt;
}

async function triageComment(comment, state) {
  const content = extractCommentText(comment);
  const author = comment.author?.username || comment.profiles?.username || comment.user_id || 'someone';

  // Fast pre-check: if we've seen this exact comment ID AND it's not just 'processing', skip
  const existing = state.entries[comment.id];
  if (existing && existing.category !== 'processing') {
    return { category: 'already_seen', actionable: false, shouldReply: false, reason: 'already processed' };
  }

  // Build memory context for the LLM
  const recentActions = (state.checklist || []).slice(-8).map(c =>
    `- [${c.category}] ${c.what} (${c.at?.slice(0, 10) || 'unknown date'})`
  ).join('\n');

  const memorySection = recentActions
    ? `\nRECENT CHANGES ALREADY MADE TO THIS PROJECT:\n${recentActions}\n`
    : '';

  const res = await callModel([
    { role: 'system', content: getTriagePrompt() },
    { role: 'user', content: `Comment from @${author}: ${content}${memorySection}` },
  ]);

  const text = res.choices?.[0]?.message?.content || '';
  try {
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    // Normalize field names for robustness
    return {
      category: result.category || 'unclear',
      actionable: !!result.actionable,
      reasoning: result.reasoning || result.reason || '',
      decisionReply: result.decisionReply || result.replyText || '',
      editPrompt: result.editPrompt || '',
      tags: result.tags || [],
    };
  } catch {
    return { category: 'unclear', actionable: false, reasoning: 'could not parse LLM response', decisionReply: '', editPrompt: '', tags: [] };
  }
}

// ── Action a comment ────────────────────────────────────────────────

function extractCommentText(comment) {
  const raw = comment.raw_content || '';
  if (raw.trim()) return raw.trim();
  if (typeof comment.content === 'object' && comment.content?.children) {
    const parts = [];
    const walk = (nodes) => { for (const n of nodes) { if (n.text) parts.push(n.text); if (n.children) walk(n.children); } };
    walk(comment.content.children);
    return parts.join(' ').trim();
  }
  return '';
}

async function actionComment(projectAlias, comment, state) {
  const content = extractCommentText(comment);
  const author = comment.author?.username || comment.profiles?.username || comment.user_id || 'someone';
  const commentId = comment.id;

  // CLAIM the comment immediately + persist, so a poll that fires while we're
  // still replying/building (builds take minutes) can't re-trigger this same
  // comment and double-reply. Re-entrancy guard is the real fix for the
  // "replies multiple times in a row" loop.
  if (state.entries[commentId] && state.entries[commentId]?.category !== 'processing') return; // already fully processed
  state.entries[commentId] = { id: commentId, category: 'processing', at: new Date().toISOString(), author };
  saveBotState(state);

  console.log(`\n📝 @${author}: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`);

  if (!content.trim()) {
    state.entries[commentId] = { id: commentId, category: 'empty', at: new Date().toISOString() };
    return saveBotState(state);
  }

  const dup = isDuplicateRequest(content, state);
  if (dup) {
    console.log(`   🔄 Duplicate of earlier request`);
    state.entries[commentId] = { id: commentId, category: 'duplicate', at: new Date().toISOString() };
    return saveBotState(state);
  }

  // ── Step 1: Reason ──
  console.log(`   🧠 Reasoning...`);
  const decision = await triageComment(comment, state);

  const emoji = { feature_request: '✨', bug_fix: '🐛', ui_change: '🎨', content_change: '✏️',
    question: '❓', praise: '❤️', spam: '🗑️', abuse: '🚫', greeting: '👋', unclear: '🤷' }[decision.category] || '📌';

  console.log(`   ${emoji} ${decision.category} → ${decision.actionable ? 'BUILD' : 'PASS'}`);
  console.log(`   ↳ ${decision.reasoning}`);

  state.entries[commentId] = { id: commentId, category: decision.category,
    at: new Date().toISOString(), reasoning: decision.reasoning,
    actionable: decision.actionable, author, snippet: content.slice(0, 120) };

  // already_seen = silent skip — don't reply, don't build
  if (decision.category === 'already_seen') return saveBotState(state);

  // ── Step 2: Reply with decision ──
  const WIP_PREFIX = '⚠️ *Heads up — heavy work in progress! If the AI responds multiple times in a row, pardon our dust.*\n\n';
  const replyText = WIP_PREFIX + (decision.decisionReply ||
    (decision.actionable ? `Great idea! I'll build this now.` : `Thanks for the comment!`));
  try {
    await mcpClient.callTool({ name: 'post_reply',
      arguments: { project: projectAlias, comment_id: commentId, content: replyText } });
    console.log(`   💬 Decision reply sent.`);
  } catch (err) { console.error(`   ⚠️ Reply failed: ${err.message}`); }

  saveBotState(state);

  // ── Step 3: Build (if actionable) ──
  if (!decision.actionable || !decision.editPrompt) return;

  console.log(`   🛠️  Building: "${decision.editPrompt.slice(0, 120)}..."`);
  try {
    const outcome = await runAgent(decision.editPrompt, projectAlias);

    if (outcome && outcome.edited) {
      // A real change was published — record it and post the done reply ONCE.
      state.checklist.push({ what: decision.editPrompt, category: decision.category,
        commentId, author, at: new Date().toISOString(), tags: decision.tags || [] });
      if (decision.category === 'feature_request') {
        state.featureRequests.push({ commentId, content, at: new Date().toISOString() });
      }
      state.entries[commentId].built = true;
      state.entries[commentId].builtAt = new Date().toISOString();

      const doneReply = `✅ Done! Refresh to see the changes.\n\n> ${outcome.summary || decision.reasoning}\n\nLet me know if you want anything tweaked!`;
      await mcpClient.callTool({ name: 'post_reply',
        arguments: { project: projectAlias, comment_id: commentId, content: doneReply } });
      console.log(`   ✅ Build complete + done reply sent.`);
    } else {
      // The agent finished WITHOUT publishing anything. Do NOT claim success
      // (this was the "Done! added 999 bombs" with no actual change bug).
      state.entries[commentId].built = false;
      state.entries[commentId].buildError = 'agent made no file changes';
      console.warn(`   ⚠️ Agent produced no changes — not posting a success reply.`);
      await mcpClient.callTool({ name: 'post_reply',
        arguments: { project: projectAlias, comment_id: commentId,
          content: `Hmm, I couldn't make that change cleanly this time — I'll need another pass. Mind rephrasing or adding detail?` } });
    }
  } catch (err) {
    console.error(`   ❌ Build failed: ${err.message}`);
    state.entries[commentId].buildError = err.message.slice(0, 200);
    try {
      await mcpClient.callTool({ name: 'post_reply',
        arguments: { project: projectAlias, comment_id: commentId,
          content: `😅 Hit a snag: ${err.message.slice(0, 150)}.` } });
    } catch {}
  }

  saveBotState(state);
}

// ── Daemon loop ─────────────────────────────────────────────────────

async function daemonLoop(projectAlias) {
  const state = loadBotState();

  // One-time prune on startup
  pruneOldEntries(state);
  saveBotState(state);

  const total = Object.keys(state.entries).length;
  const actioned = Object.values(state.entries).filter(e => e.category === 'actioned' || e.category === 'feature_request').length;
  const checklistDone = (state.checklist || []).length;

  console.log(`\n🤖 Daemon started`);
  console.log(`   Project:   ${projectAlias || '(default)'}`);
  const intervalSec = Math.round(CONFIG.watchIntervalMs / 1000);
  const intervalDisplay = intervalSec < 60 ? `${intervalSec}s` : `${Math.round(intervalSec / 60)}m`;
  console.log(`   Interval:  ${intervalDisplay} (API poll = cheap, AI only for new comments)`);
  console.log(`   Memory:    ${total} comments seen, ${actioned} actioned, ${checklistDone} checklist items`);
  console.log(`   Pruning:   entries > ${STATE_MAX_AGE_DAYS}d auto-removed`);
  if (state.lastRun) console.log(`   Last run:  ${state.lastRun}`);
  console.log(`\n   Watching for comments... (Ctrl+C to stop)\n`);

  // First run
  await pollAndAction(projectAlias, state);

  // Loop — the comment list API call is cheap (no AI), AI only fires for new comments
  const timer = setInterval(async () => {
    await pollAndAction(projectAlias, state);
  }, CONFIG.watchIntervalMs);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n🛑 Shutting down...');
    clearInterval(timer);
    pruneOldEntries(state);
    saveBotState(state);
    await stopMCP();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Poll cycle (fast API check → AI only for new) ───────────────────

async function pollAndAction(projectAlias, state) {
  const now = new Date().toISOString();
  const ts = now.slice(0, 19).replace('T', ' ');

  try {
    // Step 1: Cheap API call — no AI involved
    const result = await mcpClient.callTool({
      name: 'list_comments',
      arguments: { project: projectAlias, limit: 30 },
    });
    const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    let comments;
    // Try structured {project, comments} format first, then plain array, then legacy prefix
    try {
      const parsed = JSON.parse(text);
      comments = parsed.comments || parsed;
      if (!Array.isArray(comments)) comments = [];
    } catch {
      // Legacy format: strip MCP prefix before JSON array
      const cleaned = text.replace(/^\[.*?\]\s*\w+:\s*/s, '').trim();
      try { comments = JSON.parse(cleaned); } catch { comments = []; }
    }

    // Step 2: Filter out our own comments (prevents self-reply loops). Match by
    // username (case-insensitive) OR by a learned self user-id — the hardcoded
    // 'Opus_4_8' default silently failed whenever the real account differed,
    // which is what made the bot reply to its own comments.
    const botName = (CONFIG.botUsername || '').toLowerCase();
    const selfIds = new Set(state.selfIds || []);
    const isSelf = (c) => {
      const uname = (c.author?.username || c.profiles?.username || '').toLowerCase();
      const uid = c.author?.id || c.user_id || '';
      return (botName && uname === botName) || (uid && selfIds.has(uid));
    };
    // Learn our own user-id from any comment matching the bot username, so the
    // id-based filter keeps working even if the username is later misconfigured.
    if (botName) {
      for (const c of comments) {
        const uname = (c.author?.username || c.profiles?.username || '').toLowerCase();
        const uid = c.author?.id || c.user_id || '';
        if (uname === botName && uid && !selfIds.has(uid)) { selfIds.add(uid); state.selfIds = [...selfIds]; }
      }
    }
    const foreignComments = comments.filter(c => !isSelf(c));
    const selfCount = comments.length - foreignComments.length;

    // Step 3: Fast-path — find genuinely new IDs (no AI, just array lookup)
    const newComments = foreignComments.filter(c => !state.entries[c.id]);

    if (newComments.length === 0) {
      const nextIn = CONFIG.watchIntervalMs < 60000 ? `${Math.round(CONFIG.watchIntervalMs / 1000)}s` : `${Math.round(CONFIG.watchIntervalMs / 60000)}m`;
      const selfNote = selfCount > 0 ? ` (${selfCount} self-comments skipped)` : '';
      console.log(`[${ts}] ✓ No new (${comments.length} total${selfNote}). Next in ${nextIn}.`);
    } else {
      console.log(`[${ts}] 🔍 ${comments.length} total, ${newComments.length} NEW → AI triaging...${selfCount > 0 ? ` (${selfCount} self skipped)` : ''}`);
    }

    // Step 3: Only invoke AI for the new ones
    for (const comment of newComments) {
      await actionComment(projectAlias, comment, state);
    }

    // Periodic pruning (every ~10 polls)
    if (Math.random() < 0.1) pruneOldEntries(state);

    state.lastRun = now;
    saveBotState(state);
  } catch (err) {
    console.error(`[${ts}] ⚠️ Poll error: ${err.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  let projectAlias = null;
  let prompt = '';
  let interactive = false;
  let listProjects = false;
  let watch = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' || args[i] === '-p') {
      projectAlias = args[++i];
    } else if (args[i] === '--interactive' || args[i] === '-i') {
      interactive = true;
    } else if (args[i] === '--watch' || args[i] === '-w' || args[i] === '--daemon') {
      watch = true;
    } else if (args[i] === '--list-projects') {
      listProjects = true;
    } else if (args[i] === '--model' || args[i] === '-m') {
      CONFIG.model = args[++i];
    } else if (args[i] === '--interval') {
      CONFIG.watchIntervalMs = (parseInt(args[++i], 10) || 30) * 1000;
    } else if (args[i] === '--help' || args[i] === '-h') {
      usage();
      process.exit(0);
    } else {
      prompt += (prompt ? ' ' : '') + args[i];
    }
  }

  if (listProjects) {
    const cfg = loadProjectsConfig();
    console.log(JSON.stringify(Object.entries(cfg.projects || {}).map(([k, v]) => ({
      alias: k, id: v.id, slug: v.slug, label: v.label, isDefault: k === cfg.defaultProject,
    })), null, 2));
    process.exit(0);
  }

  // Validate config
  if (!CONFIG.apiKey) {
    console.error('❌ OPENAI_API_KEY not set. Copy .env.example to .env and fill in your values.');
    process.exit(1);
  }

  // Start MCP
  try {
    await startMCP();
  } catch (err) {
    console.error('❌ Failed to start MCP server:', err.message);
    process.exit(1);
  }

  // Handle process exit (for one-shot / interactive only — daemon has its own)
  let signalHandled = false;
  const onSig = async () => {
    if (signalHandled) return;
    signalHandled = true;
    console.log('\n👋 Interrupted. Shutting down...');
    await stopMCP();
    process.exit(0);
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  // Daemon / watch mode
  if (watch) {
    await daemonLoop(projectAlias);
    return; // daemonLoop has its own shutdown handlers
  }

  // Interactive mode
  if (interactive || !prompt) {
    await interactiveMode();
    return;
  }

  // One-shot mode
  try {
    await runAgent(prompt, projectAlias);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    if (CONFIG.debug) console.error(err);
    process.exitCode = 1;
  } finally {
    await stopMCP();
  }
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  await stopMCP();
  process.exit(1);
});
