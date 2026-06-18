#!/usr/bin/env node
/**
 * websim AI agent v2.2 — instant queue alerts + background announcements
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fs = require('fs');
const nodePath = require('path');
require('dotenv').config();

const CONFIG = {
  baseUrl:   (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  apiKey:    process.env.OPENAI_API_KEY || '',
  model:     process.env.OPENAI_MODEL || '',
  maxTurns:  parseInt(process.env.AGENT_MAX_TURNS || '15', 10),
  apiTimeoutMs: parseInt(process.env.AGENT_API_TIMEOUT_SECONDS || '60', 10) * 1000,
  debug:     process.env.AGENT_DEBUG === 'true',
  watchIntervalMs: parseInt(process.env.AGENT_WATCH_INTERVAL_SECONDS || '10', 10) * 1000,
  queueAnnounceMs: 30000, // re-announce positions every 30s for all waiting
  botUsername: process.env.WEBSIM_BOT_USERNAME || 'Opus_4_8',
};

const RANDOM_QUOTES = [
  "Good things come to those who wait! 🌟",
  "Cooking up something special... 🍳",
  "The AI is thinking really hard right now! 🧠",
  "Quality takes time! ⏳",
  "Your patience is legendary! 👑",
  "Building with love and circuits... ❤️",
  "Rome wasn't built in a day! 🏛️",
  "Every masterpiece needs its time... 🎨",
  "Good code is worth the wait! 💻",
  "Hang tight, magic incoming! ✨",
];

function log(...args) { if (CONFIG.debug) console.error('[agent]', ...args); }

const PROJECTS_CONFIG_PATH = nodePath.join(__dirname, 'projects.config.json');
function loadProjectsConfig() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_CONFIG_PATH, 'utf8')); }
  catch { return { projects: {}, defaultProject: null }; }
}

let mcpClient = null;
let mcpTransport = null;
let mcpTools = [];

async function startMCP() {
  mcpTransport = new StdioClientTransport({
    command: 'node', args: [nodePath.join(__dirname, 'mcp-server.js')],
    env: { ...process.env }, stderr: 'pipe',
  });
  mcpTransport.stderr?.on('data', d => { const m = d.toString().trim(); if (m) console.error('[mcp]', m); });
  mcpClient = new Client({ name: 'websim-agent', version: '2.2.0' }, { capabilities: {} });
  await mcpClient.connect(mcpTransport);
  const r = await mcpClient.listTools();
  mcpTools = r.tools || [];
}

async function stopMCP() {
  try { if (mcpClient) await mcpClient.close(); } catch {}
  mcpClient = null; mcpTransport = null; mcpTools = [];
}

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

async function callModel(messages, tools) {
  const body = { model: CONFIG.model, messages, max_tokens: 4096 };
  if (tools && tools.length > 0) { body.tools = tools; body.tool_choice = 'auto'; }
  const ctrl = new AbortController();
  const started = Date.now();
  const timeoutSec = Math.round(CONFIG.apiTimeoutMs / 1000);
  console.log(`   🌐 model call → ${CONFIG.model} (${tools?.length || 0} tools, timeout ${timeoutSec}s)`);

  let timer;
  try {
    const fetchPromise = fetch(CONFIG.baseUrl + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.apiKey}` },
      body: JSON.stringify(body),
    });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error(`API timeout after ${timeoutSec}s`));
      }, CONFIG.apiTimeoutMs);
    });
    const res = await Promise.race([fetchPromise, timeoutPromise]);
    const text = await Promise.race([
      res.text(),
      new Promise((_, reject) => setTimeout(() => {
        ctrl.abort();
        reject(new Error(`API body timeout after ${timeoutSec}s`));
      }, CONFIG.apiTimeoutMs))
    ]);
    console.log(`   🌐 model response ← ${res.status} (${Date.now() - started}ms)`);
    if (!res.ok) throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`API timeout after ${timeoutSec}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Agent loop ─────────────────────────────────────────────────────
async function runAgent(prompt, projectAlias) {
  const tools = mcpTools.map(mcpToolToOpenAI);
  const guide = loadClaudeGuide();
  const guideSection = guide ? `\n\nGUIDE:\n${guide.slice(0, 3000)}\n` : '';
  const messages = [
    { role: 'system', content: `You edit a websim.com project. Use TOOLS — never describe changes in prose.

WORKFLOW:
1. list_revisions → find latest
2. create_revision(parent_version=latest) → draft
3. download_file → read contents
4. For small edits, prefer replace_in_file → stage exact local patches. Use write_file only when replacing/creating a whole file.
5. upload_file → push
6. finish_revision → publish (MANDATORY!)
7. set_current_revision → make live
Stop and give 1-2 sentence summary.

Project: "${projectAlias || 'default'}". Always start with list_revisions.${guideSection}` },
    { role: 'user', content: prompt },
  ];

  console.log(`\n🤖 Building: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  const MUTATING = new Set(['upload_file', 'finish_revision', 'set_current_revision', 'delete_file', 'create_revision', 'replace_in_file']);
  let edited = false, published = false, publishRetries = 0, writtenFiles = [];

  for (let turn = 0; turn < CONFIG.maxTurns; turn++) {
    const response = await callModel(messages, tools);
    const msg = response.choices?.[0]?.message;
    if (!msg) { console.log('⚠️ Empty response.'); break; }
    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0) {
      if (edited && !published && publishRetries < 3) {
        publishRetries++;
        console.log(`   ⚠️ Not published (retry ${publishRetries}/3)`);
        messages.push({ role: 'user', content: 'Call finish_revision then set_current_revision NOW. Do NOT download anything else.' });
        continue;
      }
      const summary = (msg.content || '').trim();
      if (summary) console.log(summary.slice(0, 400));
      messages.push({ role: 'assistant', content: summary });
      console.log(edited ? (published ? '✅ Published.' : '⚠️ Uploaded but not published.') : '⚠️ No changes.');
      return { ok: edited && published, summary, edited };
    }

    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      if (!args.project && projectAlias) args.project = projectAlias;

      if (name === 'write_file' && args.path) { writtenFiles.push(args.path); edited = true; }

      // Auto-upload: if downloading a file we already wrote, upload instead
      if (name === 'download_file' && args.path && writtenFiles.includes(args.path)) {
        console.log(`   ⚡ Auto-uploading ${args.path}...`);
        try {
          const uploadRes = await mcpClient.callTool({ name: 'upload_file', arguments: { project: projectAlias, path: args.path, revision: args.revision } });
          const uploadText = uploadRes.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          console.log(`   ↳ ${uploadText.slice(0, 200)}`);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: uploadText });
          messages.push({ role: 'user', content: `Uploaded ${args.path}. Now call finish_revision and set_current_revision.` });
          edited = true;
        } catch (err) { messages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${err.message}` }); }
        continue;
      }

      if (MUTATING.has(name)) edited = true;
      if (name === 'finish_revision') published = true;
      console.log(`   🔧 ${name}(${JSON.stringify(args).slice(0, 100)})`);
      let result;
      try {
        const res = await mcpClient.callTool({ name, arguments: args });
        result = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        console.log(`   ↳ ${result.slice(0, 200)}`);
      } catch (err) { result = `Error: ${err.message}`; console.error(`   ❌ ${err.message}`); }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  console.log(`⚠️ Max turns (${CONFIG.maxTurns}) reached.`);
  return { ok: edited && published, summary: '', edited };
}

// ── CLAUDE.md loader ───────────────────────────────────────────────
let _claudeGuide = '';
function loadClaudeGuide() {
  if (_claudeGuide) return _claudeGuide;
  try { _claudeGuide = fs.readFileSync(nodePath.join(__dirname, 'CLAUDE.md'), 'utf8'); }
  catch { _claudeGuide = ''; }
  return _claudeGuide;
}

// ── Comment helpers ────────────────────────────────────────────────
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

// ── Triage ─────────────────────────────────────────────────────────
const TRIAGE_PROMPT = `You triage comments for a websim project. Decide if a comment is worth building.

Reply JSON ONLY:
{"category":"feature_request|bug_fix|ui_change|content_change|question|praise|spam|abuse|greeting|unclear","actionable":true/false,"reasoning":"why","decisionReply":"friendly public reply","editPrompt":"precise instructions if actionable"}

Default to actionable. Interpret vaguely but generously. Greetings → welcome + ask what to build. Questions → answer. Links-only → spam.`;

async function triageComment(comment) {
  const content = extractCommentText(comment);
  const author = comment.author?.username || 'someone';
  const guide = loadClaudeGuide();
  const ctx = guide ? `\nPROJECT CONTEXT:\n${guide.slice(0, 3000)}` : '';
  const res = await callModel([
    { role: 'system', content: TRIAGE_PROMPT + ctx },
    { role: 'user', content: `From @${author}: ${content}` },
  ], []);
  try {
    const d = JSON.parse((res.choices?.[0]?.message?.content||'').replace(/```json|```/g, '').trim());
    return { category: d.category||'unclear', actionable: !!d.actionable, reasoning: d.reasoning||'', decisionReply: d.decisionReply||'', editPrompt: d.editPrompt||'' };
  } catch {
    return { category:'unclear', actionable:false, reasoning:'parse error', decisionReply:'', editPrompt:'' };
  }
}

// ── Daemon State ───────────────────────────────────────────────────
const BOT_STATE_PATH = nodePath.join(__dirname, 'comment-bot-seen.json');
function loadBotState() {
  try {
    const s = JSON.parse(fs.readFileSync(BOT_STATE_PATH, 'utf8'));
    s.entries = s.entries || {};
    s.queue = s.queue || [];
    s.checklist = s.checklist || [];
    return s;
  } catch {
    return { entries: {}, queue: [], checklist: [], currentlyProcessing: null, lastAnnounce: null, lastRun: null };
  }
}
function saveBotState(state) { fs.writeFileSync(BOT_STATE_PATH, JSON.stringify(state, null, 2)); }

// ── Queue System ───────────────────────────────────────────────────

// Fire-and-forget reply helper (never blocks)
function bgReply(projectAlias, commentId, content) {
  mcpClient.callTool({ name: 'post_reply', arguments: { project: projectAlias, comment_id: commentId, content } }).catch(() => {});
}

function addToQueue(state, comment) {
  const author = comment.author?.username || '';
  const content = extractCommentText(comment);
  if (!content.trim()) return;
  if (state.queue.find(q => q.commentId === comment.id)) return;
  if (state.entries[comment.id]?.category === 'cleared') return;

  // Admin commands (Endoxidev only)
  if (author === 'Endoxidev' && content.startsWith('!')) {
    handleAdminCommand(content, comment, state);
    return;
  }

  const item = { commentId: comment.id, author, content: content.slice(0, 200), addedAt: new Date().toISOString() };
  author === 'Endoxidev' ? state.queue.unshift(item) : state.queue.push(item);

  const pos = state.queue.indexOf(item) + 1;
  const total = state.queue.length;
  console.log(`   ${author === 'Endoxidev' ? '⭐' : '📥'} @${author} → queue #${pos}/${total}`);

  // IMMEDIATE queue alert — first reply, non-blocking
  const quote = RANDOM_QUOTES[Math.floor(Math.random() * RANDOM_QUOTES.length)];
  const statusLine = (pos === 1 && state.currentlyProcessing) ? `**#1** — currently being built! 🔨` : `**#${pos}** of ${total}`;
  bgReply(state._projectAlias || 'opus48', comment.id,
    `⚠️ *Heads up — heavy work in progress!*\n\nYour spot in the generation queue: ${statusLine}. Please be patient!\n\n> ${quote}`);
}

async function handleAdminCommand(content, comment, state) {
  const cmd = content.trim().toLowerCase();
  const proj = state._projectAlias || 'opus48';
  const WIP = '⚠️ *Admin command received.*\n\n';

  if (cmd === '!clearqueue' || cmd === '!clear') {
    const count = state.queue.length;
    console.log(`   🔧 !clearqueue: clearing ${count} items...`);

    // Mark all queued entries as 'cleared' so they never re-process
    for (const item of state.queue) {
      state.entries[item.commentId] = { id: item.commentId, category: 'cleared', at: new Date().toISOString() };
    }
    state.currentlyProcessing = null;

    // Notify each removed user (rate-limited: 1s apart)
    for (const item of state.queue) {
      bgReply(proj, item.commentId, `⚠️ *Build queue cleared by admin.*\n\nYour request (${item.content.slice(0, 60)}...) has been removed. Feel free to resubmit with a new comment!`);
      await new Promise(r => setTimeout(r, 1000));
    }

    state.queue = [];
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);

    bgReply(proj, comment.id, `✅ **Queue cleared!** ${count} items removed, all ${count} users notified.\n\nComments marked as cleared won't re-process. Post new comments to re-enter the queue.`);
    console.log(`   🔧 Queue cleared: ${count} items removed + notified`);

  } else if (cmd === '!status' || cmd === '!stats') {
    const s = state.queue.length;
    const b = state.checklist.length;
    const cp = state.currentlyProcessing ? 'building' : 'idle';
    bgReply(proj, comment.id, `📊 **Status:** ${s} in queue | ${b} built | Currently: ${cp}`);
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    console.log(`   🔧 ${cmd}: ${s} queued, ${b} built, ${cp}`);
  } else {
    console.log(`   ⚠️ Unknown admin command: ${cmd}`);
  }
}

async function announceQueuePositions(projectAlias, state) {
  if (state.queue.length === 0) return;
  const now = Date.now();
  const last = state.lastAnnounce ? new Date(state.lastAnnounce).getTime() : 0;
  if (now - last < CONFIG.queueAnnounceMs && state.queue.length > 0 && last > 0) return;

  console.log(`   📢 Announcing positions to ${state.queue.length} waiting...`);
  const WIP = '⚠️ *Heads up — heavy work in progress!*\n\n';

  for (let i = 0; i < state.queue.length; i++) {
    const item = state.queue[i];
    const quote = RANDOM_QUOTES[Math.floor(Math.random() * RANDOM_QUOTES.length)];
    const statusLine = (i === 0 && state.currentlyProcessing) ? `**#1** — currently being built! 🔨` : `**#${i + 1}** of ${state.queue.length}`;
    bgReply(projectAlias, item.commentId, `${WIP}Your spot in the generation queue: ${statusLine}. Please be patient!\n\n> ${quote}`);
    await new Promise(r => setTimeout(r, 1500)); // rate limit between replies
  }

  state.lastAnnounce = new Date().toISOString();
  saveBotState(state);
}

async function processNextInQueue(projectAlias, state) {
  if (state.queue.length === 0 || state.currentlyProcessing) return;

  const item = state.queue.shift();
  state.currentlyProcessing = item.commentId;
  state.entries[item.commentId] = { id: item.commentId, category: 'processing', at: new Date().toISOString(), author: item.author, snippet: item.content.slice(0, 120) };
  saveBotState(state);

  // Announce updated positions (now that #1 is being processed)
  announceQueuePositions(projectAlias, state).catch(() => {});

  console.log(`\n🛠️  Processing: @${item.author}: "${item.content.slice(0, 80)}..."`);

  const WIP = '⚠️ *Heads up — heavy work in progress! Pardon our dust.*\n\n';
  const comment = { id: item.commentId, content: item.content, raw_content: item.content, author: { username: item.author } };

  // Triage
  console.log('   🧠 Reasoning...');
  const decision = await triageComment(comment);
  const emojis = { feature_request:'✨', bug_fix:'🐛', ui_change:'🎨', content_change:'✏️', question:'❓', praise:'❤️', spam:'🗑️', abuse:'🚫', greeting:'👋', unclear:'🤷' };
  console.log(`   ${emojis[decision.category]||'📌'} ${decision.category} → ${decision.actionable ? 'BUILD' : 'PASS'}`);
  console.log(`   ↳ ${decision.reasoning}`);

  // Reply with decision
  bgReply(projectAlias, item.commentId, WIP + (decision.decisionReply || (decision.actionable ? "Great idea! I'll build this now." : "Thanks for the comment!")));
  console.log('   💬 Decision reply sent.');

  // Build
  if (decision.actionable && decision.editPrompt) {
    console.log('   🛠️  Building...');
    try {
      const result = await runAgent(decision.editPrompt, projectAlias);
      state.checklist.push({ what: decision.editPrompt, category: decision.category, commentId: item.commentId, author: item.author, at: new Date().toISOString() });
      state.entries[item.commentId].built = result.ok;
      state.entries[item.commentId].builtAt = new Date().toISOString();
      bgReply(projectAlias, item.commentId, `${WIP}✅ Done! Refresh to see the changes.\n\n> ${decision.reasoning}\n\nLet me know if you want tweaks!`);
      console.log('   ✅ Build complete.');
    } catch (err) {
      console.error(`   ❌ Build failed: ${err.message}`);
      state.entries[item.commentId].buildError = err.message.slice(0, 200);
      bgReply(projectAlias, item.commentId, `${WIP}😅 Hit a snag: ${err.message.slice(0, 150)}. Moving on...`);
    }
  }

  state.currentlyProcessing = null;
  saveBotState(state);

  // Process next + announce updated positions
  if (state.queue.length > 0) {
    console.log(`   📋 ${state.queue.length} remaining — announcing + processing next...`);
    announceQueuePositions(projectAlias, state).catch(() => {});
    await processNextInQueue(projectAlias, state);
  }
}

// ── Daemon Loop ────────────────────────────────────────────────────
async function daemonLoop(projectAlias) {
  const state = loadBotState();
  state._projectAlias = projectAlias;
  if (state.currentlyProcessing) state.currentlyProcessing = null;
  saveBotState(state);

  const intSec = Math.round(CONFIG.watchIntervalMs / 1000);
  console.log(`\n🤖 Daemon v2.2 | Model: ${CONFIG.model} | Poll: ${intSec}s | Priority: @Endoxidev`);
  console.log(`   Queue: ${state.queue.length} | Built: ${state.checklist.length} | Admin: !clearqueue, !status, !stats\n`);

  await pollAndEnqueue(projectAlias, state);

  const pollTimer = setInterval(() => pollAndEnqueue(projectAlias, state), CONFIG.watchIntervalMs);
  const announceTimer = setInterval(() => announceQueuePositions(projectAlias, state), CONFIG.queueAnnounceMs);

  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    clearInterval(pollTimer); clearInterval(announceTimer);
    state.currentlyProcessing = null;
    saveBotState(state);
    await stopMCP();
    process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

async function pollAndEnqueue(projectAlias, state) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    const res = await mcpClient.callTool({ name: 'list_comments', arguments: { project: projectAlias, limit: 50 } });
    const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    let comments;
    try { const p = JSON.parse(text); comments = p.comments || p; } catch { comments = []; }
    if (!Array.isArray(comments)) comments = [];

    const foreign = comments.filter(c => (c.author?.username || '') !== CONFIG.botUsername);
    const selfCount = comments.length - foreign.length;
    const newComments = foreign.filter(c => !state.entries[c.id] && !state.queue.find(q => q.commentId === c.id));

    for (const c of newComments) {
      state.entries[c.id] = { id: c.id, category: 'queued', at: new Date().toISOString(), author: c.author?.username };
      addToQueue(state, c);
    }
    saveBotState(state);

    if (newComments.length > 0) {
      const sn = selfCount > 0 ? ` (${selfCount} self skipped)` : '';
      console.log(`[${ts}] ${newComments.length} new → queue now ${state.queue.length}${sn}`);
      // Announce positions immediately when queue changes
      announceQueuePositions(projectAlias, state).catch(() => {});
    }

    if (!state.currentlyProcessing && state.queue.length > 0) {
      await processNextInQueue(projectAlias, state);
    }

    state.lastRun = new Date().toISOString();
    saveBotState(state);
  } catch (err) { console.error(`[${ts}] ⚠️ ${err.message}`); }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  let projectAlias = undefined, prompt = '', interactive = false, watch = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' || args[i] === '-p') projectAlias = args[++i];
    else if (args[i] === '--watch' || args[i] === '-w' || args[i] === '--daemon') watch = true;
    else if (args[i] === '--list-projects') {
      const c = loadProjectsConfig();
      console.log(JSON.stringify(Object.entries(c.projects||{}).map(([k,v])=>({alias:k,id:v.id,slug:v.slug})),null,2));
      process.exit(0);
    }
    else prompt += (prompt?' ':'') + args[i];
  }

  if (!CONFIG.apiKey) { console.error('❌ OPENAI_API_KEY not set'); process.exit(1); }
  if (!CONFIG.model) { console.error('❌ OPENAI_MODEL not set'); process.exit(1); }
  try { await startMCP(); } catch (err) { console.error('❌ MCP:', err.message); process.exit(1); }
  process.on('SIGINT', async () => { await stopMCP(); process.exit(0); });

  if (watch) { await daemonLoop(projectAlias); return; }
  try { await runAgent(prompt, projectAlias); } catch (err) { console.error(`\n❌ ${err.message}`); } finally { await stopMCP(); }
}

main().catch(async e => { console.error('Fatal:', e); await stopMCP(); process.exit(1); });
