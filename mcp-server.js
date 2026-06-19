#!/usr/bin/env node
/**
 * websim multi-project MCP server (stdio transport)
 *
 * Supports multiple websim projects defined in projects.config.json.
 * Every tool accepts an optional `project` param (alias from config).
 * If omitted, uses the configured defaultProject.
 *
 * v2 changes from original:
 *   - Multi-project: tools take `project` (alias), reads config for id/slug
 *   - Per-project bearer override (some projects may use different accounts)
 *   - list_projects tool so agents can discover available projects
 *   - Falls back gracefully when project alias is unknown
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const { spawnSync } = require('child_process');
const { moderateTextForMedia, DEFAULT_MAX_MEDIA_BYTES, DEFAULT_MAX_VIDEO_SECONDS } = require('./moderation.js');

// ── Config loading ────────────────────────────────────────────────
require('dotenv').config();

const CONFIG_PATH = nodePath.join(__dirname, 'projects.config.json');
let config = { projects: {}, defaultProject: null };

function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`[mcp] WARNING: Could not load ${CONFIG_PATH}:`, err.message);
  }
}
loadConfig();

function getProject(alias) {
  const key = !alias || alias === 'default' ? config.defaultProject : alias;
  const proj = config.projects?.[key];
  if (!proj) throw new Error(`Unknown project alias "${key}". Available: ${Object.keys(config.projects || {}).join(', ')}`);
  return { alias: key, ...proj };
}

function readOfficialCliAuthToken() {
  const configPath = process.env.WEBSIM_CLI_CONFIG || nodePath.join(os.homedir(), '.websim-cli.json');
  try {
    if (!fs.existsSync(configPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return typeof parsed.authToken === 'string' && parsed.authToken.trim() ? parsed.authToken.trim() : null;
  } catch (err) {
    console.error(`[mcp] WARNING: Could not read websim-cli auth config: ${err.message}`);
    return null;
  }
}

// Auth priority:
// 1. project-specific bearer override in projects.config.json
// 2. explicit env token (WEBSIM_BEARER / bearer / WEBSIM_TOKEN)
// 3. official websim-cli login token from ~/.websim-cli.json
const GLOBAL_BEARER = process.env.WEBSIM_BEARER || process.env.bearer || process.env.WEBSIM_TOKEN || readOfficialCliAuthToken();
function getBearer(project) {
  const token = project.bearer || GLOBAL_BEARER;
  if (!token) throw new Error('No Websim auth token found. Set WEBSIM_BEARER or run: websim-cli login');
  return token;
}

const API_BASE = 'https://websim.com/api/v1';
const PROJECT_DIR = nodePath.join(__dirname, 'project');
const MAX_MEDIA_BYTES = Number.parseInt(process.env.WEBSIM_MAX_MEDIA_BYTES || String(DEFAULT_MAX_MEDIA_BYTES), 10);
const PROJECT_CACHE_MAX_AGE_MS = Number.parseInt(process.env.WEBSIM_PROJECT_CACHE_MAX_AGE_HOURS || '24', 10) * 60 * 60 * 1000;
const MAX_VIDEO_SECONDS = Number.parseInt(process.env.WEBSIM_MAX_VIDEO_SECONDS || String(DEFAULT_MAX_VIDEO_SECONDS), 10);
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.WEBSIM_MEDIA_MODERATION_TIMEOUT_MS || '8000', 10);
const MEDIA_FILE_RE = /\.(png|jpe?g|webp|gif|bmp|avif|mp4|webm|mov|m4v|avi|mkv)(?:$|[?#])/i;
const VIDEO_FILE_RE = /\.(mp4|webm|mov|m4v|avi|mkv)(?:$|[?#])/i;
const DUPLICATE_INDEX_RE = /(^|\/)index\s*\(\d+\)\.html$/i;

const SAFE_MODE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Safe Mode</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: radial-gradient(circle at top, #24324f, #080b12 60%); color: #f5f7fb; }
    main { width: min(680px, calc(100% - 32px)); padding: 40px; border: 1px solid rgba(255,255,255,.16); border-radius: 24px; background: rgba(12,17,28,.78); box-shadow: 0 24px 80px rgba(0,0,0,.35); text-align: center; }
    h1 { margin: 0 0 12px; font-size: clamp(2rem, 6vw, 4rem); }
    p { margin: 0; font-size: clamp(1rem, 2.5vw, 1.25rem); line-height: 1.6; color: #cbd5e1; }
  </style>
</head>
<body>
  <main>
    <h1>Something went wrong...</h1>
    <p>Images and Videos are currently disabled for the time being, sorry!</p>
  </main>
</body>
</html>`;

const ROLLBACK_FAIL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rollback failed</title>
  <style>
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #160b0b; color: #fff3f3; font-family: system-ui, sans-serif; text-align: center; }
    main { max-width: 720px; padding: 40px; border: 1px solid rgba(255,255,255,.2); border-radius: 24px; background: rgba(255,255,255,.08); }
    h1 { font-size: clamp(2rem, 7vw, 4rem); margin: 0 0 12px; }
    p { font-size: 1.2rem; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <main>
    <h1>Rollback fail</h1>
    <p>Please try again.</p>
  </main>
</body>
</html>`;

// ── Helpers ───────────────────────────────────────────────────────

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: '*/*',
    origin: 'https://websim.com',
  };
}

