const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ENDPOINT = 'https://imgcheck.val.run';
const DEFAULT_MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_SECONDS = 30 * 60;
const BLOCKED_CLASSES = new Set(['Sexy', 'Porn', 'Hentai']);
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(?:[?#][^\s"'<>)]*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|avi|mkv)(?:[?#][^\s"'<>)]*)?$/i;
const URL_RE = /https?:\/\/[^\s"'<>)]*/gi;

const BLOCK_MESSAGE = 'Blocked for user safety (Please note: this detection is not 100 percent accurate. This affects prompts with images and videos. In the future, a new filtering system might be added, but for now, please understand not all images and videos will be allowed through.)';

function moderationConfig(env = process.env) {
  return {
    enabled: env.WEBSIM_MEDIA_MODERATION !== 'false',
    endpoint: (env.WEBSIM_MEDIA_MODERATION_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    threshold: Number.parseFloat(env.WEBSIM_MEDIA_MODERATION_THRESHOLD || '0.55'),
    videoFrames: Number.parseInt(env.WEBSIM_VIDEO_MODERATION_FRAMES || '5', 10),
    timeoutMs: Number.parseInt(env.WEBSIM_MEDIA_MODERATION_TIMEOUT_MS || '15000', 10),
    maxMediaBytes: Number.parseInt(env.WEBSIM_MAX_MEDIA_BYTES || String(DEFAULT_MAX_MEDIA_BYTES), 10),
    maxVideoSeconds: Number.parseInt(env.WEBSIM_MAX_VIDEO_SECONDS || String(DEFAULT_MAX_VIDEO_SECONDS), 10),
  };
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
  return urls.map((url) => {
    if (IMAGE_EXT_RE.test(url)) return { type: 'image', url };
    if (VIDEO_EXT_RE.test(url)) return { type: 'video', url };
    return null;
  }).filter(Boolean);
}

function extractDataImages(text) {
  if (!text) return [];
  const re = /data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)/gi;
  return [...String(text).matchAll(re)].map((m, i) => ({ type: 'image-data', label: `inline-image-${i + 1}`, buffer: Buffer.from(m[2], 'base64') }));
}

function isUnsafeClassification(classes, threshold) {
  const hit = (classes || []).find((c) => BLOCKED_CLASSES.has(c.className) && Number(c.probability) >= threshold);
  return hit ? { unsafe: true, className: hit.className, probability: hit.probability } : { unsafe: false };
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

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
}

function hasFfprobe() {
  return spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0;
}

async function getRemoteContentLength(url, timeoutMs) {
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`HEAD failed (${res.status})`);
  const len = res.headers.get('content-length');
  return len ? Number.parseInt(len, 10) : null;
}

async function enforceRemoteMediaLimits(url, type, cfg) {
  let bytes = null;
  try { bytes = await getRemoteContentLength(url, cfg.timeoutMs); }
  catch (err) {
    if (type === 'video') throw new Error(`video size could not be verified: ${err.message}`);
  }
  if (Number.isFinite(bytes) && bytes > cfg.maxMediaBytes) {
    throw new Error(`media is too large (${bytes} bytes > ${cfg.maxMediaBytes} bytes)`);
  }
  if (type === 'video' && bytes === null) throw new Error('video size could not be verified');
}

function getVideoDurationSeconds(url) {
  if (!hasFfprobe()) throw new Error('ffprobe unavailable for video duration check');
  const out = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    url,
  ], { encoding: 'utf8', timeout: 30000 });
  if (out.status !== 0) throw new Error((out.stderr || out.stdout || 'ffprobe failed').slice(0, 200));
  const seconds = Number.parseFloat(String(out.stdout || '').trim());
  if (!Number.isFinite(seconds)) throw new Error('video duration could not be parsed');
  return seconds;
}

async function extractVideoFrames(url, frameCount) {
  if (!hasFfmpeg()) throw new Error('ffmpeg unavailable for video moderation');
  const dir = await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), 'websim-video-frames-'));
  const pattern = nodePath.join(dir, 'frame-%03d.jpg');
  try {
    const fps = `fps=1/${Math.max(1, Math.floor(20 / Math.max(1, frameCount)))}`;
    const out = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', url,
      '-vf', fps,
      '-frames:v', String(frameCount),
      pattern,
    ], { encoding: 'utf8', timeout: 30000 });
    if (out.status !== 0) throw new Error((out.stderr || out.stdout || 'ffmpeg failed').slice(0, 200));
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    return await Promise.all(files.map((f) => fs.promises.readFile(nodePath.join(dir, f))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function moderateImage(url, cfg) {
  await enforceRemoteMediaLimits(url, 'image', cfg);
  const classes = await classifyImageUrl(url, cfg);
  const verdict = isUnsafeClassification(classes, cfg.threshold);
  return { ok: !verdict.unsafe, type: 'image', url, verdict, classes };
}

async function moderateImageBuffer(label, buffer, cfg) {
  const classes = await classifyImageBuffer(buffer, cfg);
  const verdict = isUnsafeClassification(classes, cfg.threshold);
  return { ok: !verdict.unsafe, type: 'image', url: label, verdict, classes };
}

async function moderateVideo(url, cfg) {
  await enforceRemoteMediaLimits(url, 'video', cfg);
  const duration = getVideoDurationSeconds(url);
  if (duration > cfg.maxVideoSeconds) throw new Error(`video is too long (${Math.round(duration)}s > ${cfg.maxVideoSeconds}s)`);
  const frames = await extractVideoFrames(url, cfg.videoFrames);
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
  return { ok: ratio <= 0.5, type: 'video', url, durationSeconds: duration, unsafeFrames: unsafe, frames: frames.length, details };
}

async function moderateTextForMedia(text, options = {}) {
  const cfg = { ...moderationConfig(), ...options };
  if (!cfg.enabled) return { ok: true, skipped: true, reason: 'disabled' };
  const media = extractMediaUrls(text);
  const inlineImages = extractDataImages(text);
  if (media.length === 0 && inlineImages.length === 0) return { ok: true, checked: 0 };

  const results = [];
  for (const item of media) {
    try {
      const result = item.type === 'video'
        ? await moderateVideo(item.url, cfg)
        : await moderateImage(item.url, cfg);
      results.push(result);
      if (!result.ok) return { ok: false, blocked: item.url, result, message: BLOCK_MESSAGE, results };
    } catch (err) {
      if (item.type === 'video') {
        return { ok: false, blocked: item.url, reason: `Video could not be verified: ${err.message}`, message: BLOCK_MESSAGE, results };
      }
      results.push({ ok: true, warning: `Image moderation failed open: ${err.message}`, url: item.url });
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
  DEFAULT_MAX_VIDEO_SECONDS,
  extractMediaUrls,
  moderateTextForMedia,
  moderationConfig,
};
