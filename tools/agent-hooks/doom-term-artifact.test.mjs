import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const script = fileURLToPath(new URL('./doom-term-artifact.sh', import.meta.url));

async function fixture(t) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        body: Buffer.concat(chunks).toString(),
        headers: req.headers,
        url: req.url,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ id: 'art-fixture', version: 1, url: 'http://127.0.0.1/artifact/art-fixture' })
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: String(server.address().port), requests };
}

async function runCli(t, args, stdinContent, { env = {} } = {}) {
  const child = spawn('/bin/sh', [script, ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (c) => stdoutChunks.push(c));
  child.stderr.on('data', (c) => stderrChunks.push(c));

  if (stdinContent !== undefined) {
    child.stdin.write(stdinContent);
    child.stdin.end();
  } else {
    child.stdin.end();
  }

  const [code] = await once(child, 'close');
  return {
    code,
    stdout: Buffer.concat(stdoutChunks).toString(),
    stderr: Buffer.concat(stderrChunks).toString(),
  };
}

test('doom-term-artifact publishes stdin payload with title and type', async (t) => {
  const { port, requests } = await fixture(t);
  const result = await runCli(
    t,
    ['--title', 'Test Artifact', '--type', 'markdown', '--port', port],
    '# Hello Artifact\nThis is a test.',
    { env: { DOOM_TERM_SESSION_ID: 'pane-42' } }
  );

  assert.equal(result.code, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/artifact');
  assert.equal(requests[0].headers['x-doom-term-session'], 'pane-42');

  const parsed = JSON.parse(requests[0].body);
  assert.equal(parsed.title, 'Test Artifact');
  assert.equal(parsed.type, 'markdown');
  assert.equal(parsed.content, '# Hello Artifact\nThis is a test.');
  assert.equal(parsed.open_pane, true);

  assert.match(result.stdout, /art-fixture/);
});

test('doom-term-artifact reads content from file argument', async (t) => {
  const { port, requests } = await fixture(t);
  const tempFile = join(tmpdir(), `artifact-test-${Date.now()}.diff`);
  writeFileSync(tempFile, 'diff --git a/foo b/foo\n+line');
  t.after(() => {
    try { unlinkSync(tempFile); } catch {}
  });

  const result = await runCli(
    t,
    ['--title', 'Code Diff', '--type', 'diff', '--id', 'my-diff', '--no-open', '--port', port, tempFile],
    undefined
  );

  assert.equal(result.code, 0);
  assert.equal(requests.length, 1);

  const parsed = JSON.parse(requests[0].body);
  assert.equal(parsed.title, 'Code Diff');
  assert.equal(parsed.type, 'diff');
  assert.equal(parsed.id, 'my-diff');
  assert.equal(parsed.open_pane, false);
  assert.equal(parsed.content, 'diff --git a/foo b/foo\n+line');
});