function contentTypeFor(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map = {
    html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript',
    mjs: 'text/javascript', json: 'application/json', md: 'text/markdown',
    txt: 'text/plain', svg: 'image/svg+xml', xml: 'application/xml',
  };
  return map[ext] || 'text/plain';
}

function isMediaPath(path) {
  return MEDIA_FILE_RE.test(path);
}

function assertSafeProjectPath(path) {
  if (DUPLICATE_INDEX_RE.test(path)) {
    throw new Error(`blocked duplicate homepage path "${path}". The Websim entrypoint is index.html; edit/upload index.html instead of creating index (n).html files.`);
  }
  if (nodePath.isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error(`blocked unsafe project path "${path}"`);
  }
}

function encodeProjectPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function assertMediaSize(path, bytes, context) {
  if (isMediaPath(path) && Number.isFinite(bytes) && bytes > MAX_MEDIA_BYTES) {
    throw new Error(`${context} blocked: ${path} is too large (${bytes} bytes > ${MAX_MEDIA_BYTES} bytes)`);
  }
}

function assertLocalVideoDuration(path, filePath) {
  if (!VIDEO_FILE_RE.test(path)) return;
  const out = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf8', timeout: 30000 });
  if (out.status !== 0) throw new Error(`upload blocked: video duration could not be verified for ${path}`);
  const seconds = Number.parseFloat(String(out.stdout || '').trim());
  if (!Number.isFinite(seconds)) throw new Error(`upload blocked: video duration could not be parsed for ${path}`);
  if (seconds > MAX_VIDEO_SECONDS) throw new Error(`upload blocked: ${path} is too long (${Math.round(seconds)}s > ${MAX_VIDEO_SECONDS}s)`);
}

async function cleanupProjectCache(maxAgeMs = PROJECT_CACHE_MAX_AGE_MS) {
  const now = Date.now();
  let deleted = 0, kept = 0, bytesFreed = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        try { await fs.promises.rmdir(full); } catch {}
        continue;
      }
      if (!entry.isFile()) continue;
      const st = await fs.promises.stat(full);
      if (now - st.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(full);
        deleted++; bytesFreed += st.size;
      } else kept++;
    }
  }
  await walk(PROJECT_DIR);
  return { deleted, kept, bytesFreed };
}

async function uploadAsset(projectId, revision, path, content, token, existingAssetId = null) {
  const body = Buffer.from(content, 'utf8');
  const meta = { size: body.length };
  if (existingAssetId) meta.existingAssetId = existingAssetId;

  const form = new FormData();
  form.append('contents', JSON.stringify([meta]));
  form.append('0', new File([body], path, { type: contentTypeFor(path) }));

  const res = await fetch(
    `${API_BASE}/projects/${projectId}/revisions/${revision}/assets`,
    { method: 'POST', headers: authHeaders(token), body: form }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${text}`);
  return text;
}

async function assetExists(projectId, revision, path, token) {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/revisions/${revision}/assets`,
    { headers: authHeaders(token) }
  );
  if (!res.ok) return false;
  const data = JSON.parse(await res.text());
  return (data.assets || []).some((a) => a.path === path);
}

async function getAssetId(projectId, revision, path, token) {
  const assets = await listAssets(projectId, revision, token);
  return assets.find((a) => a.path === path)?.id || null;
}

