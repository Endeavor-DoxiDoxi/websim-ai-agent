#!/usr/bin/env node
const fs = require('fs');
const assert = require('assert');

const agent = fs.readFileSync('agent.js', 'utf8');
const mcp = fs.readFileSync('mcp-server.js', 'utf8');
const hyperframesSample = fs.readFileSync('examples/hyperframes-sample/index.html', 'utf8');
const moderation = require('./moderation.js');

const cfg = moderation.moderationConfig({});
assert(cfg.maxMediaBytes <= 500 * 1024 * 1024, 'default max media must stay within the hard cap');
assert(cfg.maxVideoBytes <= 500 * 1024 * 1024, 'default max video must stay within the hard cap');
assert(cfg.maxVideoProbeBytes <= 50 * 1024 * 1024, 'default video probe/download budget must stay Pi-safe');
assert(cfg.maxVideoSeconds <= 30 * 60, 'default max video duration must stay within the hard cap');
assert(cfg.timeoutMs <= 8000, 'default moderation timeout must stay tight');
assert(cfg.maxMediaUrls <= 8, 'default media-url count must stay tight');
assert(moderation.DEFAULT_MAX_VIDEO_SECONDS === 30 * 60, 'video duration hard cap should be 30 minutes');
assert(moderation.preflightRemoteMedia.toString().includes('safeFetch'), 'remote media preflight must validate redirects');
assert(moderation.moderationConfig({}).maxVideoProbeBytes < moderation.moderationConfig({}).maxVideoBytes, 'video probe budget must be lower than video hard cap');

assert(agent.includes('this build owns newly-created revision'), 'agent must guard against promoting another revision');
assert(agent.includes('refusing to ${name} before create_revision'), 'agent must block remote mutation before create_revision');
assert(agent.includes('current live revision is ${liveRevision}'), 'agent must branch only from discovered live revision');
assert(agent.includes('finish_revision(revision=${buildRevision'), 'agent must force finish on buildRevision');
assert(agent.includes('set_current_revision(revision=${buildRevision'), 'agent must force live promotion on buildRevision');
assert(agent.includes('HYPERFRAMES_NOTICE'), 'agent must publicly note Hyperframes video generation');
assert(agent.includes('!safemode on') && agent.includes('!safemode off'), 'safe mode must support explicit on/off syntax');
assert(agent.includes('safeModePreviousRevision'), 'safe mode restore revision must be tracked');
assert(agent.includes("category = 'triage_error'"), 'triage failures must not strand currentlyProcessing');
assert(agent.includes('queuedModeration'), 'queued items must be rechecked by current moderation before triage/build');
assert(agent.includes("subcategory: 'drop_usage'"), 'admin command usage errors must still be marked seen/admin');
assert(agent.includes("category: 'status'") && agent.includes("category: 'admin'"), 'status/admin commands must be marked as seen');
assert(agent.includes('🎬 generating hyperframes video'), 'Hyperframes public notice must say generating hyperframes video');
assert(agent.includes('Hyperframes is not an AI model'), 'Hyperframes public notice must say it is not an AI model');
assert(agent.includes('pure HTML video code / code-based video generation'), 'Hyperframes public notice must describe pure HTML code-based video generation');
assert(agent.includes('data-composition-id') && agent.includes('data-start') && agent.includes('data-duration') && agent.includes('data-width') && agent.includes('data-height'), 'agent prompt must teach Hyperframes composition attributes');

assert(mcp.includes('getCurrentPublishedRevision'), 'safe mode must branch from current live revision');
assert(mcp.includes('set_current_revision verification failed'), 'set_current_revision must verify live revision');
assert(mcp.includes('revision ${revision} is still draft'), 'set_current_revision must reject draft revisions');
assert(mcp.includes('previous live revision'), 'safe mode response must report previous live revision');
assert(mcp.includes('download blocked: media size could not be verified'), 'media downloads must fail closed if size cannot be verified');

assert(mcp.includes('DUPLICATE_INDEX_RE'), 'MCP must detect duplicate index filenames');
assert(mcp.includes('blocked duplicate homepage path'), 'MCP must block index (n).html paths');
assert(mcp.includes('delete_duplicate_index_files'), 'MCP must expose duplicate index cleanup tool');

assert(mcp.includes('existingAssetId'), 'uploads must use Websim official existingAssetId metadata');
assert(mcp.includes('new File([body], path'), 'uploads must name the file by target path like websim-cli');
assert(mcp.includes('/edit-assets'), 'deletes must use edit-assets endpoint so spaced paths work');

assert(mcp.includes('createSiteForRevision'), 'index.html uploads must update Websim site content');
assert(mcp.includes("path === 'index.html'"), 'upload_file must special-case canonical index.html');
assert(mcp.includes('Updated site content from index.html'), 'index.html upload must report site-content update');
assert(mcp.includes('safe mode homepage'), 'safe mode must update site content, not upload index asset');
assert(agent.includes('!fixindex') && agent.includes('delete_duplicate_index_files'), 'agent must expose admin duplicate index cleanup');

assert(agent.includes('if (!interruptedId) return 0;'), 'recovery must not requeue historical processing entries without an exact interrupted id');
assert(agent.includes('Preserve currentlyProcessing on shutdown'), 'shutdown must preserve exact interrupted item for narrow recovery');

const media = moderation.extractMediaUrls('x https://example.com/a.mp4 and https://example.com/b.jpg and ![](https://api.websim.com/blobs/abc123)');
assert.deepStrictEqual(media.map(m => m.type), ['video', 'image', 'unknown']);
const blockedScheme = moderation.extractMediaUrls('x ftp://example.com/a.mp4');
assert.deepStrictEqual(blockedScheme.map(m => m.type), ['video']);

for (const needle of [
  'data-composition-id="websim-hyperframes-sample"',
  'data-start="0"',
  'data-width="1920"',
  'data-height="1080"',
  'data-duration="5"',
  'data-track-index="1"',
  "window.__timelines['websim-hyperframes-sample']",
]) assert(hyperframesSample.includes(needle), `Hyperframes sample missing ${needle}`);

console.log('static checks passed');
