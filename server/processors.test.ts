import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runPostprocessor, digest, operationId } from './processors.js';

test('rendering keeps readable status/memory blocks and escapes active HTML', async () => {
  const result = await runPostprocessor({ id: randomUUID(), digest: digest({}), config: { protocol: 'none_v1' } },
    '<script>alert(1)</script>\n\nBody[status]ready[/status][memory]<img src=x onerror=alert(1)>[/memory]');
  assert.equal(result.status, 'success');
  assert.ok(result.sanitized_html.includes('当前状态'));
  assert.ok(result.sanitized_html.includes('<details'));
  assert.ok(!result.sanitized_html.includes('<script>'));
  assert.ok(!result.sanitized_html.includes('<img '));
});

test('regex replacement preserves captures and enforces its execution deadline', async () => {
  const processor = { id: randomUUID(), digest: digest({}), config: { protocol: 'regex_json_v1' as const, timeout_ms: 20,
    rules: [{ pattern: '(hello)', flags: 'g', replacement: '$1 world' }] } };
  const result = await runPostprocessor(processor, 'hello hello');
  assert.equal(result.output_text, 'hello world hello world');
  assert.equal(result.match_count, 2);
  const start = Date.now();
  const blocked = await runPostprocessor({ ...processor, config: { ...processor.config, rules: [{ pattern: '(a+)+$', flags: 'g', replacement: '' }] } }, `${'a'.repeat(100)}!`);
  assert.equal(blocked.status, 'timeout');
  assert.ok(Date.now() - start < 1000);
});

test('processor rejects excessive output without failing the surrounding experiment', async () => {
  const result = await runPostprocessor({ id: randomUUID(), digest: digest({}), config: { protocol: 'regex_json_v1', timeout_ms: 250,
    rules: [{ pattern: 'x', flags: 'g', replacement: 'y'.repeat(1000) }] } }, 'x'.repeat(1000));
  assert.equal(result.status, 'limit_exceeded');
  assert.equal(result.output_text, 'x'.repeat(1000));
});

test('idempotency identifiers are operation scoped and payload digests ignore key ordering', () => {
  const key = randomUUID();
  assert.equal(operationId('create', key), operationId('create', key));
  assert.notEqual(operationId('copy', key), operationId('create', key));
  assert.equal(digest({ b: 2, a: { d: 4, c: 3 } }), digest({ a: { c: 3, d: 4 }, b: 2 }));
});