async function deleteAsset(projectId, revision, path, token) {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/revisions/${revision}/edit-assets`,
    {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ operation: { type: 'delete', path } }),
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`delete_file failed (${res.status}): ${text}`);
}

async function listAssets(projectId, revision, token) {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/revisions/${revision}/assets`,
    { headers: authHeaders(token) }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`list_assets failed (${res.status}): ${text}`);
  const data = JSON.parse(text);
  return data.assets || [];
}

async function fetchProjectFile(proj, revision, path, token) {
  assertSafeProjectPath(path);
  const url = `https://${proj.id}.c.websim.com/${encodeProjectPath(path)}?v=${revision}&raw=`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: '*/*', referer: `https://websim.com/p/${proj.id}/${revision}` },
  });
  if (!res.ok) throw new Error(`download failed for ${path} (${res.status}): ${await res.text()}`);
  const len = res.headers.get('content-length');
  if (len) assertMediaSize(path, Number.parseInt(len, 10), 'download');
  const buf = Buffer.from(await res.arrayBuffer());
  assertMediaSize(path, buf.length, 'download');
  return buf;
}

async function writeProjectMirrorFile(proj, path, buf) {
  assertSafeProjectPath(path);
  const dest = nodePath.join(PROJECT_DIR, proj.alias, path);
  await fs.promises.mkdir(nodePath.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, buf);
}

async function syncRevisionToLocal(proj, revision, token) {
  const meta = await getRevisionMeta(proj, revision, token);
  if (!meta) throw new Error(`sync failed: revision ${revision} does not exist`);
  if (meta.draft) throw new Error(`sync failed: revision ${revision} is still draft`);
  const root = nodePath.join(PROJECT_DIR, proj.alias);
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });

  const downloaded = [];
  const index = await fetchProjectFile(proj, revision, 'index.html', token);
  await writeProjectMirrorFile(proj, 'index.html', index);
  downloaded.push('index.html');

  const assets = await listAssets(proj.id, revision, token);
  for (const asset of assets) {
    const path = asset.path;
    if (!path || path === 'index.html' || DUPLICATE_INDEX_RE.test(path)) continue;
    const buf = await fetchProjectFile(proj, revision, path, token);
    await writeProjectMirrorFile(proj, path, buf);
    downloaded.push(path);
  }
  return { downloaded, root };
}

async function publishRollbackFailurePage(proj, token, reason) {
  const current = await getCurrentVersion(proj, token);
  if (!Number.isInteger(current)) throw new Error(`rollback fallback failed: current live revision could not be determined after: ${reason}`);
  const revision = await createDraftRevision(proj, current, token);
  await createSiteForRevision(proj, revision, ROLLBACK_FAIL_HTML, token, `rollback failed: ${String(reason).slice(0, 200)}`);
  await finishRevision(proj, revision, token);
  await setCurrentRevision(proj, revision, token, { syncLocal: false });
  await syncRevisionToLocal(proj, revision, token);
  return revision;
}

async function getRevisionMeta(proj, revision, token) {
  const res = await fetch(`${API_BASE}/projects/${proj.id}/revisions`, { headers: authHeaders(token) });
  const text = await res.text();
  if (!res.ok) throw new Error(`list_revisions failed (${res.status}): ${text}`);
  const data = JSON.parse(text);
  const rev = (data.revisions?.data || []).map((r) => r.project_revision).find((r) => r?.version === revision);
  return rev || null;
}

async function getCurrentPublishedRevision(proj, token) {
  const current = await getCurrentVersion(proj, token);
  if (!Number.isInteger(current)) throw new Error('safe_mode failed: current live revision could not be determined');
  const rev = await getRevisionMeta(proj, current, token);
  if (!rev || rev.draft) throw new Error(`safe_mode failed: current revision ${current} is missing or still draft`);
  return current;
}

async function createDraftRevision(proj, parentVersion, token) {
  const res = await fetch(
    `${API_BASE}/projects/${proj.id}/revisions`,
    {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ parent_version: parentVersion }),
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`create_revision failed (${res.status}): ${text}`);
  return JSON.parse(text).project_revision.version;
}

async function finishRevision(proj, revision, token) {
  const res = await fetch(
    `${API_BASE}/projects/${proj.id}/revisions/${revision}`,
    {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ draft: false }),
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`finish_revision failed (${res.status}): ${text}`);
  const meta = await getRevisionMeta(proj, revision, token);
  if (!meta || meta.draft) throw new Error(`finish_revision verification failed: revision ${revision} is not finalized`);
}

