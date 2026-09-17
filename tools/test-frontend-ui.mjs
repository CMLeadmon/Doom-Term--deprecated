#!/usr/bin/env node
/** Real browser/PTY smoke tests. Never connect to the user's daemon or tmux. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { build, preview } from 'vite';
import { chromium, expect } from '@playwright/test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifacts = mkdtempSync(join(tmpdir(), 'doom-ui-'));
const testEnv = {
  ...process.env, DOOM_HOST: '127.0.0.1', DOOM_PORT: '0', DOOM_AUTH_TOKEN: '',
  TMUX_TMPDIR: artifacts, XDG_RUNTIME_DIR: artifacts,
  // An interactive POSIX shell with no user's startup commands. The shell
  // integration itself is covered by the Rust and event-routing suites.
  SHELL: '/bin/sh', RUST_LOG: 'info',
};
delete testEnv.ENV;
delete testEnv.BASH_ENV;
delete testEnv.DOOM_TERM_NO_TMUX;
/**
 * Where bash actually is, or null.
 *
 * The bracketed-paste contract needs a shell that implements it, and hard-coding
 * /bin/bash failed on a CI host whose daemon shell is dash and which has no bash
 * at that path. An absent shell is an environment block, never a silent pass.
 */
const bashPath = (() => {
  const probe = spawnSync('sh', ['-lc', 'command -v bash || true'], { encoding: 'utf8' });
  const found = (probe.stdout ?? '').trim().split('\n')[0];
  return found && existsSync(found) ? found : null;
})();
let browser;
let page;
let vite;
let daemon;
let daemonLog = '';

async function startDaemon(requestedPort = 0) {
  daemonLog = '';
  const target = resolve(root, process.env.CARGO_TARGET_DIR || 'target');
  daemon = spawn(join(target, 'debug', 'doom-term-server'), [], {
    cwd: root, env: { ...testEnv, DOOM_PORT: String(requestedPort) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`Daemon did not start: ${daemonLog}`)), 15000);
    const receive = chunk => {
      daemonLog = (daemonLog + chunk.toString()).slice(-32768);
      const match = daemonLog.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
    };
    daemon.stdout.on('data', receive);
    daemon.stderr.on('data', receive);
    daemon.once('error', error => { clearTimeout(timer); reject(error); });
    daemon.once('exit', code => { clearTimeout(timer); reject(new Error(`Daemon exited ${code}: ${daemonLog}`)); });
  });
}

async function stopDaemon() {
  const running = daemon;
  daemon = undefined;
  if (!running || running.exitCode !== null) return;
  const exited = once(running, 'exit');
  running.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Daemon did not stop')), 5000)),
  ]);
}

/** Type a line and submit it, retrying while the attachment is still coming back.
 * Never queues on the app's behalf: each attempt is a fresh, complete line. */
async function typeUntilEchoed(page, text, expected, attempts = 10) {
  const terminal = page.getByTestId('raw-terminal');
  for (let attempt = 0; attempt < attempts; attempt++) {
    await terminal.click();
    await page.keyboard.press('End');
    // Discard anything a refused attempt left on the line before retyping.
    if (attempt > 0) { await page.keyboard.press('Control+c'); await page.waitForTimeout(150); }
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    try {
      await expect(terminal).toContainText(expected, { timeout: 3000 });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
    }
  }
}

async function palette(page, search) {
  await page.keyboard.press('Control+Shift+p');
  await page.getByRole('combobox').fill(search);
  await page.keyboard.press('Enter');
}

async function command(page, text, expectedLine) {
  const terminal = page.getByTestId('raw-terminal').filter({ visible: true }).last();
  await terminal.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  // A terminal echo of the input is NOT proof the process ran the command.
  await expect.poll(async () => (await terminal.innerText()).split('\n').map(s => s.trim()).includes(expectedLine)).toBe(true);
}

async function terminalGrid(page, marker) {
  const terminal = page.getByTestId('raw-terminal').filter({ visible: true }).last();
  await terminal.click();
  await page.keyboard.type(`printf '${marker}='; stty size`);
  await page.keyboard.press('Enter');
  const pattern = new RegExp(`^${marker}=(\\d+) (\\d+)$`);
  const read = async () => (await terminal.innerText()).split('\n').map(line => line.trim().match(pattern)).find(Boolean);
  await expect.poll(read).toBeTruthy();
  const match = await read();
  return { rows: Number(match[1]), cols: Number(match[2]) };
}

async function renderedRowsBetween(terminal, begin, end) {
  return terminal.evaluate((element, markers) => {
    const rows = [...element.querySelectorAll('[data-terminal-line]')];
    const content = row => row.children[1];
    const exact = (row, marker) => content(row)?.textContent?.trimEnd() === marker;
    const start = rows.findIndex(row => exact(row, markers.begin));
    const finish = rows.findIndex((row, index) => index > start && exact(row, markers.end));
    if (start < 0 || finish < 0) throw new Error(`Missing rendered markers ${markers.begin}/${markers.end}`);
    return rows.slice(start + 1, finish).map(row => ({
      text: content(row)?.textContent ?? '',
      spans: [...content(row).children].map(span => ({
        text: span.textContent ?? '',
        style: span.getAttribute('style') ?? '',
      })),
    }));
  }, { begin, end });
}

/**
 * Rows between two markers, searching only after an anchor.
 *
 * Both the control and the warm run emit the same marker names, so the plain
 * search would always find the control's copy.
 */
