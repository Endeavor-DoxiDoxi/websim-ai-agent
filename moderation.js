const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const nodePath = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ENDPOINT = 'https://imgcheck.val.run';
const DEFAULT_MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_SECONDS = 30 * 60;
const DEFAULT_MAX_VIDEO_PROBE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_MEDIA_URLS = 8;
const DEFAULT_MODERATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BLOCKED_CLASSES = new Set(['Sexy', 'Porn', 'Hentai']);
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(?:[?#][^\s"'<>)]*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|avi|mkv)(?:[?#][^\s"'<>)]*)?$/i;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]*/gi;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^\s"'<>)]*)\)/gi;
const MAX_REDIRECTS = 5;

const BLOCK_MESSAGE = 'Blocked for user safety (Please note: this detection is not 100 percent accurate. This affects prompts with images and videos. In the future, a new filtering system might be added, but for now, please understand not all images and videos will be allowed through.)';
const moderationCache = new Map();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function moderationConfig(env = process.env) {
  const maxMediaBytes = parsePositiveInt(env.WEBSIM_MAX_MEDIA_BYTES, DEFAULT_MAX_MEDIA_BYTES);
  return {
    enabled: env.WEBSIM_MEDIA_MODERATION !== 'false',
    endpoint: (env.WEBSIM_MEDIA_MODERATION_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    threshold: Number.parseFloat(env.WEBSIM_MEDIA_MODERATION_THRESHOLD || '0.55'),
    videoFrames: Math.min(parsePositiveInt(env.WEBSIM_VIDEO_MODERATION_FRAMES, 3), 5),
    timeoutMs: parsePositiveInt(env.WEBSIM_MEDIA_MODERATION_TIMEOUT_MS, 8000),
    maxMediaBytes,
    maxImageBytes: Math.min(parsePositiveInt(env.WEBSIM_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES), maxMediaBytes),
    maxVideoBytes: Math.min(parsePositiveInt(env.WEBSIM_MAX_VIDEO_BYTES, DEFAULT_MAX_VIDEO_BYTES), maxMediaBytes),
    maxVideoProbeBytes: Math.min(parsePositiveInt(env.WEBSIM_MAX_VIDEO_PROBE_BYTES, DEFAULT_MAX_VIDEO_PROBE_BYTES), maxMediaBytes),
    maxVideoSeconds: parsePositiveInt(env.WEBSIM_MAX_VIDEO_SECONDS, DEFAULT_MAX_VIDEO_SECONDS),
    maxMediaUrls: parsePositiveInt(env.WEBSIM_MAX_MEDIA_URLS, DEFAULT_MAX_MEDIA_URLS),
    cacheTtlMs: parsePositiveInt(env.WEBSIM_MODERATION_CACHE_TTL_SECONDS, DEFAULT_MODERATION_CACHE_TTL_MS / 1000) * 1000,
    allowPrivateHosts: env.WEBSIM_ALLOW_PRIVATE_MEDIA_HOSTS === 'true',
  };
}

function pruneCache(maxEntries = 512) {
  if (moderationCache.size <= maxEntries) return;
  const entries = [...moderationCache.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  for (const [key] of entries.slice(0, Math.max(1, entries.length - maxEntries))) moderationCache.delete(key);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractUrls(text) {
  if (!text) return [];
  return unique([...String(text).matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, '')));
}

function extractMediaUrls(text) {
  const urls = extractUrls(text);
  const markdownImages = unique([...String(text || '').matchAll(MARKDOWN_IMAGE_RE)].map((m) => m[1].replace(/[.,;:!?]+$/, '')));
  const markdownSet = new Set(markdownImages);
  return urls.map((url) => {
    if (IMAGE_EXT_RE.test(url)) return { type: 'image', url };
    if (VIDEO_EXT_RE.test(url)) return { type: 'video', url };
    if (markdownSet.has(url) || /\/blobs\//i.test(new URL(url).pathname)) return { type: 'unknown', url };
    return null;
  }).filter(Boolean);
}

function extractDataImages(text) {
  if (!text) return [];
  const re = /data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)/gi;
  return [...String(text).matchAll(re)].map((m, i) => ({ type: 'image-data', label: `inline-image-${i + 1}`, buffer: Buffer.from(m[2], 'base64') }));
}

function cacheKey(type, url) { return `${type}:${url}`; }
function getCached(type, url, cfg) {
  const hit = moderationCache.get(cacheKey(type, url));
  if (!hit) return null;
  if (Date.now() - hit.at > cfg.cacheTtlMs) { moderationCache.delete(cacheKey(type, url)); return null; }
  return hit.result;
}
function setCached(type, url, result) { moderationCache.set(cacheKey(type, url), { at: Date.now(), result }); pruneCache(); }

function isUnsafeClassification(classes, threshold) {
  const hit = (classes || []).find((c) => BLOCKED_CLASSES.has(c.className) && Number(c.probability) >= threshold);
  return hit ? { unsafe: true, className: hit.className, probability: hit.probability } : { unsafe: false };
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] === 0;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:') || v === '::';
}

async function validateRemoteUrl(rawUrl, cfg) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`unsupported protocol ${parsed.protocol}`);
  if (!parsed.hostname) throw new Error('missing URL host');
  if (!cfg.allowPrivateHosts) {
    const records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
    if (records.some((r) => isPrivateIp(r.address))) throw new Error('private/local media hosts are blocked');
  }
}

async function safeFetch(url, init, cfg) {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await validateRemoteUrl(current, cfg);
    const res = await fetch(current, { ...init, redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const loc = res.headers.get('location');
    if (!loc) throw new Error('redirect missing location');
    current = new URL(loc, current).toString();
  }
  throw new Error('too many redirects');
}

function mediaTypeMatches(type, contentType) {
  const ct = String(contentType || '').toLowerCase().split(';', 1)[0].trim();
  if (type === 'image') return ct.startsWith('image/');
  if (type === 'video') return ct.startsWith('video/') || ct === 'application/octet-stream';
  return false;
}

async function preflightRemoteMedia(url, type, cfg) {
  const res = await safeFetch(url, { method: 'HEAD' }, cfg);
  if (!res.ok) throw new Error(`HEAD failed (${res.status})`);
  const lenHeader = res.headers.get('content-length');
  const bytes = lenHeader ? Number.parseInt(lenHeader, 10) : null;
  const contentType = res.headers.get('content-type') || '';
  if (!mediaTypeMatches(type, contentType)) throw new Error(`unexpected content-type ${contentType || 'missing'}`);
  if (!Number.isFinite(bytes)) throw new Error(`${type} size could not be verified`);
  const max = type === 'video' ? cfg.maxVideoBytes : cfg.maxImageBytes;
  if (bytes > max) throw new Error(`${type} is too large (${bytes} bytes > ${max} bytes)`);
  if (type === 'video' && bytes > cfg.maxVideoProbeBytes) throw new Error(`video is too large to safely probe on this host (${bytes} bytes > ${cfg.maxVideoProbeBytes} bytes)`);
  return { bytes, contentType };
}


async function preflightUnknownMedia(url, cfg) {
  const res = await safeFetch(url, { method: 'HEAD' }, cfg);
  if (!res.ok) throw new Error(`HEAD failed (${res.status})`);
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.startsWith('image/')) {
    const len = res.headers.get('content-length');
    const bytes = len ? Number.parseInt(len, 10) : null;
    if (!Number.isFinite(bytes)) throw new Error('image size could not be verified');
    if (bytes > cfg.maxImageBytes) throw new Error(`image is too large (${bytes} bytes > ${cfg.maxImageBytes} bytes)`);
    return 'image';
  }
  if (contentType.startsWith('video/') || contentType.split(';', 1)[0].trim() === 'application/octet-stream') {
    const len = res.headers.get('content-length');
    const bytes = len ? Number.parseInt(len, 10) : null;
    if (!Number.isFinite(bytes)) throw new Error('video size could not be verified');
    if (bytes > cfg.maxVideoBytes) throw new Error(`video is too large (${bytes} bytes > ${cfg.maxVideoBytes} bytes)`);
    if (bytes > cfg.maxVideoProbeBytes) throw new Error(`video is too large to safely probe on this host (${bytes} bytes > ${cfg.maxVideoProbeBytes} bytes)`);
    return 'video';
  }
  throw new Error(`unknown media URL has non-media content-type ${contentType || 'missing'}`);
}

async function classifyImageUrl(url, cfg) {
  const res = await fetch(`${cfg.endpoint}/?img=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(cfg.timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`moderation API ${res.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

async function classifyImageBuffer(buffer, cfg) {
  const res = await fetch(cfg.endpoint + '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buffer,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`moderation API ${res.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

function hasFfmpeg() { return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0; }
function hasFfprobe() { return spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0; }

async function downloadLimited(url, cfg, expectedBytes) {
  const dir = await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), 'websim-media-'));
  const file = nodePath.join(dir, 'media');
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const res = await safeFetch(url, { method: 'GET' }, cfg);
  if (!res.ok) { cleanup(); throw new Error(`download failed (${res.status})`); }
  const ct = res.headers.get('content-type') || '';
  if (!mediaTypeMatches('video', ct)) { cleanup(); throw new Error(`unexpected download content-type ${ct || 'missing'}`); }
  let seen = 0;
  const out = fs.createWriteStream(file, { flags: 'wx' });
  try {
    for await (const chunk of res.body) {
      seen += chunk.length;
      if (seen > cfg.maxVideoProbeBytes || seen > cfg.maxVideoBytes || (expectedBytes && seen > expectedBytes + 1024)) { out.destroy(); cleanup(); throw new Error('video download exceeded verified size limit'); }
      if (!out.write(chunk)) await new Promise((resolve, reject) => { out.once('drain', resolve); out.once('error', reject); });
    }
    await new Promise((resolve, reject) => out.end((err) => err ? reject(err) : resolve()));
  } catch (err) {
    out.destroy(); cleanup(); throw err;
  }
  return { file, cleanup, bytes: seen };
}

function getLocalVideoDurationSeconds(filePath, cfg) {
  if (!hasFfprobe()) throw new Error('ffprobe unavailable for video duration check');
  const out = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ], { encoding: 'utf8', timeout: Math.min(cfg.timeoutMs, 15000) });
  if (out.status !== 0) throw new Error((out.stderr || out.stdout || 'ffprobe failed').slice(0, 200));
  const seconds = Number.parseFloat(String(out.stdout || '').trim());
  if (!Number.isFinite(seconds)) throw new Error('video duration could not be parsed');
  return seconds;
}

async function extractVideoFrames(filePath, frameCount, cfg) {
  if (!hasFfmpeg()) throw new Error('ffmpeg unavailable for video moderation');
  const dir = await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), 'websim-video-frames-'));
  const pattern = nodePath.join(dir, 'frame-%03d.jpg');
  try {
    const fps = `fps=1/${Math.max(1, Math.floor(20 / Math.max(1, frameCount)))}`;
    const out = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', filePath, '-vf', fps, '-frames:v', String(frameCount), pattern], { encoding: 'utf8', timeout: Math.min(cfg.timeoutMs * 2, 20000) });
    if (out.status !== 0) throw new Error((out.stderr || out.stdout || 'ffmpeg failed').slice(0, 200));
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    return await Promise.all(files.map((f) => fs.promises.readFile(nodePath.join(dir, f))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function moderateImage(url, cfg) {
  const cached = getCached('image', url, cfg); if (cached) return cached;
  await preflightRemoteMedia(url, 'image', cfg);
  const classes = await classifyImageUrl(url, cfg);
  const verdict = isUnsafeClassification(classes, cfg.threshold);
  const result = { ok: !verdict.unsafe, type: 'image', url, verdict, classes };
  setCached('image', url, result);
  return result;
}

async function moderateImageBuffer(label, buffer, cfg) {
  if (buffer.length > cfg.maxImageBytes) throw new Error(`inline image is too large (${buffer.length} bytes > ${cfg.maxImageBytes} bytes)`);
  const classes = await classifyImageBuffer(buffer, cfg);
  const verdict = isUnsafeClassification(classes, cfg.threshold);
  return { ok: !verdict.unsafe, type: 'image', url: label, verdict, classes };
}

async function moderateVideo(url, cfg) {
  const cached = getCached('video', url, cfg); if (cached) return cached;
  const preflight = await preflightRemoteMedia(url, 'video', cfg);
  const local = await downloadLimited(url, cfg, preflight.bytes);
  try {
    const duration = getLocalVideoDurationSeconds(local.file, cfg);
    if (duration > cfg.maxVideoSeconds) throw new Error(`video is too long (${Math.round(duration)}s > ${cfg.maxVideoSeconds}s)`);
    const frames = await extractVideoFrames(local.file, cfg.videoFrames, cfg);
    if (frames.length === 0) throw new Error('no frames extracted for video moderation');
    let unsafe = 0;
    const details = [];
    for (let i = 0; i < frames.length; i++) {
      const classes = await classifyImageBuffer(frames[i], cfg);
      const verdict = isUnsafeClassification(classes, cfg.threshold);
      if (verdict.unsafe) unsafe++;
      details.push({ frame: i + 1, verdict });
    }
    const ratio = unsafe / frames.length;
    const result = { ok: ratio <= 0.5, type: 'video', url, durationSeconds: duration, unsafeFrames: unsafe, frames: frames.length, details };
    setCached('video', url, result);
    return result;
  } finally {
    local.cleanup();
  }
}

async function moderateTextForMedia(text, options = {}) {
  const cfg = { ...moderationConfig(), ...options };
  if (!cfg.enabled) return { ok: true, skipped: true, reason: 'disabled' };
  const media = extractMediaUrls(text);
  const inlineImages = extractDataImages(text);
  if (media.length > cfg.maxMediaUrls) return { ok: false, reason: `too many media URLs (${media.length} > ${cfg.maxMediaUrls})`, message: BLOCK_MESSAGE, results: [] };
  if (media.length === 0 && inlineImages.length === 0) return { ok: true, checked: 0 };

  const results = [];
  for (const item of media) {
    try {
      const resolvedType = item.type === 'unknown' ? await preflightUnknownMedia(item.url, cfg) : item.type;
      const result = resolvedType === 'video' ? await moderateVideo(item.url, cfg) : await moderateImage(item.url, cfg);
      results.push(result);
      if (!result.ok) return { ok: false, blocked: item.url, result, message: BLOCK_MESSAGE, results };
    } catch (err) {
      const label = item.type === 'video' ? 'Video' : (item.type === 'image' ? 'Image' : 'Media');
      return { ok: false, blocked: item.url, reason: `${label} could not be verified: ${err.message}`, message: BLOCK_MESSAGE, results };
    }
  }

  for (const item of inlineImages) {
    const result = await moderateImageBuffer(item.label, item.buffer, cfg);
    results.push(result);
    if (!result.ok) return { ok: false, blocked: item.label, result, message: BLOCK_MESSAGE, results };
  }

  return { ok: true, checked: results.length, results };
}

module.exports = {
  BLOCK_MESSAGE,
  BLOCKED_CLASSES,
  DEFAULT_ENDPOINT,
  DEFAULT_MAX_MEDIA_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_VIDEO_BYTES,
  DEFAULT_MAX_VIDEO_SECONDS,
  DEFAULT_MAX_VIDEO_PROBE_BYTES,
  extractMediaUrls,
  moderateTextForMedia,
  moderationConfig,
  preflightRemoteMedia,
  preflightUnknownMedia,
};