async function setCurrentRevision(proj, revision, token, options = {}) {
  const res = await fetch(
    `${API_BASE}/projects/${proj.id}`,
    {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ current_version: revision, auto_set_current: false }),
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`set_current_revision failed (${res.status}): ${text}`);
  const current = await getCurrentVersion(proj, token);
  if (current !== revision) throw new Error(`set_current_revision verification failed: live revision is ${current}, expected ${revision}`);
  if (options.syncLocal !== false) await syncRevisionToLocal(proj, revision, token);
}

async function createSiteForRevision(proj, revision, content, token, message = 'websim agent index.html update') {
  const meta = await getRevisionMeta(proj, revision, token);
  if (!meta) throw new Error(`site update failed: revision ${revision} does not exist`);
  const res = await fetch(`${API_BASE}/sites`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: meta.project_id,
      project_version: meta.version,
      project_revision_id: meta.id,
      content,
      prompt_data_override: { type: 'plaintext', text: message, data: null },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`site update failed (${res.status}): ${text}`);
  const body = JSON.parse(text);
  return body.site?.id || body.id || null;
}

async function getCurrentVersion(proj, token) {
  const res = await fetch(`${API_BASE}/projects/${proj.id}`, { headers: authHeaders(token) });
  const text = await res.text();
  if (!res.ok) return null;
  try {
    const body = JSON.parse(text);
    const project = body.project ?? body;
    return Number.isInteger(project.current_version) ? project.current_version : null;
  } catch {
    return null;
  }
}

// ── MCP Server ────────────────────────────────────────────────────

const server = new McpServer({ name: 'websim-multi-project', version: '2.0.0' });

// Project param schema reused across tools
const projectParam = z.string().nullish().describe('Project alias from projects.config.json. Uses defaultProject if omitted.');

// ── Local file writing (for LLM to stage edits) ────────────────────

server.tool(
  'write_file',
  'Write content to a local file in the project mirror (project/<alias>/<path>). Call this BEFORE upload_file after editing.',
  {
    path: z.string().describe('File path within the project, will write to project/<alias>/<path>.'),
    content: z.string().describe('Full new file content to write.'),
    project: projectParam,
  },
  async ({ path, content, project: projectAlias }) => {
    assertSafeProjectPath(path);
    const proj = getProject(projectAlias);
    assertMediaSize(path, Buffer.byteLength(content, 'utf8'), 'write_file');
    const dest = nodePath.join(PROJECT_DIR, proj.alias, path);
    await fs.promises.mkdir(nodePath.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, content, 'utf8');
    return { content: [{ type: 'text', text: `[${proj.alias}] Wrote ${content.length} bytes → ${dest}` }] };
  }
);

server.tool(
  'replace_in_file',
  'Replace exact text in a downloaded local file (project/<alias>/<path>). Prefer this over write_file for small edits so the model does not need to emit an entire HTML file.',
  {
    path: z.string().describe('File path within the project, already downloaded to project/<alias>/<path>.'),
    oldText: z.string().describe('Exact text to replace. Must occur exactly once.'),
    newText: z.string().describe('Replacement text.'),
    project: projectParam,
  },
  async ({ path, oldText, newText, project: projectAlias }) => {
    assertSafeProjectPath(path);
    const proj = getProject(projectAlias);
    const dest = nodePath.join(PROJECT_DIR, proj.alias, path);
    let content;
    try {
      content = await fs.promises.readFile(dest, 'utf8');
    } catch {
      throw new Error(`replace_in_file failed: local file not found at ${dest} — call download_file first`);
    }
    const first = content.indexOf(oldText);
    if (first === -1) throw new Error('replace_in_file failed: oldText not found');
    if (content.indexOf(oldText, first + oldText.length) !== -1) throw new Error('replace_in_file failed: oldText occurs more than once; provide a larger unique block');
    const next = content.slice(0, first) + newText + content.slice(first + oldText.length);
    await fs.promises.writeFile(dest, next, 'utf8');
    return { content: [{ type: 'text', text: `[${proj.alias}] Replaced ${oldText.length} chars with ${newText.length} chars in ${path}` }] };
  }
);

