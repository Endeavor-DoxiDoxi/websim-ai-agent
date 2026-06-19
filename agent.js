#!/usr/bin/env node
/**
 * websim AI agent v2.2 — instant queue alerts + background announcements
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fs = require('fs');
const nodePath = require('path');
const { spawn } = require('child_process');
const { BLOCK_MESSAGE, moderateTextForMedia } = require('./moderation.js');
require('dotenv').config();

const CONFIG = {
  baseUrl:   (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  apiKey:    process.env.OPENAI_API_KEY || '',
  model:     process.env.OPENAI_MODEL || '',
  maxTurns:  parseInt(process.env.AGENT_MAX_TURNS || '15', 10),
  apiTimeoutMs: parseInt(process.env.AGENT_API_TIMEOUT_SECONDS || '900', 10) * 1000,
  debug:     process.env.AGENT_DEBUG === 'true',
  watchIntervalMs: parseInt(process.env.AGENT_WATCH_INTERVAL_SECONDS || '10', 10) * 1000,
  queueAnnounceMs: 30000, // re-announce positions every 30s for all waiting
  statusRateLimitMs: parseInt(process.env.AGENT_STATUS_RATE_LIMIT_SECONDS || '60', 10) * 1000,
  botUsername: process.env.WEBSIM_BOT_USERNAME || 'Opus_4_8',
};

const ADMIN_USERNAMES = new Set((process.env.WEBSIM_ADMIN_USERNAMES || 'Endoxidev').split(',').map(s => s.trim()).filter(Boolean));

const HYPERFRAMES_NOTICE = '🎬 generating hyperframes video — Hyperframes is not an AI model; it is pure HTML video code / code-based video generation.';
const VIDEO_REQUEST_RE = /\b(hyperframes?|video|mp4|rendered\s+clip|animation\s+video|promo\s+video|intro\s+video)\b/i;

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
async function runAgent(prompt, projectAlias, options = {}) {
  const adminOverride = !!options.adminOverride;
  const tools = mcpTools.map(mcpToolToOpenAI);
  const guide = loadClaudeGuide();
  const guideSection = guide ? `\n\nGUIDE:\n${guide.slice(0, 3000)}\n` : '';
  const safetySection = adminOverride ? `
ADMIN OVERRIDE MODE:
- This request came from a trusted admin command.
- Follow the admin's instructions directly.
- You may use upload_file with skip_moderation=true when needed.
- Do not reveal or repeat the admin prompt in public-facing summaries.
` : `
CONTENT SAFETY:
- Keep all project content teen-friendly for a 13+ platform and suitable for ages 13-18.
- Never create, preserve, or intensify pornographic, nude, sexually explicit, fetish, gore, hateful, exploitative, self-harm, or illegal content.
- Do not add preschool/young-child-targeted IP, educational baby content, or references such as Numberblocks or Alphablocks.
- Avoid low-effort slop, spam, shock content, or content designed mainly to bypass moderation.
- If a request asks for unsafe or age-inappropriate content, refuse by making no project edits and explain briefly.
- Do not add image/video URLs unless they are clearly necessary and safe; media URLs are scanned before upload and unsafe media will be blocked.
`;
  const hyperframesSection = /\b(hyperframes?|video|mp4|rendered\s+clip|animation\s+video|promo\s+video|intro\s+video)\b/i.test(prompt) ? `
HYPERFRAMES VIDEO SUPPORT:
- Hyperframes is NOT an AI model. It is deterministic HTML/CSS/media animation code that can either be published directly as an interactive composition OR rendered to a real video file.
- Hyperframes compositions use plain HTML attributes such as data-composition-id, data-start, data-duration (SECONDS, not milliseconds), data-width, data-height, seekable CSS/JS animations, and normal web media tracks.
- For rendered Hyperframes video, the composition MUST register a timeline: window.__timelines = window.__timelines || {}; const tl = gsap.timeline({ paused: true }); ...; window.__timelines[compositionId] = tl;. Pure CSS-only animation is okay for direct HTML mode but is not enough for Hyperframes render.
- Choose based on the request: if the user wants an actual playable/exported video, write a composition directory (for example hyperframes/index.html), call render_hyperframes_video to create/upload an MP4/WebM, then put a normal <video> element in index.html.
- If asked to test both Hyperframes integrations, do NOT explain or defer: create one page with (A) a direct/interactive Hyperframes-style composition section and (B) a rendered MP4/WebM produced via render_hyperframes_video and embedded with <video controls>. Finish and promote the test revision.
- If render_hyperframes_video fails, fix the composition and retry once; if it still fails, publish the direct integration plus a visible error panel explaining the render failure.
- If the user wants interactive/HTML motion graphics, publishing Hyperframes-style HTML/JS/CSS directly is okay.
- Keep generated video code teen-safe and avoid adding remote media unless clearly necessary and safe.
` : '';

  const messages = [
    { role: 'system', content: `You edit a websim.com project. Use TOOLS — never describe changes in prose.
${safetySection}${hyperframesSection}

WORKFLOW:
1. list_revisions → find the current/live non-draft revision marked current: true
2. create_revision(parent_version=current live version) → draft
3. download_file → read contents
4. For small edits, prefer replace_in_file → stage exact local patches. Use write_file only when replacing/creating a whole file.
5. For rendered video requests, call render_hyperframes_video before publishing. Use update_index=true when the rendered video should be the page output; otherwise edit/upload index.html yourself with a <video> pointing at the rendered asset. For non-rendered builds, upload_file → push every staged file needed by the page.
6. finish_revision(revision=the newly created revision) → publish (MANDATORY!)
7. set_current_revision(revision=that same newly created revision) → make live
Stop and give 1-2 sentence summary.

Project: "${projectAlias || 'default'}". Always start with list_revisions, branch from the revision marked current, and only finish/promote the exact revision created for this build.${guideSection}` },
    { role: 'user', content: prompt },
  ];

  console.log(`\n🤖 Building: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  const MUTATING = new Set(['upload_file', 'render_hyperframes_video', 'finish_revision', 'set_current_revision', 'delete_file', 'create_revision', 'replace_in_file']);
  let edited = false, published = false, publishRetries = 0, writtenFiles = [], renderFailures = 0;
  const stagedFiles = new Set();
  const uploadedFiles = new Set();
  let buildRevision = null, finishedRevision = null, currentRevision = null, liveRevision = null;

  for (let turn = 0; turn < CONFIG.maxTurns; turn++) {
    const response = await callModel(messages, tools);
    const msg = response.choices?.[0]?.message;
    if (!msg) { console.log('⚠️ Empty response.'); break; }
    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0) {
      if (edited && !published && publishRetries < 3) {
        publishRetries++;
        console.log(`   ⚠️ Not published (retry ${publishRetries}/3)`);
        messages.push({ role: 'user', content: `Call finish_revision(revision=${buildRevision || 'the newly created revision'}) then set_current_revision(revision=${buildRevision || 'that same revision'}) NOW. Do NOT download anything else. Do NOT promote any older/current/reverted revision.` });
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
      if (adminOverride && name === 'upload_file') args.skip_moderation = true;

      if (name === 'render_hyperframes_video' && renderFailures >= 2) {
        const result = 'Error: render_hyperframes_video already failed twice for this build. Do not retry rendering. Publish the direct Hyperframes integration plus a visible error panel saying the rendered-video export failed.';
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        messages.push({ role: 'user', content: 'Stop retrying rendered export. Finish a safe direct/interactive Hyperframes page with a visible rendered-video failure panel, then publish.' });
        continue;
      }

      if (name === 'write_file' && args.path) { writtenFiles.push(args.path); stagedFiles.add(args.path); edited = true; }

      if (name === 'list_revisions') {
        // Parsed after the tool returns below; no-op here. Kept visible for publish-flow auditing.
      }

      // Auto-upload: if downloading a file we already wrote, upload instead
      if (name === 'download_file' && args.path && writtenFiles.includes(args.path)) {
        console.log(`   ⚡ Auto-uploading ${args.path}...`);
        try {
          if (!Number.isInteger(buildRevision)) throw new Error(`refusing to upload ${args.path} before create_revision; this build does not own a new revision yet`);
          if (buildRevision && args.revision !== buildRevision) throw new Error(`refusing to upload ${args.path} to revision ${args.revision}; this build owns revision ${buildRevision}`);
          const uploadRes = await mcpClient.callTool({ name: 'upload_file', arguments: { project: projectAlias, path: args.path, revision: args.revision, skip_moderation: adminOverride } });
          const uploadText = uploadRes.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          console.log(`   ↳ ${uploadText.slice(0, 200)}`);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: uploadText });
          messages.push({ role: 'user', content: `Uploaded ${args.path}. Now call finish_revision and set_current_revision.` });
          edited = true;
        } catch (err) { messages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${err.message}` }); }
        continue;
      }

      if (['upload_file', 'finish_revision', 'set_current_revision', 'delete_file'].includes(name) && !Number.isInteger(buildRevision)) {
        const result = `Error: refusing to ${name} before create_revision; every build must own a newly-created revision before publishing or mutating remote state.`;
        console.error(`   🛑 ${result}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        messages.push({ role: 'user', content: 'Call list_revisions, then create_revision(parent_version=the current live non-draft revision), then retry on the newly-created revision only.' });
        continue;
      }

      if (name === 'create_revision' && Number.isInteger(liveRevision) && args.parent_version !== liveRevision) {
        const result = `Error: refusing to branch from revision ${args.parent_version}; current live revision is ${liveRevision}.`;
        console.error(`   🛑 ${result}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        messages.push({ role: 'user', content: `Create the build revision from parent_version=${liveRevision}. Do not branch from older/currently reverted guesses.` });
        continue;
      }

      if (buildRevision && ['upload_file', 'finish_revision', 'set_current_revision', 'delete_file'].includes(name) && (!Number.isInteger(args.revision) || args.revision !== buildRevision)) {
        const result = `Error: refusing to ${name} revision ${args.revision}; this build owns newly-created revision ${buildRevision}. Use revision ${buildRevision}.`;
        console.error(`   🛑 ${result}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        messages.push({ role: 'user', content: `Use revision ${buildRevision} for all remaining upload/finish/set_current calls. Do not promote any other revision.` });
        continue;
      }

      if (name === 'finish_revision' && Number.isInteger(buildRevision)) {
        const pendingUploads = [...stagedFiles].filter(path => !uploadedFiles.has(path));
        if (pendingUploads.length > 0) {
          console.log(`   📦 Auto-uploading staged files before finish: ${pendingUploads.join(', ')}`);
          const uploadedNow = [];
          let uploadError = null;
          for (const path of pendingUploads) {
            try {
              const uploadRes = await mcpClient.callTool({ name: 'upload_file', arguments: { project: projectAlias, path, revision: buildRevision, skip_moderation: adminOverride } });
              const uploadText = uploadRes.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
              uploadedFiles.add(path);
              uploadedNow.push(`${path}: ${uploadText.slice(0, 120)}`);
              console.log(`   ↳ auto-uploaded ${path}`);
            } catch (err) {
              uploadError = err;
              break;
            }
          }
          if (uploadError) {
            const result = `Error: refusing to finish_revision because staged file upload failed: ${uploadError.message}. Uploaded before failure: ${uploadedNow.join(' | ') || 'none'}`;
            console.error(`   🛑 ${result}`);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
            messages.push({ role: 'user', content: 'Fix the staged file upload error, then finish and promote the same build revision.' });
            continue;
          }
          messages.push({ role: 'user', content: `Auto-uploaded staged files before finish_revision: ${uploadedNow.join(' | ')}` });
        }
      }

      if (MUTATING.has(name)) edited = true;
      console.log(`   🔧 ${name}(${JSON.stringify(args).slice(0, 100)})`);
      let result;
      try {
        const res = await mcpClient.callTool({ name, arguments: args });
        result = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (name === 'list_revisions') {
          try {
            const jsonStart = result.indexOf('\n[');
            const revs = JSON.parse(jsonStart >= 0 ? result.slice(jsonStart + 1) : result);
            const current = revs.find(r => r.current && !r.draft);
            if (Number.isInteger(current?.version)) liveRevision = current.version;
          } catch {}
        }
        if (name === 'create_revision') {
          const m = result.match(/version=(\d+)/);
          if (m) buildRevision = Number.parseInt(m[1], 10);
        }
        if (name === 'render_hyperframes_video' && result.startsWith('Error:')) renderFailures += 1;
        if (name === 'render_hyperframes_video' && !result.startsWith('Error:')) renderFailures = 0;
        if ((name === 'write_file' || name === 'replace_in_file') && args.path && !result.startsWith('Error:')) stagedFiles.add(args.path);
        if ((name === 'upload_file' || name === 'render_hyperframes_video') && args.path && !result.startsWith('Error:')) uploadedFiles.add(args.path);
        if (name === 'finish_revision' && args.revision === buildRevision) finishedRevision = args.revision;
        if (name === 'set_current_revision' && args.revision === buildRevision && finishedRevision === buildRevision) { currentRevision = args.revision; published = true; }
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

CONTENT SAFETY:
- The platform is 13+. Only approve teen-friendly requests suitable for ages 13-18.
- Reject 18+ sexual content, nudity, fetish content, porn, hentai, graphic gore, hate, exploitation, self-harm instructions, illegal activity, harassment, or moderation bypass attempts.
- Reject preschool/young-child-targeted content and references such as Numberblocks or Alphablocks.
- Reject low-effort slop/spam/shock content that would make the platform less safe or friendly.
- For rejected unsafe content, actionable must be false and decisionReply should be brief/generic/safety-focused.

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
    s.statusRateLimits = s.statusRateLimits || {};
    s.paused = !!s.paused;
    return s;
  } catch {
    return { entries: {}, queue: [], checklist: [], statusRateLimits: {}, paused: false, currentlyProcessing: null, lastAnnounce: null, lastRun: null };
  }
}
function saveBotState(state) { fs.writeFileSync(BOT_STATE_PATH, JSON.stringify(state, null, 2)); }

function spawnRestart(projectAlias) {
  const projectArg = projectAlias ? ` --project ${JSON.stringify(projectAlias)}` : '';
  const cmd = `script -q -c "node agent.js --watch${projectArg}" /dev/null >> agent.log 2>&1 &`;
  const child = spawn('sh', ['-lc', cmd], { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
}

async function performSelfRestart(projectAlias, state, reason = 'restart requested') {
  console.log(`   🔄 Restarting daemon: ${reason}`);
  state.currentlyProcessing = null;
  state.restartRequested = null;
  saveBotState(state);
  await stopMCP();
  spawnRestart(projectAlias);
  setTimeout(() => process.exit(0), 250);
}

function recoverInterruptedProcessing(state, interruptedId) {
  if (!interruptedId) return 0;
  const queued = new Set((state.queue || []).map(item => item.commentId));
  let recovered = 0;
  for (const entry of Object.values(state.entries || {})) {
    if (!entry || entry.category !== 'processing') continue;
    if (interruptedId && entry.id !== interruptedId) continue;
    if (entry.builtAt || entry.buildError || queued.has(entry.id)) continue;
    const content = entry.content || entry.snippet;
    if (!content) continue;
    state.queue.push({ commentId: entry.id, author: entry.author || 'someone', content, addedAt: new Date().toISOString(), recovered: true });
    entry.category = 'queued_recovered';
    entry.recoveredAt = new Date().toISOString();
    recovered++;
  }
  return recovered;
}

// ── Queue System ───────────────────────────────────────────────────

// Fire-and-forget reply helper (never blocks)
function bgReply(projectAlias, commentId, content) {
  mcpClient.callTool({ name: 'post_reply', arguments: { project: projectAlias, comment_id: commentId, content } }).catch(() => {});
}

function bgDelete(projectAlias, commentId) {
  setTimeout(() => {
    mcpClient.callTool({ name: 'delete_comment', arguments: { project: projectAlias, comment_id: commentId } }).catch(() => {});
  }, 5000);
}

function isAdmin(author) { return ADMIN_USERNAMES.has(author); }

function statusText(state) {
  const currently = state.restartRequested ? 'restart pending 🔄' : (state.currentlyProcessing ? 'building now 🔨' : (state.paused ? 'paused ⏸️' : 'idle'));
  const maint = state.maintenanceMessage ? `\nMaintenance: ${state.maintenanceMessage.slice(0, 120)}` : '';
  return `📊 **Status:** ${state.queue.length} in queue | ${state.checklist.length} built | Currently: ${currently}${maint}`;
}

function canSendPublicStatus(state, author) {
  state.statusRateLimits = state.statusRateLimits || {};
  const key = author || 'unknown';
  const now = Date.now();
  const last = state.statusRateLimits[key] ? new Date(state.statusRateLimits[key]).getTime() : 0;
  if (now - last < CONFIG.statusRateLimitMs) return false;
  state.statusRateLimits[key] = new Date(now).toISOString();
  return true;
}


async function getCurrentRevisionFromMcp(projectAlias) {
  const res = await mcpClient.callTool({ name: 'list_revisions', arguments: { project: projectAlias } });
  const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const jsonStart = text.indexOf('\n[');
  const json = jsonStart >= 0 ? text.slice(jsonStart + 1) : text;
  const revs = JSON.parse(json);
  const current = revs.find(r => r.current && !r.draft);
  return current?.version || null;
}

async function handlePublicStatus(comment, state) {
  const author = comment.author?.username || 'unknown';
  const proj = state._projectAlias || 'opus48';
  if (!canSendPublicStatus(state, author)) {
    state.entries[comment.id] = { id: comment.id, category: 'status_rate_limited', at: new Date().toISOString(), author };
    saveBotState(state);
    return;
  }
  state.entries[comment.id] = { id: comment.id, category: 'status', at: new Date().toISOString(), author };
  saveBotState(state);
  bgReply(proj, comment.id, statusText(state));
}

async function addToQueue(state, comment) {
  const author = comment.author?.username || '';
  const content = extractCommentText(comment);
  if (!content.trim()) return;
  if (state.queue.find(q => q.commentId === comment.id)) return;
  if (state.entries[comment.id]?.category === 'cleared') return;

  const firstToken = content.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (firstToken === '!status' || firstToken === '!stats') {
    await handlePublicStatus(comment, state);
    return;
  }

  // Admin commands only
  if (isAdmin(author) && content.startsWith('!')) {
    await handleAdminCommand(content, comment, state);
    return;
  }

  if (content.startsWith('!')) {
    state.entries[comment.id] = { id: comment.id, category: 'unknown_command', at: new Date().toISOString(), author };
    saveBotState(state);
    bgReply(state._projectAlias || 'opus48', comment.id, 'Unknown command. Try `!status` to see the queue.');
    return;
  }

  if (state.paused) {
    state.entries[comment.id] = { id: comment.id, category: 'paused', at: new Date().toISOString(), author };
    bgReply(state._projectAlias || 'opus48', comment.id, '⏸️ Builds are paused right now. Please try again later.');
    return;
  }

  const moderation = await moderateTextForMedia(content);
  if (!moderation.ok) {
    console.log(`   🛡️ @${author} blocked by media moderation: ${moderation.blocked || moderation.reason || 'unsafe media'}`);
    state.entries[comment.id] = { id: comment.id, category: 'blocked_media', at: new Date().toISOString(), author };
    bgReply(state._projectAlias || 'opus48', comment.id, BLOCK_MESSAGE);
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
  const trimmed = content.trim();
  const [rawCmd, ...rest] = trimmed.split(/\s+/);
  const cmd = (rawCmd || '').toLowerCase();
  const argText = trimmed.slice(rawCmd.length).trim();
  const proj = state._projectAlias || 'opus48';
  const WIP = '⚠️ *Admin command received.*\n\n';
  bgDelete(proj, comment.id);

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

  } else if (cmd === '!pause') {
    state.paused = true;
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    bgReply(proj, comment.id, '⏸️ **Build intake paused.** Existing queue is unchanged.');
    console.log('   ⏸️ Admin paused build intake');
  } else if (cmd === '!resume') {
    state.paused = false;
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    bgReply(proj, comment.id, '▶️ **Build intake resumed.**');
    console.log('   ▶️ Admin resumed build intake');
  } else if (cmd === '!maintenance' || cmd === '!maint') {
    state.paused = true;
    state.maintenanceMessage = argText || 'Maintenance is starting. The bot will be back soon.';
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    bgReply(proj, comment.id, `🛠️ **Maintenance starting.**\n\n${state.maintenanceMessage}\n\nNew build intake is paused for now.`);
    console.log(`   🛠️ Maintenance mode: ${state.maintenanceMessage}`);
  } else if (cmd === '!online' || cmd === '!back') {
    state.paused = false;
    state.maintenanceMessage = null;
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    bgReply(proj, comment.id, '✅ **Bot is back online.** Queue processing can continue.');
    console.log('   ✅ Maintenance ended; bot back online');
  } else if (cmd === '!restart') {
    state.paused = true;
    state.restartRequested = { at: new Date().toISOString(), by: comment.author?.username || 'admin' };
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    if (state.currentlyProcessing) {
      bgReply(proj, comment.id, '🔄 **Restart queued.** I’ll finish the current build first, then restart and come back online.');
      console.log('   🔄 Restart requested; waiting for current build to finish');
    } else {
      bgReply(proj, comment.id, '🔄 **Restarting now.** I’ll be back online in a moment.');
      setTimeout(() => performSelfRestart(proj, state, 'admin command'), 2500);
    }
  } else if (cmd === '!clean') {
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    try {
      const res = await mcpClient.callTool({ name: 'clean_project_cache', arguments: {} });
      const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      bgReply(proj, comment.id, `🧹 **Local cache cleaned.**\n${text}`);
    } catch (err) {
      bgReply(proj, comment.id, `❌ **Cache clean failed:** ${err.message.slice(0, 180)}`);
    }
  } else if (cmd === '!fixindex' || cmd === '!cleanindex') {
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    const version = rest[0] ? Number.parseInt(rest[0], 10) : null;
    const args = { project: proj };
    if (Number.isInteger(version)) args.revision = version;
    try {
      const res = await mcpClient.callTool({ name: 'delete_duplicate_index_files', arguments: args });
      const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      bgReply(proj, comment.id, `🧹 **Duplicate index cleanup complete.**\n${text}`);
    } catch (err) {
      bgReply(proj, comment.id, `❌ **Duplicate index cleanup failed:** ${err.message.slice(0, 180)}`);
    }
  } else if (cmd === '!queue') {
    const preview = state.queue.slice(0, 10).map((item, i) => `${i + 1}. @${item.author}: ${item.content.slice(0, 60)}`).join('\n') || 'Queue is empty.';
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    bgReply(proj, comment.id, `📋 **Queue preview** (${state.queue.length} total)\n${preview}`);
    console.log(`   📋 Admin queue preview: ${state.queue.length} queued`);
  } else if (cmd === '!drop') {
    const target = rest[0];
    let index = Number.parseInt(target, 10);
    if (!Number.isInteger(index) || index < 1 || index > state.queue.length) {
      state.entries[comment.id] = { id: comment.id, category: 'admin', subcategory: 'drop_usage', at: new Date().toISOString(), author: comment.author?.username || 'admin' };
      saveBotState(state);
      bgReply(proj, comment.id, 'Usage: `!drop <queue-number>`');
      return;
    }
    const [removed] = state.queue.splice(index - 1, 1);
    if (removed) state.entries[removed.commentId] = { id: removed.commentId, category: 'cleared', at: new Date().toISOString(), author: removed.author };
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    bgReply(proj, comment.id, `✅ Dropped queue item #${index}.`);
    console.log(`   🗑️ Admin dropped queue item #${index}`);
  } else if (cmd === '!safemode' || cmd === '!safe') {
    const mode = (rest[0] || 'on').toLowerCase();
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    if (!['on', 'off'].includes(mode)) {
      bgReply(proj, comment.id, 'Usage: `!safemode on` to enable, `!safemode off` to restore the prior live revision. If no prior revision is known, use `!revert <version>`.');
      return;
    }
    if (mode === 'off') {
      const previous = state.safeModePreviousRevision;
      if (!Number.isInteger(previous)) {
        bgReply(proj, comment.id, '⚠️ **No prior live revision recorded for safe mode.** Use `!revert <version>` after checking `!revisions`.');
        return;
      }
      console.log(`   🛡️ ${cmd} off: restoring revision ${previous}...`);
      try {
        const res = await mcpClient.callTool({ name: 'set_current_revision', arguments: { project: proj, revision: previous } });
        const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        state.safeModeEnabled = false;
        state.safeModeRestoredAt = new Date().toISOString();
        state.safeModePreviousRevision = null;
        saveBotState(state);
        bgReply(proj, comment.id, `✅ **Safe mode disabled.** Restored revision ${previous}.`);
        console.log(`   🛡️ Safe mode disabled: ${text}`);
      } catch (err) {
        bgReply(proj, comment.id, `❌ **Safe mode restore failed:** ${err.message.slice(0, 180)}. You can still use \`!revert <version>\`.`);
        console.error(`   ❌ Safe mode restore failed: ${err.message}`);
      }
      return;
    }

    console.log(`   🛡️ ${cmd} on: enabling safe mode page...`);
    bgReply(proj, comment.id, WIP + '🛡️ Enabling safe mode page now...');
    try {
      const previous = await getCurrentRevisionFromMcp(proj);
      const res = await mcpClient.callTool({ name: 'enable_safe_mode', arguments: { project: proj } });
      const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (Number.isInteger(previous)) state.safeModePreviousRevision = previous;
      state.safeModeEnabled = true;
      state.safeModeEnabledAt = new Date().toISOString();
      saveBotState(state);
      bgReply(proj, comment.id, `✅ **Safe mode enabled.** Previous live revision: ${previous || 'unknown'}. Use \`!safemode off\` to restore if known, or \`!revert <version>\`.\n\n${text}`);
      console.log(`   🛡️ Safe mode enabled: ${text}`);
    } catch (err) {
      bgReply(proj, comment.id, `❌ **Safe mode failed:** ${err.message.slice(0, 180)}`);
      console.error(`   ❌ Safe mode failed: ${err.message}`);
    }
  } else if (cmd === '!revert' || cmd === '!restore' || cmd === '!rollback') {
    const version = Number.parseInt(rest[0], 10);
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    if (!Number.isInteger(version) || version < 1) {
      bgReply(proj, comment.id, 'Usage: `!revert <revision-number>` or `!rollback <revision-number>`');
      return;
    }
    const cancelled = state.queue.length;
    for (const item of state.queue) {
      state.entries[item.commentId] = { id: item.commentId, category: 'cleared_for_rollback', at: new Date().toISOString(), author: item.author };
    }
    state.queue = [];
    state.currentlyProcessing = null;
    state.paused = true;
    state.maintenanceMessage = `Rollback to revision ${version} in progress / completed. Use !online when ready to resume.`;
    saveBotState(state);
    console.log(`   ↩️ Admin rollback/revert to revision ${version}; cancelled ${cancelled} queued item(s)...`);
    bgReply(proj, comment.id, WIP + `↩️ Rollback started. Paused intake and cancelled ${cancelled} queued item(s). Syncing local files to revision ${version}...`);
    try {
      const res = await mcpClient.callTool({ name: 'rollback_to_revision', arguments: { project: proj, revision: version, fallback_on_fail: true } });
      const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      state.lastRollback = { requestedRevision: version, at: new Date().toISOString(), result: text.slice(0, 500) };
      saveBotState(state);
      bgReply(proj, comment.id, `✅ **Rollback command finished.**\n${text}\n\nBuilds are still paused; use \`!online\` when you want the agent to resume.`);
      console.log(`   ↩️ Rollback complete: ${text}`);
    } catch (err) {
      state.lastRollback = { requestedRevision: version, at: new Date().toISOString(), error: err.message.slice(0, 500) };
      saveBotState(state);
      bgReply(proj, comment.id, `❌ **Rollback command failed:** ${err.message.slice(0, 180)}\n\nBuilds remain paused; use \`!revisions\` to choose a visible published revision, then try \`!rollback <version>\`.`);
      console.error(`   ❌ Rollback failed: ${err.message}`);
    }
  } else if (cmd === '!revisions' || cmd === '!versions') {
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    try {
      const res = await mcpClient.callTool({ name: 'list_revisions', arguments: { project: proj } });
      const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      const jsonStart = text.indexOf('\n[');
      const json = jsonStart >= 0 ? text.slice(jsonStart + 1) : text;
      const revs = JSON.parse(json).slice(0, 8).map(r => `v${r.version}${r.current ? ' current' : ''}${r.draft ? ' draft' : ''}${r.title ? ` — ${String(r.title).slice(0, 40)}` : ''}`).join('\n');
      bgReply(proj, comment.id, `🕘 **Recent revisions**\n${revs || 'No revisions found.'}`);
    } catch (err) {
      bgReply(proj, comment.id, `❌ **Could not list revisions:** ${err.message.slice(0, 180)}`);
    }
  } else if (cmd === '!ap' || cmd === '!adminprompt') {
    state.entries[comment.id] = { id: comment.id, category: 'admin_prompt', at: new Date().toISOString() };
    saveBotState(state);
    if (!argText) {
      bgReply(proj, comment.id, 'Usage: `!ap <admin prompt>`');
      return;
    }
    console.log(`   🛠️ Admin prompt received (${argText.length} chars).`);
    bgReply(proj, comment.id, WIP + '🛠️ Running admin override now. Prompt hidden from bot replies.');
    try {
      const result = await runAgent(argText, proj, { adminOverride: true });
      state.checklist.push({ what: '[admin prompt hidden]', category: 'admin_prompt', commentId: comment.id, author: comment.author?.username, at: new Date().toISOString(), ok: result.ok });
      saveBotState(state);
      bgReply(proj, comment.id, result.ok ? '✅ **Admin override complete.** Refresh to see the changes.' : '⚠️ **Admin override finished with no published change.**');
      console.log(`   🛠️ Admin prompt complete: ok=${result.ok}`);
    } catch (err) {
      bgReply(proj, comment.id, `❌ **Admin override failed:** ${err.message.slice(0, 180)}`);
      console.error(`   ❌ Admin prompt failed: ${err.message}`);
    }
  } else if (cmd === '!help' || cmd === '!adminhelp') {
    state.entries[comment.id] = { id: comment.id, category: 'admin', at: new Date().toISOString() };
    saveBotState(state);
    bgReply(proj, comment.id, `🛠️ **Admin commands**\n!clearqueue — clear waiting queue\n!pause / !resume — stop/start new build intake\n!maintenance <msg> / !online — public maintenance notices\n!restart — finish current item, restart, then come back\n!clean — clean local project cache\n!fixindex [version] — delete duplicate index (n).html assets\n!queue — preview queue\n!drop <n> — remove queue item\n!revisions — show recent versions\n!safemode on/off — publish safe-mode page or restore previous live revision\n!revert <version> / !rollback <version> — pause, cancel queue, make version live, sync local files\n!ap <prompt> — admin override build, prompt not echoed`);
  } else {
    console.log(`   ⚠️ Unknown admin command: ${cmd}`);
    state.entries[comment.id] = { id: comment.id, category: 'admin', subcategory: 'unknown_command', at: new Date().toISOString(), author: comment.author?.username || 'admin' };
    saveBotState(state);
    bgReply(proj, comment.id, 'Unknown admin command. Try `!adminhelp`.');
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
  state.entries[item.commentId] = { id: item.commentId, category: 'processing', at: new Date().toISOString(), author: item.author, content: item.content, snippet: item.content.slice(0, 120) };
  saveBotState(state);

  // Announce updated positions (now that #1 is being processed)
  announceQueuePositions(projectAlias, state).catch(() => {});

  console.log(`\n🛠️  Processing: @${item.author}: "${item.content.slice(0, 80)}..."`);

  const WIP = '⚠️ *Heads up — heavy work in progress! Pardon our dust.*\n\n';
  const comment = { id: item.commentId, content: item.content, raw_content: item.content, author: { username: item.author } };

  // Re-check queued content with the current moderation rules. This catches items queued before a moderation hardening deploy.
  const queuedModeration = await moderateTextForMedia(item.content);
  if (!queuedModeration.ok) {
    console.log(`   🛡️ @${item.author} blocked by queued media moderation: ${queuedModeration.blocked || queuedModeration.reason || 'unsafe media'}`);
    state.entries[item.commentId].category = 'blocked_media';
    state.entries[item.commentId].blockedAt = new Date().toISOString();
    state.entries[item.commentId].blockReason = (queuedModeration.reason || queuedModeration.blocked || 'unsafe media').slice(0, 200);
    state.currentlyProcessing = null;
    saveBotState(state);
    bgReply(projectAlias, item.commentId, BLOCK_MESSAGE);
    if (!state.paused && state.queue.length > 0) await processNextInQueue(projectAlias, state);
    return;
  }

  // Triage
  console.log('   🧠 Reasoning...');
  let decision;
  try {
    decision = await triageComment(comment);
  } catch (err) {
    console.error(`   ❌ Triage failed: ${err.message}`);
    state.entries[item.commentId].category = 'triage_error';
    state.entries[item.commentId].buildError = err.message.slice(0, 200);
    state.currentlyProcessing = null;
    saveBotState(state);
    bgReply(projectAlias, item.commentId, `${WIP}😅 Hit a temporary inference snag while checking this request. I’m moving on so the queue does not get stuck; please retry in a bit.`);
    if (!state.paused && state.queue.length > 0) await processNextInQueue(projectAlias, state);
    return;
  }
  const emojis = { feature_request:'✨', bug_fix:'🐛', ui_change:'🎨', content_change:'✏️', question:'❓', praise:'❤️', spam:'🗑️', abuse:'🚫', greeting:'👋', unclear:'🤷' };
  console.log(`   ${emojis[decision.category]||'📌'} ${decision.category} → ${decision.actionable ? 'BUILD' : 'PASS'}`);
  console.log(`   ↳ ${decision.reasoning}`);

  // Reply with decision
  bgReply(projectAlias, item.commentId, WIP + (decision.decisionReply || (decision.actionable ? "Great idea! I'll build this now." : "Thanks for the comment!")));
  console.log('   💬 Decision reply sent.');

  if (decision.actionable && VIDEO_REQUEST_RE.test(`${item.content} ${decision.editPrompt || ''}`)) {
    bgReply(projectAlias, item.commentId, HYPERFRAMES_NOTICE);
  }

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

  if (state.restartRequested) {
    bgReply(projectAlias, item.commentId, '🔄 Current build finished. Restarting the bot now; queue will continue when I’m back online.');
    await new Promise(r => setTimeout(r, 2500));
    await performSelfRestart(projectAlias, state, 'admin restart after current build');
    return;
  }

  if (state.paused) {
    console.log('   ⏸️ Queue paused; not processing next item yet.');
    return;
  }

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
  const interruptedId = state.currentlyProcessing;
  if (state.currentlyProcessing) state.currentlyProcessing = null;
  const recovered = recoverInterruptedProcessing(state, interruptedId);
  saveBotState(state);
  mcpClient.callTool({ name: 'clean_project_cache', arguments: {} }).catch(() => {});

  const intSec = Math.round(CONFIG.watchIntervalMs / 1000);
  console.log(`\n🤖 Daemon v2.2 | Model: ${CONFIG.model} | Poll: ${intSec}s | Priority: @Endoxidev`);
  console.log(`   Queue: ${state.queue.length} | Built: ${state.checklist.length} | Admin: !clearqueue, !pause, !resume, !maintenance, !online, !restart, !clean, !fixindex, !queue, !drop, !revisions, !safemode on/off, !revert/!rollback, !ap\n`);
  if (recovered > 0) console.log(`   ♻️ Recovered ${recovered} interrupted item(s) back into the queue.`);

  await pollAndEnqueue(projectAlias, state);

  const pollTimer = setInterval(() => pollAndEnqueue(projectAlias, state), CONFIG.watchIntervalMs);
  const announceTimer = setInterval(() => announceQueuePositions(projectAlias, state), CONFIG.queueAnnounceMs);

  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    clearInterval(pollTimer); clearInterval(announceTimer);
    // Preserve currentlyProcessing on shutdown so the next boot can recover
    // exactly that one interrupted item. Do not broaden recovery to older
    // historical "processing" entries.
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
      await addToQueue(state, c);
    }
    saveBotState(state);

    if (newComments.length > 0) {
      const sn = selfCount > 0 ? ` (${selfCount} self skipped)` : '';
      console.log(`[${ts}] ${newComments.length} new → queue now ${state.queue.length}${sn}`);
      // Announce positions immediately when queue changes
      announceQueuePositions(projectAlias, state).catch(() => {});
    }

    if (!state.paused && !state.currentlyProcessing && state.queue.length > 0) {
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