/** Every row currently in the document, keyed by its index in the full buffer. */
async function renderedRowBatch(terminal) {
  return terminal.evaluate((element) =>
    [...element.querySelectorAll('[data-terminal-line]')].map((row) => ({
      index: Number(row.dataset.terminalLine),
      text: row.children[1]?.textContent ?? '',
      spans: [...(row.children[1]?.children ?? [])].map((span) => ({
        text: span.textContent ?? '',
        style: span.getAttribute('style') ?? '',
      })),
    })));
}

/** Move the rendered window one screen forward. False once at the bottom. */
async function scrollWindowForward(terminal) {
  return terminal.evaluate((element) => {
    const scroll = element.firstElementChild;
    if (!scroll) return false;
    const limit = scroll.scrollHeight - scroll.clientHeight;
    if (scroll.scrollTop >= limit) return false;
    scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    scroll.scrollTop = Math.min(limit, scroll.scrollTop + scroll.clientHeight);
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  });
}

/**
 * Rows between two markers, searching only after an anchor.
 *
 * Both the control and the warm run emit the same marker names, so the plain
 * search would always find the control's copy.
 *
 * Stitched across window positions rather than read from one query. Only the
 * visible rows plus overscan are in the document, and this range is hundreds of
 * lines long — no single query can hold it. `data-terminal-line` indexes the
 * full buffer, so rows gathered at different scroll positions reassemble into
 * one contiguous region without ambiguity.
 */
async function renderedRowsBetweenAfter(terminal, anchor, begin, end) {
  try {
    let anchorAt = await renderedIndexOf(terminal, anchor);
    for (let step = 0; anchorAt < 0 && step < 400; step++) {
      if (!(await scrollWindowBack(terminal))) break;
      anchorAt = await renderedIndexOf(terminal, anchor);
    }
    if (anchorAt < 0) throw new Error(`Missing anchor ${anchor}`);

    const seen = new Map();
    let start = -1;
    let finish = -1;
    for (let step = 0; step < 400; step++) {
      for (const row of await renderedRowBatch(terminal)) {
        seen.set(row.index, row);
        const text = row.text.trimEnd();
        if (row.index > anchorAt && start < 0 && text === begin) start = row.index;
        if (start >= 0 && row.index > start && finish < 0 && text === end) finish = row.index;
      }
      if (finish >= 0) break;
      if (!(await scrollWindowForward(terminal))) break;
    }
    if (start < 0 || finish < 0) {
      throw new Error(`Missing rendered markers ${begin}/${end}`);
    }
    const out = [];
    for (let index = start; index < finish; index++) {
      const row = seen.get(index);
      if (row) out.push({ text: row.text, spans: row.spans });
    }
    return out;
  } finally {
    await returnToTail(terminal);
  }
}

/**
 * The buffer index of a rendered line, or -1 when it is not in the window.
 *
 * `data-terminal-line` indexes the FULL line array, not the rendered slice, so
 * two lines observed at different moments remain comparable. That is what keeps
 * ordering checkable now that only the visible rows plus overscan are in the
 * DOM.
 */
async function renderedIndexOf(terminal, wanted) {
  return terminal.evaluate((element, text) => {
    const row = [...element.querySelectorAll('[data-terminal-line]')]
      .find(candidate => candidate.children[1]?.textContent?.trimEnd() === text);
    return row ? Number(row.dataset.terminalLine) : -1;
  }, wanted);
}

/** Move the rendered window one screen further back. False once at the top. */
async function scrollWindowBack(terminal) {
  return terminal.evaluate((element) => {
    const scroll = element.firstElementChild;
    if (!scroll || scroll.scrollTop <= 0) return false;
    // A wheel first. The view treats a scroll event with no gesture behind it
    // as incidental — a resize clamping scrollTop — and returns to the tail,
    // so setting scrollTop alone would search the same screen forever.
    scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    scroll.scrollTop = Math.max(0, scroll.scrollTop - scroll.clientHeight);
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  });
}

/**
 * Is this line anywhere in the buffer, leaving the reader where it was?
 *
 * Distinct from `hasRenderedLineAfter`, which hands the tail back. The warm
 * recovery case asserts that a DETACHED anchor survived a reconnect, so a
 * search that moved the reader would destroy the very evidence under test.
 */