// ── Discovery tool ────────────────────────────────────────────────

server.tool(
  'list_projects',
  'List all configured projects (aliases, ids, slugs, labels). Use this to discover available projects.',
  {},
  async () => {
    const projects = Object.entries(config.projects || {}).map(([alias, p]) => ({
      alias,
      id: p.id,
      slug: p.slug,
      label: p.label || alias,
      isDefault: alias === config.defaultProject,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
  }
);

// ── File / revision tools ─────────────────────────────────────────

server.tool(
  'list_files',
  'List all files (assets) in the project at a given revision.',
  {
    revision: z.number().int().describe('Project revision number to list assets from.'),
    project: projectParam,
  },
  async ({ revision, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    const res = await fetch(
      `${API_BASE}/projects/${proj.id}/revisions/${revision}/assets`,
      { headers: authHeaders(token) }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`list_files failed (${res.status}): ${text}`);
    const data = JSON.parse(text);
    const files = (data.assets || []).map((a) => ({
      path: a.path, size: a.size, content_type: a.content_type,
    }));
    return { content: [{ type: 'text', text: `[${proj.alias}] Revision ${revision}:\n${JSON.stringify(files, null, 2)}` }] };
  }
);

server.tool(
  'download_file',
  'Download a file from the project into the local project/ folder.',
  {
    revision: z.number().int().describe('Project revision number to download from.'),
    path: z.string().describe('File path within the project, e.g. "index.html".'),
    project: projectParam,
  },
  async ({ revision, path, project: projectAlias }) => {
    assertSafeProjectPath(path);
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    if (isMediaPath(path)) {
      const url = `https://${proj.id}.c.websim.com/${encodeProjectPath(path)}?v=${revision}&raw=`;
      const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: '*/*', referer: `https://websim.com/p/${proj.id}/${revision}` } });
      if (!head.ok) throw new Error(`download blocked: could not preflight media ${path} (${head.status})`);
      const headLen = head.headers.get('content-length');
      const bytes = headLen ? Number.parseInt(headLen, 10) : null;
      if (!Number.isFinite(bytes)) throw new Error(`download blocked: media size could not be verified for ${path}`);
      assertMediaSize(path, bytes, 'download');
    }
    const buf = await fetchProjectFile(proj, revision, path, token);
    await writeProjectMirrorFile(proj, path, buf);
    // Return file contents so the LLM can edit them
    const previewLimit = 60000;
    const preview = buf.toString('utf8').slice(0, previewLimit);
    const truncated = buf.length > previewLimit ? '\n... [truncated, full file on disk]' : '';
    return { content: [{ type: 'text', text: `[${proj.alias}] Downloaded ${path} (${buf.length} bytes)\n\nFILE CONTENTS:\n${preview}${truncated}` }] };
  }
);

server.tool(
  'upload_file',
  'Upload a file from the local project/ folder to websim (create or replace).',
  {
    revision: z.number().int().describe('Project revision number to upload to.'),
    path: z.string().describe('File path within the project, read from project/<alias>/<path>.'),
    skip_moderation: z.boolean().optional().describe('Admin-only escape hatch used by trusted local automation. Skips media moderation for this upload.'),
    project: projectParam,
  },
  async ({ revision, path, skip_moderation, project: projectAlias }) => {
    assertSafeProjectPath(path);
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    const src = nodePath.join(PROJECT_DIR, proj.alias, path);
    let content;
    try {
      const st = await fs.promises.stat(src);
      assertMediaSize(path, st.size, 'upload');
      assertLocalVideoDuration(path, src);
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`upload failed: local file not found at ${src} — download or create it first`);
      throw err;
    }
    try {
      content = await fs.promises.readFile(src);
    } catch (err) {
      throw new Error(`upload failed: could not read ${src}: ${err.message}`);
    }
    assertMediaSize(path, content.length, 'upload');
    if (!skip_moderation && /\.(html?|css|js|mjs|jsx|tsx|json|md|txt)$/i.test(path)) {
      const moderation = await moderateTextForMedia(content.toString('utf8'));
      if (!moderation.ok) throw new Error(moderation.message || 'Blocked for user safety');
    }
    if (path === 'index.html') {
      const siteId = await createSiteForRevision(proj, revision, content.toString('utf8'), token);
      return { content: [{ type: 'text', text: `[${proj.alias}] Updated site content from index.html (${content.length} bytes${siteId ? `, site=${siteId}` : ''})` }] };
    }
    const existingAssetId = await getAssetId(proj.id, revision, path, token);
    await uploadAsset(proj.id, revision, path, content, token, existingAssetId);
    return { content: [{ type: 'text', text: `[${proj.alias}] ${existingAssetId ? 'Replaced' : 'Created'} ${path} (${content.length} bytes)` }] };
  }
);

