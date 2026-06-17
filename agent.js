#!/usr/bin/env node
/**
 * websim AI agent v2
 *
 * Spawns the multi-project MCP server, converts tools to OpenAI function format,
 * and runs an agent loop against any OpenAI-compatible endpoint.
 *
 * Usage:
 *   node agent.js "Add a dark mode toggle"
 *   node agent.js --interactive       (chat mode)
 *   node agent.js --watch -p opus48   (daemon mode, polls comments every N seconds)
 *   node agent.js --list-projects
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fs = require('fs');
const nodePath = require('path');
require('dotenv').config();

// ── Config ─────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:   (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  apiKey:    process.env.OPENAI_API_KEY || '',
  model:     process.env.OPENAI_MODEL || 'gpt-4o',
  maxTurns:  parseInt(process.env.AGENT_MAX_TURNS || '15', 10),
  debug:     process.env.AGENT_DEBUG === 'true',
  watchIntervalMs: parseInt(process.env.AGENT_WATCH_INTERVAL_SECONDS || '30', 10) * 1000,
  botUsername: process.env.WEBSIM_BOT_USERNAME || 'Opus_4_8',
};

function log(...args) { if (CONFIG.debug) console.error('[agent]', ...args); }

const PROJECTS_CONFIG_PATH = nodePath.join(__dirname, 'projects.config.json');

function loadProjectsConfig() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_CONFIG_PATH, 'utf8')); }
  catch { return { projects: {}, defaultProject: null }; }
}

// ── MCP Connection ─────────────────────────────────────────────────
let mcpClient = null;
let mcpTransport = null;
let mcpTools = [];

async function startMCP() {
  mcpTransport = new StdioClientTransport({
    command: 'node', args: [nodePath.join(__dirname, 'mcp-server.js')],
    env: { ...process.env }, stderr: 'pipe',
  });
  mcpTransport.stderr?.on('data', d => { const m = d.toString().trim(); if (m) console.error('[mcp]', m); });
  mcpClient = new Client({ name: 'websim-agent', version: '2.0.0' }, { capabilities: {} });
  await mcpClient.connect(mcpTransport);
  const r = await mcpClient.listTools();
  mcpTools = r.tools || [];
  log(`Connected. ${mcpTools.length} tools.`);
}

async function stopMCP() {
  try { if (mcpClient) await mcpClient.close(); } catch {}
  mcpClient = null; mcpTransport = null; mcpTools = [];
}

// ── Tool conversion: MCP → OpenAI function format ──────────────────
function mcpToolToOpenAI(tool) {
  const props = {}, required = [];
  if (tool.inputSchema?.properties) {
    for (const [k, s] of Object.entries(tool.inputSchema.properties)) {
      props[k] = { type: s.type || 'string', description: s.description || '' };
      if (s.enum) props[k].enum = s.enum;
    }
    required.push(...(tool.inputSchema.required || []));
  }
  return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: { type: 'object', properties: props, required } } };
}

// ── API call ───────────────────────────────────────────────────────
async function callModel(messages, tools) {
  const body = { model: CONFIG.model, messages, max_tokens: 4096 };
  if (tools && tools.length > 0) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(CONFIG.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ── Agent loop ─────────────────────────────────────────────────────
async function runAgent(prompt, projectAlias) {
  const tools = mcpTools.map(mcpToolToOpenAI);
  const messages = [
    { role: 'system', content: `You edit a websim.com project. Use tools to make changes.

WORKFLOW:
1. list_revisions → see current state
2. create_revision(parent_version=N) → make editable draft
3. download_file + write_file + upload_file → edit files
4. finish_revision + set_current_revision → publish

Always include "project":"${projectAlias || 'default'}" in tool arguments.` },
    { role: 'user', content: prompt },
  ];

  console.log(`\n🤖 Building with ${tools.length} tools: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  for (let turn = 0; turn < CONFIG.maxTurns; turn++) {
    const response = await callModel(messages, tools);
    const msg = response.choices?.[0]?.message;
    if (!msg) throw new Error('No message in response');
    messages.push(msg);

    if (msg.content) console.log(msg.content.slice(0, 300));

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) { console.log('\n✅ Done.'); return; }

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      const args = JSON.parse(tc.function?.arguments || '{}');
      if (!args.project && projectAlias) args.project = projectAlias;
      console.log(`   🔧 ${name}(${JSON.stringify(args).slice(0, 100)})`);
      try {
        const res = await mcpClient.callTool({ name, arguments: args });
        const result = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        console.log(`   ↳ ${result.slice(0, 200)}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      } catch (err) {
        console.error(`   ❌ ${err.message}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${err.message}` });
      }
    }
  }
  console.log(`⚠️ Max turns (${CONFIG.maxTurns}) reached.`);
}

// ── Interactive mode ───────────────────────────────────────────────
async function interactiveMode() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n💬 You > ' });
  console.log(`\n🔌 websim AI agent | Model: ${CONFIG.model} | Endpoint: ${CONFIG.baseUrl}`);
  console.log('   Type "exit" to quit, "projects" to list projects.\n');
  const cfg = loadProjectsConfig();
  let currentProject = cfg.defaultProject || 'main';
  rl.prompt();
  const handler = async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === 'exit' || input === 'quit') { rl.close(); return; }
    if (input === 'projects') { console.log(JSON.stringify(Object.entries(cfg.projects||{}).map(([k,v])=>({alias:k,id:v.id,slug:v.slug,label:v.label,isDefault:k===cfg.defaultProject})),null,2)); rl.prompt(); return; }
    if (input.startsWith('/project ')) { currentProject = input.slice(9).trim(); console.log(`   ↳ Project: "${currentProject}"`); rl.prompt(); return; }
    try { await runAgent(input, currentProject); } catch (err) { console.error(`\n❌ ${err.message}`); }
    rl.prompt();
  };
  rl.on('line', l => handler(l));
  rl.on('close', async () => { console.log('\n👋 Goodbye!'); await stopMCP(); process.exit(0); });
}

// ── Daemon / Bot Mode ──────────────────────────────────────────────

const BOT_STATE_PATH = nodePath.join(__dirname, 'comment-bot-seen.json');
const STATE_MAX_AGE_DAYS = parseInt(process.env.AGENT_STATE_MAX_AGE_DAYS || '90', 10);

function loadBotState() {
  try {
    return JSON.parse(fs.readFileSync(BOT_STATE_PATH, 'utf8'));
  } catch {
    return { entries: {}, checklist: [], featureRequests: [], lastRun: null };
  }
}
function saveBotState(state) { fs.writeFileSync(BOT_STATE_PATH, JSON.stringify(state, null, 2)); }

function pruneOldEntries(state) {
  const cutoff = Date.now() - STATE_MAX_AGE_DAYS * 86400000;
  let pruned = 0;
  for (const [id, e] of Object.entries(state.entries)) {
    if (e.at && new Date(e.at).getTime() < cutoff) { delete state.entries[id]; pruned++; }
  }
  state.checklist = (state.checklist||[]).filter(c => { if (c.at && new Date(c.at).getTime() < cutoff) { pruned++; return false; } return true; });
  if (pruned) console.log(`   🧹 Pruned ${pruned} old entries.`);
}

function isDuplicateRequest(content, state) {
  const words = content.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  for (const req of (state.featureRequests || [])) {
    const rw = (req.content||'').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.filter(w => rw.includes(w)).length >= Math.min(3, words.length * 0.5)) return req;
  }
  return null;
}

function extractCommentText(comment) {
  const raw = comment.raw_content || '';
  if (raw.trim()) return raw.trim();
  if (typeof comment.content === 'object' && comment.content?.children) {
    const parts = [];
    (function walk(nodes) { for (const n of nodes) { if (n.text) parts.push(n.text); if (n.children) walk(n.children); } })(comment.content.children);
    return parts.join(' ').trim();
  }
  return '';
}

const TRIAGE_PROMPT = `You triage comments for a websim project. Someone leaves a comment — you decide if it's worth building.

RESPOND WITH JSON ONLY:
{
  "category": "feature_request|bug_fix|ui_change|content_change|question|praise|spam|abuse|greeting|unclear",
  "actionable": true/false,
  "reasoning": "why this decision",
  "decisionReply": "your public reply (friendly, 1-3 sentences)",
  "editPrompt": "if actionable: precise implementation instructions"
}

RULES:
- Default to actionable unless clearly spam/abuse
- "make it cooler" → add effects/animations. Generic but buildable.
- Questions → answer helpfully, redirect to builds
- Greetings → welcome them, ask what they want built
- Link-only → spam`;

async function triageComment(comment, state) {
  const content = extractCommentText(comment);
  const author = comment.author?.username || comment.profiles?.username || 'someone';
  if (state.entries[comment.id]) return { category:'already_seen', actionable:false, reasoning:'already processed', decisionReply:'', editPrompt:'' };

  const recent = (state.checklist||[]).slice(-5).map(c => `- ${c.what} (${c.at?.slice(0,10)})`).join('\n');
  const memory = recent ? `\nRecently built:\n${recent}\n` : '';

  const res = await callModel([
    { role: 'system', content: TRIAGE_PROMPT },
    { role: 'user', content: `Comment from @${author}: ${content}${memory}` },
  ], []);

  try {
    const d = JSON.parse((res.choices?.[0]?.message?.content||'').replace(/```json|```/g, '').trim());
    return { category: d.category||'unclear', actionable: !!d.actionable, reasoning: d.reasoning||'', decisionReply: d.decisionReply||'', editPrompt: d.editPrompt||'' };
  } catch {
    return { category:'unclear', actionable:false, reasoning:'parse error', decisionReply:'', editPrompt:'' };
  }
}

async function actionComment(projectAlias, comment, state) {
  const content = extractCommentText(comment);
  const author = comment.author?.username || comment.profiles?.username || 'someone';
  const commentId = comment.id;

  console.log(`\n📝 @${author}: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`);

  if (!content.trim()) { state.entries[commentId] = { id:commentId, category:'empty', at:new Date().toISOString() }; return saveBotState(state); }
  if (isDuplicateRequest(content, state)) { console.log('   🔄 Duplicate'); state.entries[commentId] = { id:commentId, category:'duplicate', at:new Date().toISOString() }; return saveBotState(state); }

  console.log('   🧠 Reasoning...');
  const decision = await triageComment(comment, state);

  const emojis = { feature_request:'✨', bug_fix:'🐛', ui_change:'🎨', content_change:'✏️', question:'❓', praise:'❤️', spam:'🗑️', abuse:'🚫', greeting:'👋', unclear:'🤷' };
  console.log(`   ${emojis[decision.category]||'📌'} ${decision.category} → ${decision.actionable ? 'BUILD' : 'PASS'}`);
  console.log(`   ↳ ${decision.reasoning}`);

  state.entries[commentId] = { id:commentId, category:decision.category, at:new Date().toISOString(), reasoning:decision.reasoning, actionable:decision.actionable, author, snippet:content.slice(0,120) };

  // Reply with decision + WIP prefix
  const WIP = '⚠️ *Heads up — heavy work in progress! Pardon our dust if the AI responds multiple times.*\n\n';
  try {
    await mcpClient.callTool({ name:'post_reply', arguments:{ project:projectAlias, comment_id:commentId, content: WIP + (decision.decisionReply || (decision.actionable ? "Great idea! I'll build this now." : "Thanks for the comment!")) } });
    console.log('   💬 Decision reply sent.');
  } catch(err) { console.error(`   ⚠️ Reply failed: ${err.message}`); }

  saveBotState(state);

  if (!decision.actionable || !decision.editPrompt) return;

  // Build
  console.log(`   🛠️  Building: "${decision.editPrompt.slice(0, 120)}..."`);
  try {
    await runAgent(decision.editPrompt, projectAlias);
    state.checklist.push({ what:decision.editPrompt, category:decision.category, commentId, author, at:new Date().toISOString() });
    if (decision.category === 'feature_request') state.featureRequests.push({ commentId, content, at:new Date().toISOString() });
    state.entries[commentId].built = true; state.entries[commentId].builtAt = new Date().toISOString();

    await mcpClient.callTool({ name:'post_reply', arguments:{ project:projectAlias, comment_id:commentId,
      content: `${WIP}✅ Done! Refresh to see the changes.\n\n> ${decision.reasoning}\n\nLet me know if you want tweaks!` } });
    console.log('   ✅ Build complete + done reply.');
  } catch(err) {
    console.error(`   ❌ Build failed: ${err.message}`);
    state.entries[commentId].buildError = err.message.slice(0, 200);
    try { await mcpClient.callTool({ name:'post_reply', arguments:{ project:projectAlias, comment_id:commentId,
      content: `${WIP}😅 Hit a snag: ${err.message.slice(0,150)}. Trying a different approach...` } }); } catch {}
  }
  saveBotState(state);
}

async function daemonLoop(projectAlias) {
  const state = loadBotState();
  pruneOldEntries(state); saveBotState(state);

  const total = Object.keys(state.entries).length;
  const built = Object.values(state.entries).filter(e => e.built).length;
  const intervalSec = Math.round(CONFIG.watchIntervalMs / 1000);
  const display = intervalSec < 60 ? `${intervalSec}s` : `${Math.round(intervalSec/60)}m`;

  console.log(`\n🤖 Daemon started | Project: ${projectAlias||'default'} | Poll: ${display}`);
  console.log(`   Memory: ${total} seen, ${built} built, ${(state.checklist||[]).length} checklist items`);
  console.log(`   Self-filter: skipping @${CONFIG.botUsername} | WIP prefix: on\n`);

  await pollAndAction(projectAlias, state);
  const timer = setInterval(() => pollAndAction(projectAlias, state), CONFIG.watchIntervalMs);
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; clearInterval(timer); pruneOldEntries(state); saveBotState(state); await stopMCP(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

async function pollAndAction(projectAlias, state) {
  const ts = new Date().toISOString().slice(0,19).replace('T',' ');
  try {
    const res = await mcpClient.callTool({ name:'list_comments', arguments:{ project:projectAlias, limit:30 } });
    const text = res.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    let comments;
    try { const p = JSON.parse(text); comments = p.comments || p; if (!Array.isArray(comments)) comments = []; }
    catch { const m = text.match(/\[[\s\S]*\]/); comments = m ? JSON.parse(m[0]) : []; }

    const foreign = comments.filter(c => (c.author?.username || '') !== CONFIG.botUsername);
    const selfCount = comments.length - foreign.length;
    const newComments = foreign.filter(c => !state.entries[c.id]);

    if (newComments.length === 0) {
      const nextIn = CONFIG.watchIntervalMs < 60000 ? `${Math.round(CONFIG.watchIntervalMs/1000)}s` : `${Math.round(CONFIG.watchIntervalMs/60000)}m`;
      const sn = selfCount > 0 ? ` (${selfCount} self skipped)` : '';
      console.log(`[${ts}] ✓ No new (${comments.length} total${sn}). Next in ${nextIn}.`);
    } else {
      const sn = selfCount > 0 ? ` (${selfCount} self skipped)` : '';
      console.log(`[${ts}] 🔍 ${comments.length} total, ${newComments.length} NEW${sn} → AI triaging...`);
      for (const c of newComments) await actionComment(projectAlias, c, state);
    }
    if (Math.random() < 0.1) pruneOldEntries(state);
    state.lastRun = new Date().toISOString(); saveBotState(state);
  } catch(err) { console.error(`[${ts}] ⚠️ Poll: ${err.message}`); }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let projectAlias = null, prompt = '', interactive = false, watch = false, listProjects = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' || args[i] === '-p') projectAlias = args[++i];
    else if (args[i] === '--interactive' || args[i] === '-i') interactive = true;
    else if (args[i] === '--watch' || args[i] === '-w' || args[i] === '--daemon') watch = true;
    else if (args[i] === '--list-projects') listProjects = true;
    else if (args[i] === '--model' || args[i] === '-m') CONFIG.model = args[++i];
    else if (args[i] === '--interval') CONFIG.watchIntervalMs = (parseInt(args[++i],10)||30) * 1000;
    else if (args[i] === '--help' || args[i] === '-h') { console.log('USAGE: node agent.js [--watch|-w] [--project <alias>] [--interactive|-i] [--list-projects] ["prompt"]'); process.exit(0); }
    else prompt += (prompt?' ':'') + args[i];
  }

  if (listProjects) { const c = loadProjectsConfig(); console.log(JSON.stringify(Object.entries(c.projects||{}).map(([k,v])=>({alias:k,id:v.id,slug:v.slug,label:v.label,isDefault:k===c.defaultProject})),null,2)); process.exit(0); }
  if (!CONFIG.apiKey) { console.error('❌ OPENAI_API_KEY not set in .env'); process.exit(1); }

  try { await startMCP(); } catch(err) { console.error('❌ MCP failed:', err.message); process.exit(1); }

  process.on('SIGINT', async () => { await stopMCP(); process.exit(0); });

  if (watch) { await daemonLoop(projectAlias); return; }
  if (interactive || !prompt) { await interactiveMode(); return; }

  try { await runAgent(prompt, projectAlias); } catch(err) { console.error(`\n❌ ${err.message}`); process.exitCode = 1; } finally { await stopMCP(); }
}

main().catch(async e => { console.error('Fatal:', e); await stopMCP(); process.exit(1); });