async function lineExistsAnywhere(terminal, wanted) {
  const at = await terminal.evaluate((element) => element.firstElementChild?.scrollTop ?? 0);
  try {
    if ((await renderedIndexOf(terminal, wanted)) >= 0) return true;
    for (let step = 0; step < 400; step++) {
      if (!(await scrollWindowForward(terminal))) break;
      if ((await renderedIndexOf(terminal, wanted)) >= 0) return true;
    }
    return false;
  } finally {
    await terminal.evaluate((element, top) => {
      const scroll = element.firstElementChild;
      if (!scroll) return;
      scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      scroll.scrollTop = top;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, at);
  }
}

/**
 * Is this line anywhere in the buffer at all, from the top?
 *
 * `lineExistsAnywhere` walks forward from wherever the reader is; this sweeps
 * the whole buffer, which is what a "the shell's scrollback came back" check
 * needs when the marker was printed a thousand lines ago and only a window of
 * rows is in the document.
 */
async function bufferContainsLine(terminal, wanted) {
  const at = await terminal.evaluate((element) => element.firstElementChild?.scrollTop ?? 0);
  try {
    for (let step = 0; step < 600; step++) {
      if (!(await scrollWindowBack(terminal))) break;
    }
    if ((await renderedIndexOf(terminal, wanted)) >= 0) return true;
    for (let step = 0; step < 600; step++) {
      if (!(await scrollWindowForward(terminal))) break;
      if ((await renderedIndexOf(terminal, wanted)) >= 0) return true;
    }
    return false;
  } finally {
    await terminal.evaluate((element, top) => {
      const scroll = element.firstElementChild;
      if (!scroll) return;
      scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      scroll.scrollTop = top;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, at);
  }
}

/** Put the reader back on the newest output, whatever the search did. */
async function returnToTail(terminal) {
  await terminal.evaluate((element) => {
    const scroll = element.firstElementChild;
    if (!scroll) return;
    scroll.scrollTop = scroll.scrollHeight;
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

/**
 * Did `wanted` arrive after `begin`?
 *
 * This used to read both markers out of one DOM query, which worked while the
 * whole buffer was rendered. It is not: a line five hundred rows back is not in
 * the document until the window is moved over it. Scroll back to find `begin`,
 * compare buffer indices, and always hand the tail back — `expect.poll` calls
 * this repeatedly, and a search that left the reader detached would hide the
 * very output the next assertion waits for.
 */
async function hasRenderedLineAfter(terminal, begin, wanted) {
  try {
    const wantedAt = await renderedIndexOf(terminal, wanted);
    if (wantedAt < 0) return false;
    let beginAt = await renderedIndexOf(terminal, begin);
    for (let step = 0; beginAt < 0 && step < 400; step++) {
      if (!(await scrollWindowBack(terminal))) break;
      beginAt = await renderedIndexOf(terminal, begin);
    }
    return beginAt >= 0 && beginAt < wantedAt;
  } finally {
    await returnToTail(terminal);
  }
}

/**
 * Scroll until `marker` is at the top of the viewport.
 *
 * Only the visible rows plus overscan are in the document, so a marker further
 * back than that is not there to scroll to yet — the window has to be walked
 * over it first. This used to be a single query and threw `Missing scroll
 * anchor` the moment the buffer outgrew one screen.
 */
async function anchorScrollAt(terminal, marker) {
  let at = await renderedIndexOf(terminal, marker);
  for (let step = 0; at < 0 && step < 400; step++) {
    if (!(await scrollWindowBack(terminal))) break;
    at = await renderedIndexOf(terminal, marker);
  }
  if (at < 0) throw new Error(`Missing scroll anchor ${marker}`);
  await terminal.evaluate((element, wanted) => {
    const row = [...element.querySelectorAll('[data-terminal-line]')]
      .find(candidate => candidate.children[1]?.textContent?.trimEnd() === wanted);
    if (!row) throw new Error(`Missing scroll anchor ${wanted}`);
    const scroll = row.parentElement;
    scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    row.scrollIntoView({ block: 'start' });
  }, marker);
}

async function scrollAnchorIsVisible(terminal, marker) {
  return terminal.evaluate((element, wanted) => {
    const row = [...element.querySelectorAll('[data-terminal-line]')]
      .find(candidate => candidate.children[1]?.textContent?.trimEnd() === wanted);
    if (!row) return false;
    const viewport = row.parentElement.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    return bounds.top >= viewport.top - 1 && bounds.top < viewport.bottom;
  }, marker);
}

function paneProperty(sessionId, property) {
  const result = spawnSync('tmux', [
    '-N', '-L', 'doom-term', 'display-message', '-p', '-t', `=doom-${sessionId}:`, `#{${property}}`,
  ], { env: testEnv, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, `the isolated pane must be inspectable: ${result.stderr}`);
  return result.stdout.trim();
}

function foregroundCommand(sessionId) {
  return paneProperty(sessionId, 'pane_current_command');
}

async function main() {
  const probeFailures = [];
  console.log(`[UI Test] Real Chromium + isolated daemon; screenshots: ${artifacts}`);
  browser = await chromium.launch({ executablePath: process.env.DOOM_TERM_BROWSER_EXECUTABLE || undefined });
  // 1420 is the daemon's trusted development origin. Refuse a busy port; do
  // not silently test somebody else's app or broaden the production allowlist.
  await build({ root });
  const daemonBuild = spawnSync('cargo', ['build', '--locked', '-p', 'doom-term-server'], {
    cwd: root, stdio: 'inherit', timeout: 300000,
  });
  assert.equal(daemonBuild.status, 0, 'test daemon must compile');
  const port = await startDaemon();
  // Exercise the production bundle with the desktop's actual CSP. Only the
  // daemon port changes in the test policy to reach this run's private daemon.
  const policy = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
  assert.ok(policy && typeof policy === 'object', 'desktop CSP must be configured');
  const csp = Object.entries(policy).map(([directive, value]) => `${directive} ${value}`).join('; ')
    .replace('ws://127.0.0.1:1421', `ws://127.0.0.1:${port}`);
  vite = await preview({ root, preview: { host: '127.0.0.1', port: 1420, strictPort: true, headers: { 'Content-Security-Policy': csp } } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
  await context.addInitScript(({ port }) => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        const target = new URL(url);
        if (target.hostname === '127.0.0.1' && target.port === '1421') target.port = String(port);
        super(target.toString(), protocols);
        (window.__doomTestSockets ??= []).push(this);
      }
    };
    window.__doomTestDisconnect = () => {
      const socket = [...(window.__doomTestSockets ?? [])].reverse().find(candidate => candidate.readyState === WebSocket.OPEN);
      if (!socket) throw new Error('No open Doom Term socket');
      socket.close(4000, 'fixture disconnect');
    };
  }, { port });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:1420');
  await expect(page).toHaveTitle(/Doom/i);
  await expect(page.getByRole('dialog', { name: /OPEN WORKSPACE/ })).toBeVisible();
  await page.getByRole('combobox').fill(artifacts);
  await page.getByRole('combobox').press('Enter');
  await expect(page.getByTestId('raw-terminal')).toContainText(/[$#]/);
  await command(page, "printf 'SHELL_OK\\n'", 'SHELL_OK');
  await command(page, "printf '\\344\\270\\255\\346\\226\\207 \\360\\237\\232\\200\\n'", '中文 🚀');
  console.log('[UI Test] PASS: startup, real shell I/O, Unicode');
  const terminal = page.getByTestId('raw-terminal');

  // Warm transport loss retains the same parser and root while output crosses
  // the boundary. Compare the exact rendered row spans with an uninterrupted
  // control. More than the old 500-event replay cap is intentionally emitted,
  // including Unicode, cursor rewriting and an SGR split before socket loss.
  const warmPane = await page.getByTestId('pane-leaf').getAttribute('data-pane');
  assert.ok(warmPane, 'warm recovery must target a real pane');
  const warmPid = paneProperty(warmPane, 'pane_pid');
  const recoveryFixture = join(artifacts, 'recovery-cells.mjs');
  writeFileSync(recoveryFixture, `import { existsSync, writeFileSync } from 'node:fs';
const [begin, end, prefixFile, releaseFile, splitFile] = process.argv.slice(2);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
process.stdout.write(begin + '\\n');
let i = 0;
for (; i < 500; i++) { process.stdout.write('CELL_' + String(i).padStart(3, '0') + '\\n'); await pause(5); }
writeFileSync(prefixFile, '');
while (!existsSync(releaseFile)) await pause(10);
process.stdout.write('BOUNDARY_READY\\n');
process.stdout.write('\\x1b[1;3');
writeFileSync(splitFile, '');
await pause(800);
process.stdout.write('1mSTYLE_中文\\x1b[0m\\n');
process.stdout.write('CURSOR_ABCD\\rCURSOR_X\\n');
for (; i < 510; i++) { process.stdout.write('CELL_' + String(i).padStart(3, '0') + '\\n'); await pause(5); }
process.stdout.write(end + '\\n');
`);
  const recoveryProgram = (begin, end, prefixFile, releaseFile, splitFile) =>
    `node ./recovery-cells.mjs ${begin} ${end} ${prefixFile} ${releaseFile} ${splitFile}`;
  const controlPrefix = join(artifacts, 'control-prefix-ready');
  const controlRelease = join(artifacts, 'control-release');
  const controlSplit = join(artifacts, 'control-split-ready');
  await terminal.click();
  await page.keyboard.type(recoveryProgram('CONTROL_BEGIN', 'CONTROL_DONE',
    'control-prefix-ready', 'control-release', 'control-split-ready'));
  await page.keyboard.press('Enter');
  await expect.poll(() => existsSync(controlPrefix)).toBe(true);
  await expect.poll(() => hasRenderedLineAfter(terminal, 'CONTROL_BEGIN', 'CELL_499'),
    { timeout: 45000 }).toBe(true);
  writeFileSync(controlRelease, '');
  await expect.poll(() => existsSync(controlSplit)).toBe(true);
  await expect.poll(async () => (await terminal.innerText()).split('\n').some(line => line.trim() === 'CONTROL_DONE'),
    { timeout: 45000 }).toBe(true);
  // Compare the post-boundary region, not the whole 500-line burst.
  //
  // tmux redraws a non-alternate-screen client in place: a repaint is
  // ESC[?25l ESC[H followed by one ESC[K row per viewport line. It never
  // scrolls, so any line still in the viewport when the next repaint lands is
  // overwritten and never reaches scrollback. Measured directly on the wire:
  // CELL_457..CELL_500 arrive a second time inside one 1.2 KB repaint record,
  // and two or three cells around CELL_458 are delivered but never rendered.
  // That happens in the uninterrupted control run too - it is tmux's redraw
  // semantics, which is why tmux keeps its own copy-mode history, and not
  // something recovery can preserve.
  //
  // So an exact full-transcript comparison measures tmux repaint timing rather
  // than recovery. This region carries what gates 1 and 2 actually require -
  // the split SGR escape, Unicode, the CR cursor overwrite and the cells after
  // the boundary - and is short enough to sit inside the viewport, where no
  // repaint can disturb it. Root identity, no duplication, and the preserved
  // scroll anchor are still asserted separately below.
  const controlRows = await renderedRowsBetweenAfter(terminal, 'CONTROL_BEGIN', 'BOUNDARY_READY', 'CONTROL_DONE');

  const warmPrefix = join(artifacts, 'warm-prefix-ready');
  const warmRelease = join(artifacts, 'warm-release');
  const warmSplit = join(artifacts, 'warm-split-ready');
  await terminal.click();
  await page.keyboard.type(recoveryProgram('WARM_BEGIN', 'WARM_DONE',
    'warm-prefix-ready', 'warm-release', 'warm-split-ready'));
  await page.keyboard.press('Enter');
  await expect.poll(() => existsSync(warmPrefix)).toBe(true);
  await expect.poll(() => hasRenderedLineAfter(terminal, 'WARM_BEGIN', 'CELL_499'),
    { timeout: 45000 }).toBe(true);
  await anchorScrollAt(terminal, 'WARM_BEGIN');
  writeFileSync(warmRelease, '');
  await expect.poll(() => existsSync(warmSplit)).toBe(true);
  await page.evaluate(() => window.__doomTestDisconnect());
  // Search without moving the reader: the anchor assertion below is the point
  // of this case, and only the tail is rendered now, so a search that scrolled
  // to find WARM_DONE would manufacture the evidence it is about to check.
  await expect.poll(() => lineExistsAnywhere(terminal, 'WARM_DONE'),
    { timeout: 45000 }).toBe(true);
  assert.equal(await scrollAnchorIsVisible(terminal, 'WARM_BEGIN'), true,
    'warm recovery must preserve the reader\'s detached scroll anchor');
  assert.equal(paneProperty(warmPane, 'pane_pid'), warmPid, 'socket recovery must preserve the exact root process');
  const warmRows = await renderedRowsBetweenAfter(terminal, 'WARM_BEGIN', 'BOUNDARY_READY', 'WARM_DONE');
  assert.equal(warmRows.filter(row => row.text.trim() === 'WARM_DONE').length, 0,
    'WARM_DONE terminates the region and must not appear inside it');
  assert.deepEqual(warmRows, controlRows,
    'warm recovery cells and SGR spans must exactly match the uninterrupted control');

  await terminal.click();
  await page.keyboard.press('End');
  await page.keyboard.type("printf 'RESIZE_BEFORE\\n'; sleep 1; printf 'RESIZE_AFTER\\n'");
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await terminal.innerText()).split('\n').some(line => line.trim() === 'RESIZE_BEFORE')).toBe(true);
  await page.evaluate(() => window.__doomTestDisconnect());
  await page.setViewportSize({ width: 1100, height: 760 });
  await expect.poll(async () => (await terminal.innerText()).split('\n').some(line => line.trim() === 'RESIZE_AFTER'),
    { timeout: 15000 }).toBe(true);
  assert.equal(paneProperty(warmPane, 'pane_pid'), warmPid, 'deferred resize recovery must preserve the exact root process');
  await page.screenshot({ path: join(artifacts, 'warm-recovery.png') });
  console.log('[UI Test] PASS: warm socket recovery crosses >500 events with exact control cells, split SGR/Unicode, scroll anchor, deferred resize, and root identity');

  if (!bashPath) {
    console.log('');
    console.log('  ENVIRONMENT BLOCK — NOT A PASS');
    console.log('  Clipboard paste, job control and shell exit were not exercised:');
    console.log('  this machine has no bash, and the bracketed-paste contract needs a');
    console.log('  shell that implements it. Every other probe still ran.');
    console.log('');
  } else {
    // Use an isolated interactive Bash with bracketed paste explicitly enabled,
    // even on CI hosts whose /bin/sh is dash. No user startup files are sourced.
    // Input is deliberately never queued or replayed, so a keystroke typed during
    // a reconnect is dropped by contract. Retype until it lands: that is what a
    // user does, and it proves the terminal actually recovers rather than going
    // quietly read-only.
    await typeUntilEchoed(page, `${bashPath} --noprofile --norc`, /bash-[\d.]+[$#]/);
    await command(page, "bind 'set enable-bracketed-paste off'; printf 'BRACKET_OFF\\n'", 'BRACKET_OFF');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    for (const newline of ['\r', '\n']) {
      const blockedPaste = `printf 'BLOCKED_PASTE_ONE\\n'${newline}printf 'BLOCKED_PASTE_TWO\\n'`;
      await page.evaluate(text => navigator.clipboard.writeText(text), blockedPaste);
      await page.keyboard.press('Control+Shift+v');
      try {
        await expect(page.getByRole('status')).toContainText(/Multiline paste blocked/);
        await expect(page.getByTestId('raw-terminal')).not.toContainText("printf 'BLOCKED_PASTE_ONE");
        await page.screenshot({ path: join(artifacts, 'paste-blocked.png') });
      } catch (error) {
        // Keep testing independent MVP flows, but fail the overall run at the end.
        probeFailures.push(`unsupported-child paste (${JSON.stringify(newline)}): ${error.message}`);
        await page.screenshot({ path: join(artifacts, 'paste-unsafe.png') });
      }
    }
    await page.keyboard.press('Control+c');
    await command(page, "bind 'set enable-bracketed-paste on'; printf 'BRACKET_ON\\n'", 'BRACKET_ON');
    const paste = "printf 'PASTE_ONE\\n'\rprintf 'PASTE_TWO\\n'";
    await page.evaluate(text => navigator.clipboard.writeText(text), paste);
    await page.keyboard.press('Control+Shift+v');
    await expect(terminal).toContainText("printf 'PASTE_TWO");
    await expect(page.getByRole('status')).toHaveCount(0);
    assert.ok(!(await terminal.innerText()).split('\n').map(line => line.trim()).includes('PASTE_ONE'), 'pasting must not execute the first line before Enter');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await terminal.innerText()).split('\n').map(line => line.trim()).includes('PASTE_TWO')).toBe(true);
  
    await command(page, "printf 'JOB_STARTED\\n'; sleep 30", 'JOB_STARTED');
    await page.keyboard.press('Control+z');
    await expect(terminal).toContainText(/Stopped[^\n]*sleep 30/);
    await page.keyboard.type('fg');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await terminal.innerText()).split('\n').map(line => line.trim()).includes('sleep 30')).toBe(true);
    await page.keyboard.press('Control+c');
    await command(page, "printf 'AFTER_JOB_CONTROL\\n'", 'AFTER_JOB_CONTROL');
    await page.keyboard.press('Control+d');
    await command(page, "printf 'AFTER_EOF\\n'", 'AFTER_EOF');
    console.log('[UI Test] PASS: real clipboard CR paste waits for Enter; Ctrl+Z/fg/Ctrl+C job control and Ctrl+D shell exit');
  }

  const interruptPane = await page.getByTestId('pane-leaf').getAttribute('data-pane');
  assert.ok(interruptPane, 'the interrupt probe must target a real pane');
  // Echo alone is not process readiness: Ctrl+C sent while Readline is still
  // editing can cancel the input rather than interrupting a running command.
  await page.keyboard.type('sleep 30');
  await page.keyboard.press('Enter');
  await expect.poll(() => foregroundCommand(interruptPane)).toBe('sleep');
  await page.keyboard.press('Control+c');
  await expect.poll(() => foregroundCommand(interruptPane)).toMatch(/^(sh|bash|dash)$/);
  await command(page, "printf 'AFTER_INTERRUPT\\n'", 'AFTER_INTERRUPT');
  console.log('[UI Test] PASS: Ctrl+C interrupts an observed foreground sleep process');

  const quickUrl = 'https://example.test/doom-probe';
  await command(page, `printf '${quickUrl}\\n'`, quickUrl);
  await page.keyboard.press('Control+Shift+e');
  const quickTarget = page.getByRole('button').filter({ has: page.getByText(quickUrl, { exact: true }) });
  await expect(quickTarget).toHaveCount(1);
  await quickTarget.click();
  await page.keyboard.press('Enter');
  await expect(quickTarget).toHaveCount(0);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), quickUrl, 'quick-select copies the selected target');
  await terminal.click();
  await page.keyboard.type("printf 'INSERTED=%s\\n' ");
  await page.keyboard.press('Control+Shift+e');
  await quickTarget.click();
  await page.keyboard.press('Shift+Enter');
  await expect(quickTarget).toHaveCount(0);
  assert.ok(!(await terminal.innerText()).split('\n').map(line => line.trim()).includes(`INSERTED=${quickUrl}`), 'quick-select insertion must not submit the shell command');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await terminal.innerText()).split('\n').map(line => line.trim()).includes(`INSERTED=${quickUrl}`)).toBe(true);
  console.log('[UI Test] PASS: quick-select copies to the real clipboard and inserts without submitting');

  // Vim/vi with no user configuration, persistent history, or swap files.
  // Saving a disposable file proves editor input reached a real TUI process.
  await page.keyboard.type('vi -Nu NONE -i NONE -n editor-probe.txt');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText(/editor-probe\.txt.*New/);
  await page.keyboard.type('iTUI_EDITOR_OK');
  await expect(terminal).toContainText('TUI_EDITOR_OK');
  await page.keyboard.press('Escape');
  await expect(terminal).toContainText('TUI_EDITOR_OK');
  await page.screenshot({ path: join(artifacts, 'editor.png') });
  const editorGeometry = await terminal.evaluate(el => {
    const scroll = el.querySelector('[data-terminal-line]')?.parentElement;
    const row = [...el.querySelectorAll('[data-terminal-line]')].find(row => row.textContent.includes('TUI_EDITOR_OK'));
    const viewport = scroll.getBoundingClientRect();
    const textRow = row.getBoundingClientRect();
    return { viewportTop: viewport.top, viewportBottom: viewport.bottom, rowTop: textRow.top, rowBottom: textRow.bottom,
      lineHeight: getComputedStyle(scroll).lineHeight, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight };
  });
  assert.ok(editorGeometry.rowTop >= editorGeometry.viewportTop && editorGeometry.rowBottom <= editorGeometry.viewportBottom,
    `the editor's first row must be visible, not merely present in the DOM: ${JSON.stringify(editorGeometry)}`);
  await page.keyboard.type(':wq');
  await page.keyboard.press('Enter');
  // The shell's scrollback must come back when the alternate screen goes away.
  // SHELL_OK was printed a thousand lines ago, so it is not in the rendered
  // window — searched across the buffer rather than read out of innerText.
  await expect.poll(() => bufferContainsLine(terminal, 'SHELL_OK'),
    { timeout: 45000 }).toBe(true);
  await command(page, 'cat editor-probe.txt', 'TUI_EDITOR_OK');
  assert.equal(readFileSync(join(artifacts, 'editor-probe.txt'), 'utf8'), 'TUI_EDITOR_OK\n');
  console.log('[UI Test] PASS: real alternate-screen editor input, file save, and shell screen restoration');

  await palette(page, 'Permission Review');
  await expect(page.getByRole('radio', { name: /Automatic approval unavailable/ })).toBeDisabled();
  await page.screenshot({ path: join(artifacts, 'settings.png') });
  await page.keyboard.press('Escape');
  await palette(page, 'Split Right');
  await expect(page.getByTestId('raw-terminal').filter({ visible: true })).toHaveCount(2);
  await expect(page.getByTestId('raw-terminal').last()).toContainText(/[$#]/);
  await command(page, "printf 'SECOND_PANE\\n'", 'SECOND_PANE');
  const beforeGrid = await terminalGrid(page, 'GRID_BEFORE');
  const divider = page.getByRole('separator', { name: '' });
  const dividerBox = await divider.boundingBox();
  assert.ok(dividerBox, 'split divider must be visible');
  assert.equal(await page.evaluate(({ x, y, width, height }) => document.elementFromPoint(x + width / 2, y + height / 2)?.getAttribute('role'), dividerBox), 'separator', 'the divider must have a pointer hit target');
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(420, dividerBox.y + dividerBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await page.getByTestId('pane-leaf').first().boundingBox()).width).toBeLessThan(450);
  const afterGrid = await terminalGrid(page, 'GRID_AFTER');
  assert.ok(afterGrid.cols > beforeGrid.cols, 'dragging the divider must resize the actual child PTY');
  assert.equal(afterGrid.rows, beforeGrid.rows, 'horizontal resize must preserve the PTY row count');
  const leaves = await page.getByTestId('pane-leaf').count();
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByTestId('pane-leaf')).toHaveCount(leaves);
  await expect(page.getByTestId('raw-terminal').filter({ visible: true })).toHaveCount(1);
  await page.screenshot({ path: join(artifacts, 'zoom.png') });
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByTestId('raw-terminal').filter({ visible: true })).toHaveCount(2);
  await page.keyboard.press('Control+Shift+t');
  await expect(page.getByTestId('raw-terminal').filter({ visible: true })).toHaveCount(2);
  await expect(page.getByTestId('raw-terminal').filter({ visible: true }).last()).toContainText(/[$#]/);
  await command(page, 'pwd', artifacts);
  await page.screenshot({ path: join(artifacts, 'split.png') });
  console.log('[UI Test] PASS: palette, settings, live split, mounted siblings through zoom and new-session selection');

  for (const width of [1280, 960, 800]) {
    await page.setViewportSize({ width, height: 600 });
    if (width === 800) {
      const plate = page.locator('canvas').locator('..');
      await plate.focus();
      await expect(plate).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => plate.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    }
    await page.screenshot({ path: join(artifacts, `terminal-${width}.png`) });
  }

  await page.setViewportSize({ width: 1280, height: 840 });
  const secondWorkspace = join(artifacts, 'second-workspace');
  mkdirSync(secondWorkspace);
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('combobox').fill(secondWorkspace);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('raw-terminal').filter({ visible: true })).toHaveCount(1);
  await expect(page.getByTestId('raw-terminal').filter({ visible: true })).toContainText(/[$#]/);
  await page.keyboard.press('Control+Shift+t');
  await expect(page.getByTestId('raw-terminal').filter({ visible: true })).toContainText(/[$#]/);
  await command(page, 'pwd', secondWorkspace);
  const remotePane = await page.getByTestId('pane-leaf').filter({ visible: true }).getAttribute('data-pane');
  assert.ok(remotePane, 'background hook must name a real pane');
  const remoteIncarnation = paneProperty(remotePane, '@doom-incarnation');
  assert.match(remoteIncarnation, /^[0-9a-f]{32}$/, 'background hook must name the exact owned incarnation');
  await page.keyboard.press('Control+1');
  await expect(page.locator(`[data-pane="${remotePane}"]`)).not.toBeVisible();
  const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Doom-Term-Session': remotePane,
      'X-Doom-Term-Incarnation': remoteIncarnation,
    },
    body: JSON.stringify({ event: 'PermissionRequest', cwd: secondWorkspace }),
  });
  assert.equal(response.status, 204);
  // The palette must not treat appearing under a stationary mouse as input.
  await page.mouse.move(400, 375);
  await page.keyboard.press('Control+k');
  const remoteAsk = page.getByRole('option').filter({ hasText: 'second-workspace' }).filter({ hasText: 'ASKS' });
  await expect(remoteAsk).toHaveCount(1);
  await expect(remoteAsk).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: join(artifacts, 'background-attention.png') });
  await remoteAsk.click();
  await expect(page.locator(`[data-pane="${remotePane}"]`)).toBeVisible();
  await command(page, "printf 'BACKGROUND_RETURN\\n'", 'BACKGROUND_RETURN');
  console.log('[UI Test] PASS: multi-workspace directory selection and background hook activation');

  // Kill the daemon—not tmux—while a real editor owns the pane. Input typed
  // while disconnected must be refused, the new daemon must rebuild the exact
  // pane with separated archive provenance, and the editor must remain usable.
  const coldTerminal = page.getByTestId('raw-terminal').filter({ visible: true }).last();
  const coldPid = paneProperty(remotePane, 'pane_pid');
  await coldTerminal.click();
  await page.keyboard.type('vi -Nu NONE -i NONE -n cold-recovery.txt');
  await page.keyboard.press('Enter');
  await expect(coldTerminal).toContainText(/cold-recovery\.txt.*New/);
  await page.keyboard.type('iCOLD_EDITOR_BEFORE');
  await expect(coldTerminal).toContainText('COLD_EDITOR_BEFORE');
  await stopDaemon();
  await page.waitForTimeout(300);
  await page.keyboard.type('_OFFLINE_MUST_NOT_APPEAR');
  await startDaemon(port);
  await expect(coldTerminal).toContainText('COLD_EDITOR_BEFORE', { timeout: 20000 });
  await expect(page.getByRole('region', { name: 'Recovered history' })).toBeVisible({ timeout: 20000 });
  assert.equal(paneProperty(remotePane, 'pane_pid'), coldPid, 'daemon restart must attach the original exact tmux pane');
  await coldTerminal.click();
  await page.keyboard.type('_AFTER');
  await page.keyboard.press('Escape');
  await page.keyboard.type(':wq');
  await page.keyboard.press('Enter');
  await expect(coldTerminal).toContainText('BACKGROUND_RETURN');
  assert.equal(readFileSync(join(secondWorkspace, 'cold-recovery.txt'), 'utf8'), 'COLD_EDITOR_BEFORE_AFTER\n',
    'offline input must not replay and the recovered editor must save through the original process');
  await page.screenshot({ path: join(artifacts, 'cold-recovery-editor.png') });
  console.log('[UI Test] PASS: cold daemon restart preserves exact editor/root, separates history, refuses offline input, and saves the file');
  // Exercise the child's cursor mode and a multi-frame erase/redraw through
  // the real tmux -> daemon -> headless -> DOM path. Hold the second frame on
  // read, so this proves the intermediate state rather than winning a timer race.
  await page.keyboard.press('Control+Shift+t');
  const visualTerminal = page.getByTestId('raw-terminal').filter({ visible: true }).last();
  await expect(visualTerminal).toContainText(/[$#]/);
  await command(page, "i=0; while [ $i -lt 150 ]; do printf 'VISUAL_HISTORY_%s\\n' \"$i\"; i=$((i+1)); done", 'VISUAL_HISTORY_149');
  await visualTerminal.click();
  await page.keyboard.type("printf 'CURSOR_ALIGNMENT_0123456789'; read -r answer");
  await page.keyboard.press('Enter');
  const alignmentRow = visualTerminal.locator('[data-terminal-line]').filter({ hasText: /^CURSOR_ALIGNMENT_0123456789$/ });
  await expect(alignmentRow).toHaveCount(1);
  await expect(alignmentRow.getByTestId('terminal-cursor')).toHaveCount(1);
  await expect.poll(() => alignmentRow.evaluate(row => {
    const content = row.children[1];
    const text = content.querySelector('span');
    const range = document.createRange();
    range.selectNodeContents(text);
    return Math.abs(content.querySelector('[data-testid="terminal-cursor"]').getBoundingClientRect().left
      - range.getBoundingClientRect().right);
  })).toBeLessThan(1);
  await page.keyboard.press('Enter');
  await page.keyboard.type("rows=$(stty size); rows=${rows%% *}; printf '\\033[?25l\\033[H\\033[JREDRAW_HIDDEN'; read -r answer; printf '\\033[%s;1HREDRAW_SHOWN\\033[?25h' \"$rows\"");
  await page.keyboard.press('Enter');
  await expect(visualTerminal).toContainText('REDRAW_HIDDEN');
  await expect(visualTerminal.getByTestId('terminal-cursor')).toHaveCount(0);
  const visualScroller = visualTerminal.locator(':scope > div').first();
  const hiddenGeometry = await visualScroller.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight }));
  await page.screenshot({ path: join(artifacts, 'redraw-hidden.png') });
  await page.keyboard.press('Enter');
  await expect(visualTerminal).toContainText('REDRAW_SHOWN');
  await expect(visualTerminal.getByTestId('terminal-cursor')).toHaveCount(1);
  const shownGeometry = await visualScroller.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight }));
  assert.deepEqual(shownGeometry, hiddenGeometry, 'home/erase and bottom-row redraw must not shift scrollback');
  await page.screenshot({ path: join(artifacts, 'redraw-shown.png') });
  console.log('[UI Test] PASS: child cursor hide/show and multi-frame redraw preserve scroll geometry');

  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  assert.deepEqual(errors, [], 'no browser runtime errors');
  assert.deepEqual(probeFailures, [], 'all MVP probes must pass; recorded failures are never skipped successes');
  console.log('[UI Test] PASS: browser smoke complete (screenshots are evidence, not pixel assertions)');
}