server.tool(
  'clean_project_cache',
  'Delete stale local project mirror files from project/. Does not affect Websim revisions.',
  {
    max_age_hours: z.number().int().optional().describe('Delete local cache files older than this many hours. Default from WEBSIM_PROJECT_CACHE_MAX_AGE_HOURS or 24.'),
  },
  async ({ max_age_hours }) => {
    const maxAgeMs = Number.isInteger(max_age_hours) ? max_age_hours * 60 * 60 * 1000 : PROJECT_CACHE_MAX_AGE_MS;
    const out = await cleanupProjectCache(maxAgeMs);
    return { content: [{ type: 'text', text: `Cleaned local project cache: deleted=${out.deleted}, kept=${out.kept}, freed=${out.bytesFreed} bytes` }] };
  }
);

server.tool(
  'sync_revision_to_local',
  'Delete the local project mirror and pull index.html plus all assets from a published revision. Use after rollback/revert or before debugging local state.',
  {
    revision: z.number().int().describe('Published project revision to sync locally.'),
    project: projectParam,
  },
  async ({ revision, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    const out = await syncRevisionToLocal(proj, revision, token);
    return { content: [{ type: 'text', text: `[${proj.alias}] Synced revision ${revision} to ${out.root}: ${out.downloaded.join(', ')}` }] };
  }
);

server.tool(
  'rollback_to_revision',
  'Pause-safe rollback primitive: set live revision, verify it, and sync the local project mirror. If requested, publish a rollback-failure page when rollback fails.',
  {
    revision: z.number().int().describe('Published project revision to make live.'),
    fallback_on_fail: z.boolean().optional().describe('If true, publish a rollback-fail page when rollback cannot be completed. Default true.'),
    project: projectParam,
  },
  async ({ revision, fallback_on_fail = true, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    try {
      const meta = await getRevisionMeta(proj, revision, token);
      if (!meta) throw new Error(`revision ${revision} does not exist or is not visible`);
      if (meta.draft) throw new Error(`revision ${revision} is still draft and cannot be made live`);
      await setCurrentRevision(proj, revision, token);
      const out = await syncRevisionToLocal(proj, revision, token);
      return { content: [{ type: 'text', text: `[${proj.alias}] Rolled back live site to revision ${revision} and synced local mirror (${out.downloaded.length} files).` }] };
    } catch (err) {
      if (!fallback_on_fail) throw err;
      const fallbackRevision = await publishRollbackFailurePage(proj, token, err.message);
      return { content: [{ type: 'text', text: `[${proj.alias}] Rollback to revision ${revision} failed: ${err.message}. Published rollback-failure page at revision ${fallbackRevision} and synced local mirror.` }] };
    }
  }
);

server.tool(
  'enable_safe_mode',
  'Replace the live project with a simple safe-mode page saying images and videos are disabled. Admin/emergency use only.',
  { project: projectParam },
  async ({ project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    const parent = await getCurrentPublishedRevision(proj, token);
    const revision = await createDraftRevision(proj, parent, token);
    await createSiteForRevision(proj, revision, SAFE_MODE_HTML, token, 'safe mode homepage');
    const dupes = (await listAssets(proj.id, revision, token)).map(a => a.path).filter(p => DUPLICATE_INDEX_RE.test(p));
    for (const path of dupes) await deleteAsset(proj.id, revision, path, token);
    await finishRevision(proj, revision, token);
    await setCurrentRevision(proj, revision, token);
    return { content: [{ type: 'text', text: `[${proj.alias}] Safe mode enabled at revision ${revision} (previous live revision ${parent})` }] };
  }
);

server.tool(
  'delete_file',
  'Delete a file from the project at a given revision.',
  {
    revision: z.number().int().describe('Project revision number.'),
    path: z.string().describe('File path to delete, e.g. "style.css".'),
    project: projectParam,
  },
  async ({ revision, path, project: projectAlias }) => {
    assertSafeProjectPath(path);
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    await deleteAsset(proj.id, revision, path, token);
    return { content: [{ type: 'text', text: `[${proj.alias}] Deleted ${path}` }] };
  }
);

server.tool(
  'delete_duplicate_index_files',
  'Delete duplicate homepage assets like index (1).html from a revision. Keeps the real index.html untouched.',
  {
    revision: z.number().int().optional().describe('Revision to clean. Defaults to current live revision.'),
    project: projectParam,
  },
  async ({ revision, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    const targetRevision = Number.isInteger(revision) ? revision : await getCurrentVersion(proj, token);
    if (!Number.isInteger(targetRevision)) throw new Error('delete_duplicate_index_files failed: could not determine target revision');
    const assets = await listAssets(proj.id, targetRevision, token);
    const dupes = assets.map(a => a.path).filter(p => DUPLICATE_INDEX_RE.test(p));
    const deleted = [];
    for (const path of dupes) {
      await deleteAsset(proj.id, targetRevision, path, token);
      deleted.push(path);
    }
    return { content: [{ type: 'text', text: `[${proj.alias}] Duplicate index cleanup on revision ${targetRevision}: deleted ${deleted.length}${deleted.length ? ` (${deleted.join(', ')})` : ''}` }] };
  }
);

// ── Revision management ────────────────────────────────────────────

server.tool(
  'list_revisions',
  'List all revisions of a project (version, id, draft state, name, title, created_at).',
  { project: projectParam },
  async ({ project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    const currentVersion = await getCurrentVersion(proj, token);
    const res = await fetch(`${API_BASE}/projects/${proj.id}/revisions`, { headers: authHeaders(token) });
    const text = await res.text();
    if (!res.ok) throw new Error(`list_revisions failed (${res.status}): ${text}`);
    const data = JSON.parse(text);
    const revs = (data.revisions?.data || []).map((r) => ({
      version: r.project_revision?.version,
      id: r.project_revision?.id,
      draft: r.project_revision?.draft,
      current: r.project_revision?.version === currentVersion,
      name: r.site?.prompt?.text || '',
      title: r.site?.title || null,
      created_at: r.project_revision?.created_at,
    }));
    return { content: [{ type: 'text', text: `[${proj.alias}] Revisions:\n${JSON.stringify(revs, null, 2)}` }] };
  }
);

server.tool(
  'create_revision',
  'Create a new draft (editable) revision branched from an existing parent.',
  {
    parent_version: z.number().int().describe('The revision/version number to branch from.'),
    project: projectParam,
  },
  async ({ parent_version, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    const res = await fetch(
      `${API_BASE}/projects/${proj.id}/revisions`,
      {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ parent_version }),
      }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`create_revision failed (${res.status}): ${text}`);
    let summary = text;
    try {
      const rev = JSON.parse(text).project_revision;
      summary = `version=${rev.version}, draft=${rev.draft}, parent=${rev.parent_revision_version}`;
    } catch {}
    return { content: [{ type: 'text', text: `[${proj.alias}] Created revision: ${summary}` }] };
  }
);

server.tool(
  'finish_revision',
  'Publish a revision by clearing its draft flag (makes it final/immutable).',
  {
    revision: z.number().int().describe('Project revision number to finish/publish.'),
    project: projectParam,
  },
  async ({ revision, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    const res = await fetch(
      `${API_BASE}/projects/${proj.id}/revisions/${revision}`,
      {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ draft: false }),
      }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`finish_revision failed (${res.status}): ${text}`);
    const meta = await getRevisionMeta(proj, revision, token);
    if (!meta || meta.draft) throw new Error(`finish_revision verification failed: revision ${revision} is not finalized`);
    let summary = text;
    try {
      const rev = JSON.parse(text).project_revision;
      summary = `version=${rev.version}, draft=${rev.draft}`;
    } catch {}
    return { content: [{ type: 'text', text: `[${proj.alias}] Finished revision ${revision}: ${summary}` }] };
  }
);

server.tool(
  'set_current_revision',
  'Set the live/published revision of the project.',
  {
    revision: z.number().int().describe('Revision/version number to make live.'),
    project: projectParam,
  },
  async ({ revision, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    const rev = await getRevisionMeta(proj, revision, token);
    if (!rev) throw new Error(`set_current_revision blocked: revision ${revision} does not exist`);
    if (rev.draft) throw new Error(`set_current_revision blocked: revision ${revision} is still draft; call finish_revision first`);
    const res = await fetch(
      `${API_BASE}/projects/${proj.id}`,
      {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ current_version: revision, auto_set_current: false }),
      }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`set_current_revision failed (${res.status}): ${text}`);
    const current = await getCurrentVersion(proj, token);
    if (current !== revision) throw new Error(`set_current_revision verification failed: live revision is ${current}, expected ${revision}`);
    let summary = text;
    try {
      const p = JSON.parse(text).project ?? JSON.parse(text);
      summary = `current_version=${p.current_version}`;
    } catch {}
    return { content: [{ type: 'text', text: `[${proj.alias}] Set current revision to ${revision}: ${summary}` }] };
  }
);

server.tool(
  'list_revision_history',
  'List the edit history for a given revision.',
  {
    revision: z.number().int().describe('Revision number.'),
    project: projectParam,
  },
  async ({ revision, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const token = getBearer(proj);
    const res = await fetch(
      `${API_BASE}/projects/${proj.id}/revisions/${revision}/edit-history`,
      { headers: authHeaders(token) }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`list_revision_history failed (${res.status}): ${text}`);
    const data = JSON.parse(text);
    const edits = (data.edits || []).map((e) => ({
      id: e.id, at: e.created_at,
      op: e.data?.type ?? 'edit',
      path: e.data?.path ?? e.new_path ?? e.old_path,
      by: e.by,
    }));
    return { content: [{ type: 'text', text: `[${proj.alias}] Edit history:\n${JSON.stringify(edits, null, 2)}` }] };
  }
);

// ── Comment tools ──────────────────────────────────────────────────

const { postComment, postReply, deleteComment, listComments, listCommentReplies } = require('./websim-comment.js');

server.tool(
  'list_comments',
  'List top-level comments on the project.',
  {
    limit: z.number().int().optional().describe('Max comments (default 20).'),
    project: projectParam,
  },
  async ({ limit, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const comments = await listComments(limit ?? 20, proj.id, proj.slug, getBearer(proj));
    return { content: [{ type: 'text', text: JSON.stringify({ project: proj.alias, comments }) }] };
  }
);

server.tool(
  'list_comment_replies',
  'List replies to a specific comment.',
  {
    comment_id: z.string().describe('Parent comment id.'),
    limit: z.number().int().optional().describe('Max replies (default 20).'),
    project: projectParam,
  },
  async ({ comment_id, limit, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const replies = await listCommentReplies(comment_id, limit ?? 20, proj.id, proj.slug, getBearer(proj));
    return { content: [{ type: 'text', text: `[${proj.alias}] Replies to ${comment_id}:\n${JSON.stringify(replies, null, 2)}` }] };
  }
);

server.tool(
  'post_comment',
  'Post a new top-level comment on the project.',
  {
    content: z.string().describe('Comment text to post.'),
    project: projectParam,
  },
  async ({ content, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const out = await postComment(content, proj.id, proj.slug, getBearer(proj));
    return { content: [{ type: 'text', text: `[${proj.alias}] Posted comment: ${out}` }] };
  }
);

server.tool(
  'post_reply',
  'Reply to an existing comment.',
  {
    comment_id: z.string().describe('Parent comment id.'),
    content: z.string().describe('Reply text.'),
    project: projectParam,
  },
  async ({ comment_id, content, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const out = await postReply(comment_id, content, proj.id, proj.slug, getBearer(proj));
    return { content: [{ type: 'text', text: `[${proj.alias}] Replied to ${comment_id}: ${out}` }] };
  }
);

server.tool(
  'delete_comment',
  'Delete a comment by id.',
  {
    comment_id: z.string().describe('Comment id to delete.'),
    project: projectParam,
  },
  async ({ comment_id, project: projectAlias }) => {
    const proj = getProject(projectAlias);
    const out = await deleteComment(comment_id, proj.id, proj.slug, getBearer(proj));
    return { content: [{ type: 'text', text: `[${proj.alias}] Deleted comment ${comment_id}: ${out}` }] };
  }
);

// ── Boot ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp] websim-multi-project v2 running on stdio (${Object.keys(config.projects || {}).length} projects)`);
}

main().catch((err) => {
  console.error('[mcp] Fatal:', err);
  process.exit(1);
});
