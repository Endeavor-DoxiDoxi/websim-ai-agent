#!/usr/bin/env node
const fs = require('fs');
const assert = require('assert');

const agent = fs.readFileSync('agent.js', 'utf8');
const mcp = fs.readFileSync('mcp-server.js', 'utf8');
const moderation = require('./moderation.js');

const cfg = moderation.moderationConfig({});
assert(cfg.maxMediaBytes <= 25 * 1024 * 1024, 'default max media must stay tight');
assert(cfg.maxVideoBytes <= 25 * 1024 * 1024, 'default max video must stay tight');
assert(cfg.maxVideoSeconds <= 60, 'default max video duration must stay tight');
assert(cfg.timeoutMs <= 8000, 'default moderation timeout must stay tight');
assert(cfg.maxMediaUrls <= 8, 'default media-url count must stay tight');

assert(agent.includes('this build owns newly-created revision'), 'agent must guard against promoting another revision');
assert(agent.includes('finish_revision(revision=${buildRevision'), 'agent must force finish on buildRevision');
assert(agent.includes('set_current_revision(revision=${buildRevision'), 'agent must force live promotion on buildRevision');
assert(agent.includes('HYPERFRAMES_NOTICE'), 'agent must publicly note Hyperframes video generation');
assert(agent.includes('!safemode on') && agent.includes('!safemode off'), 'safe mode must support explicit on/off syntax');
assert(agent.includes('safeModePreviousRevision'), 'safe mode restore revision must be tracked');
assert(agent.includes("category = 'triage_error'"), 'triage failures must not strand currentlyProcessing');
assert(agent.includes('queuedModeration'), 'queued items must be rechecked by current moderation before triage/build');
assert(agent.includes("category: 'status'") && agent.includes("category: 'admin'"), 'status/admin commands must be marked as seen');

assert(mcp.includes('getCurrentPublishedRevision'), 'safe mode must branch from current live revision');
assert(mcp.includes('set_current_revision verification failed'), 'set_current_revision must verify live revision');
assert(mcp.includes('revision ${revision} is still draft'), 'set_current_revision must reject draft revisions');
assert(mcp.includes('previous live revision'), 'safe mode response must report previous live revision');

const media = moderation.extractMediaUrls('x https://example.com/a.mp4 and https://example.com/b.jpg and ![](https://api.websim.com/blobs/abc123)');
assert.deepStrictEqual(media.map(m => m.type), ['video', 'image', 'unknown']);

console.log('static checks passed');
