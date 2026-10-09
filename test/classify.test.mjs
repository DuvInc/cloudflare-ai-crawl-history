import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botName, kindOf } from '../lib/classify.mjs';

test('kindOf: llms.txt is llms, not an asset, even though it ends in .txt', () => {
  assert.equal(kindOf('/llms.txt'), 'llms');
  assert.equal(kindOf('/docs/llms-full.txt'), 'llms');
  assert.equal(kindOf('/robots.txt'), 'feed');
  assert.equal(kindOf('/notes.txt'), 'asset');
});

test('kindOf: Markdown twins, feeds, assets and pages', () => {
  assert.equal(kindOf('/blog/post.md'), 'twin');
  assert.equal(kindOf('/sitemap-0.xml'), 'feed');
  assert.equal(kindOf('/_astro/app.4f2a.css'), 'asset');
  assert.equal(kindOf('/_next/static/chunk'), 'asset');
  assert.equal(kindOf('/images/hero'), 'asset');
  assert.equal(kindOf('/pricing'), 'page');
  assert.equal(kindOf('/'), 'page');
  assert.equal(kindOf('/blog/post?utm=1'), 'page');
});

test('kindOf: asset directories are configurable', () => {
  assert.equal(kindOf('/illustrations/a', { assetDirs: ['illustrations'] }), 'asset');
  assert.equal(kindOf('/images/a', { assetDirs: [] }), 'page');
});

test('botName: known crawlers are normalised to one spelling', () => {
  assert.equal(botName('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)'), 'GPTBot');
  assert.equal(botName('mozilla/5.0 (compatible; gptbot/1.0)'), 'GPTBot');
  assert.equal(botName('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'), 'ClaudeBot');
  assert.equal(botName('meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'), 'meta-externalagent');
});

/* 35% of verified AI crawler traffic once landed in an empty bot name. */
test('botName: never empty, an unknown crawler keeps a name', () => {
  assert.equal(botName('NewThingBot/0.1 (+https://newthing.example)'), 'NewThingBot');
  assert.equal(botName(''), 'unknown');
  assert.equal(botName(undefined), 'unknown');
});

/* 341 requests were once labelled `Mozilla`. */
test('botName: a Mozilla prefix is not a name', () => {
  assert.equal(botName('Mozilla/5.0 (compatible; Seekport; +http://seekport.example)'), 'Seekport');
  assert.equal(botName('Mozilla/5.0 (X11; Linux x86_64) +https://www.operator.example/about'), 'operator.example');
});
