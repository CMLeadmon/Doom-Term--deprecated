import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = fileURLToPath(new URL('./doom-term-hook.sh', import.meta.url));

async function fixture(t) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ body: Buffer.concat(chunks).toString(), headers: req.headers, url: req.url });
      res.writeHead(204).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: String(server.address().port), requests };
}

async function run(t, port, payload, { open = false, env = {} } = {}) {
  const child = spawn('/bin/sh', [script, 'claude'], {
    env: { ...process.env, DOOM_PORT: port, DOOM_TERM_SESSION_ID: 'fixture-pane', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {}); // A bounded reader may refuse excess input.
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => chunks.push(chunk));
  t.after(() => { child.stdin.destroy(); if (child.exitCode === null) child.kill('SIGKILL'); });
  let forcedEof = false;
  const timer = setTimeout(() => { forcedEof = true; child.stdin.end(); }, 3200);
  try {
    child.stdin.write(payload);
    if (!open) child.stdin.end();
    const [code, signal] = await once(child, 'close');
    return { code, signal, forcedEof, output: Buffer.concat(chunks).toString() };
  } finally { clearTimeout(timer); }
}

test('hook deadline includes stdin that never closes', { timeout: 8000 }, async t => {
  const { port, requests } = await fixture(t);
  const result = await run(t, port, '{"event":"Stop"}', { open: true });
  assert.equal(result.forcedEof, false, 'hook waited for EOF beyond its two-second budget');
  assert.equal(result.code, 0);
  assert.equal(result.output, '');
  assert.equal(requests.length, 0, 'an incomplete input stream must not post a partial event');
});

test('hook preserves the complete payload and exact pane header', async t => {
  const { port, requests } = await fixture(t);
  const payload = '{"event":"Stop","cwd":"/fixture/中文"}\n\n';
  const result = await run(t, port, payload, { env: { DOOM_TERM_INCARNATION: 'a'.repeat(32) } });
  assert.equal(result.code, 0);
  assert.equal(result.output, '');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body, payload);
  assert.equal(requests[0].headers['x-doom-term-session'], 'fixture-pane');
  assert.equal(requests[0].headers['x-doom-term-incarnation'], 'a'.repeat(32));
  assert.equal(requests[0].url, '/hook/claude');
});

test('oversized hook payloads are dropped without posting a truncated event', async t => {
  const { port, requests } = await fixture(t);
  const result = await run(t, port, JSON.stringify({ event: 'Stop', padding: 'x'.repeat(70000) }));
  assert.equal(result.code, 0);
  assert.equal(requests.length, 0);
});

test('without a deadline utility the hook returns without reading stdin or posting', async t => {
  const { port, requests } = await fixture(t);
  const path = mkdtempSync(join(tmpdir(), 'doom-hook-path-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  for (const name of ['sh', 'cat', 'head', 'curl']) symlinkSync(`/usr/bin/${name}`, join(path, name));
  const result = await run(t, port, '{"event":"Stop"}', { env: { PATH: path } });
  assert.equal(result.code, 0);
  assert.equal(result.output, '');
  assert.equal(requests.length, 0);
});

test('loopback hooks cannot be redirected through an inherited HTTP proxy', async t => {
  const target = await fixture(t);
  const proxy = await fixture(t);
  const result = await run(t, target.port, '{"event":"Stop"}', {
    env: { http_proxy: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '', no_proxy: '' },
  });
  assert.equal(result.code, 0);
  assert.equal(target.requests.length, 1, 'the hook must reach the loopback daemon directly');
  assert.equal(proxy.requests.length, 0, 'hook payloads must not leave the loopback trust boundary');
});

test('user curl configuration cannot add another hook destination', async t => {
  const target = await fixture(t);
  const extra = await fixture(t);
  const root = mkdtempSync(join(tmpdir(), 'doom-hook-curl-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.curlrc'), `url = "http://127.0.0.1:${extra.port}/unexpected"\n`);
  const result = await run(t, target.port, '{"event":"Stop"}', { env: { CURL_HOME: root } });
  assert.equal(result.code, 0);
  assert.equal(target.requests.length, 1);
  assert.equal(extra.requests.length, 0, 'the hook must ignore user curl defaults');
});