try {
  await main();
} catch (error) {
  console.error(`[UI Test] FAIL: ${error.stack || error.message}`);
  if (page && !page.isClosed()) {
    console.error(`[UI Test] terminal evidence: ${(await page.getByTestId('raw-terminal').allInnerTexts()).join('\n').slice(-6000)}`);
    // The rendered window, not just the text: with only a slice of rows in the
    // document, "the text is missing" and "the reader is looking elsewhere" are
    // different failures and read identically from innerText alone.
    console.error('[UI Test] window state: ' + JSON.stringify(await page.getByTestId('raw-terminal').evaluate((element) => {
      const scroll = element.firstElementChild;
      const idx = [...element.querySelectorAll('[data-terminal-line]')]
        .map((r) => Number(r.dataset.terminalLine));
      return {
        scrollTop: scroll?.scrollTop,
        scrollHeight: scroll?.scrollHeight,
        clientHeight: scroll?.clientHeight,
        atTail: scroll ? scroll.scrollHeight - (scroll.scrollTop + scroll.clientHeight) < 24 : null,
        renderedFirst: idx[0], renderedLast: idx[idx.length - 1], renderedCount: idx.length,
      };
    })));
    await page.screenshot({ path: join(artifacts, 'failure.png') });
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (vite) await new Promise((resolveClose, reject) => vite.httpServer.close(error => error ? reject(error) : resolveClose()));
  await stopDaemon();
  // Only this run's disposable private socket. Never target the user's tmux.
  spawnSync('tmux', ['-L', 'doom-term', 'kill-server'], { env: testEnv, timeout: 3000 });
}
