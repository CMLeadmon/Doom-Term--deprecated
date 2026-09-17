#!/usr/bin/env node
/**
 * Install or remove Doom Term's agent hooks.
 *
 *   node tools/agent-hooks/install.mjs            # install
 *   node tools/agent-hooks/install.mjs --remove   # remove ours, leave others
 *   node tools/agent-hooks/install.mjs --status   # report, change nothing
 *   node tools/agent-hooks/install.mjs --purge-nodeterm   # also drop nodeterm's
 *
 * ── WHY THIS APPENDS RATHER THAN REPLACES ──────────────────────────────────
 *
 * `hooks.<Event>` in Claude Code's settings.json is an ARRAY of matcher groups.
 * Other tools install into the same array — nodeterm did on this machine, for
 * five agents, on 2026-08-23. Overwriting it would silently break whatever else
 * the user runs, and we would never notice because our own thing would work.
 *
 * So: every entry we write carries MARKER in its command string. Install
 * replaces only entries carrying it; removal deletes only those. Anything we
 * did not write is left exactly as found, and running install twice is a no-op
 * rather than a duplicate.
 *
 * A backup is written next to the file the first time it is modified.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, statSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Our fingerprint. Never change it without a migration — removal keys on it. */
const MARKER = 'doom-term-hook';

/**
 * Which hook this platform can actually run.
 *
 * The .sh hook needs `sh`, GNU `timeout` and `curl` on PATH. Windows has none
 * of the first two by default, and Claude Code's native Windows build no
 * longer requires Git for Windows — so installing the POSIX hook there writes
 * a config entry that can never fire, and the agent well stays dark for a
 * reason nothing reports. The .ps1 sibling keeps the same contract.
 */
const WINDOWS = process.platform === 'win32';
const HOOK_NAME = WINDOWS ? 'doom-term-hook.ps1' : 'doom-term-hook.sh';
const HOOK_SRC = join(dirname(fileURLToPath(import.meta.url)), HOOK_NAME);
const ARTIFACT_SRC = join(dirname(fileURLToPath(import.meta.url)), 'doom-term-artifact.sh');
const REMOTE_SRC = join(dirname(fileURLToPath(import.meta.url)), 'doom-term-remote.sh');
/** Shells whose rc file we know how to patch additively. */
const REMOTE_RC = ['.bashrc', '.zshrc'];
const hookDestination = root => join(root, '.doom-term', 'agent-hooks', HOOK_NAME);
const artifactHookDestination = root => join(root, '.doom-term', 'agent-hooks', 'doom-term-artifact.sh');
const localBinArtifact = root => join(root, '.local', 'bin', 'doom-term-artifact');

/**
 * The events worth forwarding.
 *
 * PermissionRequest is the summons: the vendor telling us it has stopped and
 * needs a human. Stop clears it. Notification is deliberately NOT here — it is
 * a superset that fires for things which are not a block, and summoning on it
 * would take the screen for no reason.
 */
const EVENTS = ['PermissionRequest', 'Stop'];

/**
 * Both vendors use the same shape — `hooks.<Event>` is an array of matcher
 * groups, each with its own `hooks` array — and the same PascalCase event
 * names. (Codex's config.toml carries snake_case keys, but those are its
 * internal state cache, not event names. Verified against ~/.codex/hooks.json
 * on 2026-09-01.)
 */
const targets = root => [
  { name: 'claude', path: join(root, '.claude', 'settings.json') },
  { name: 'codex', path: join(root, '.codex', 'hooks.json') },
];

/** Another tool's entries, matched so they can be removed on request. */
const isNodeterm = (h) =>
  typeof h?.command === 'string' && h.command.includes('.nodeterm/agent-hooks');

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
/**
 * PowerShell single-quoted strings escape a quote by doubling it, and know no
 * other escape — so a path is safe to interpolate once its own quotes are
 * doubled. `-File` must come last: everything after it is the script's own
 * arguments.
 *
 * -NoProfile because a hook is not an interactive shell and loading the user's
 * profile would put arbitrary startup time inside the agent's critical path.
 * -ExecutionPolicy Bypass because the script is installed unsigned into the
 * user's own directory, and the flag is scoped to this one invocation rather
 * than changing any machine or user policy.
 */
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const command = (agent, destination) =>
  WINDOWS
    ? `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${psQuote(destination)} ${agent}  # ${MARKER}`
    : `sh ${shellQuote(destination)} ${agent}  # ${MARKER}`;
const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARKER);

function backupOnce(path) {
  const bak = `${path}.doom-term-backup`;
  if (!existsSync(bak)) copyFileSync(path, bak);
  return bak;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readConfig(path) {
  const source = readFileSync(path, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(source);
  } catch (error) {
    throw new Error(`${path}: invalid JSON; no configuration changed`, { cause: error });
  }
  if (!isObject(cfg) || (cfg.hooks !== undefined && !isObject(cfg.hooks))) {
    throw new Error(`${path}: unsupported configuration; expected an object with a hooks object`);
  }
  for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
    if (!Array.isArray(groups) || groups.some(group => !isObject(group) || !Array.isArray(group.hooks) || group.hooks.some(hook => !isObject(hook)))) {
      throw new Error(`${path}: unsupported hooks.${event} structure; refusing to modify it`);
    }
  }
  return { source, cfg };
}

/** Rename complete content over the target; never truncate a live config. */
function atomicWrite(path, content, mode) {
  const temporary = join(dirname(path), `.doom-hook-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/**
 * Rewrite one vendor's hook config.
 *
 * Ours are always stripped first, so installing twice is a no-op rather than a
 * duplicate. `purgeNodeterm` additionally drops the other tool's entries — only
 * when explicitly asked, because silently disabling somebody else's terminal is
 * exactly the failure this file exists to avoid.
 */
function prepare({ name, path }, { remove, purgeNodeterm, destination }) {
  if (!existsSync(path)) return { path, note: 'not installed' };

  // Respect users who intentionally symlink vendor settings elsewhere.
  path = realpathSync(path);
  const { source, cfg } = readConfig(path);
  cfg.hooks ??= {};
  const foreign = new Set();
  let purged = 0;
  let changed = false;

  // Ours go only on EVENTS, but a purge sweeps EVERY event the file declares —
  // "uninstall nodeterm" means all of it, not just the two we happen to use.
  const sweep = purgeNodeterm
    ? [...new Set([...EVENTS, ...Object.keys(cfg.hooks)])]
    : EVENTS;

  for (const event of sweep) {
    const before = JSON.stringify(cfg.hooks[event] ?? []);

    let groups = (cfg.hooks[event] ?? []).flatMap((g) => {
      const hooks = g.hooks.filter((h) => {
        if (isOurs(h)) return false;
        if (purgeNodeterm && isNodeterm(h)) { purged++; return false; }
        foreign.add(event);
        return true;
      });
      // Remove a group only when removing our entries made it empty. Empty
      // foreign groups and unknown vendor fields are not ours to erase.
      if (hooks.length === 0 && g.hooks.length > 0) return [];
      return [{ ...g, hooks }];
    });

    if (!remove && EVENTS.includes(event)) {
      groups = [...groups, { hooks: [{ type: 'command', command: command(name, destination) }] }];
    }

    if (groups.length === 0) delete cfg.hooks[event];
    else cfg.hooks[event] = groups;

    if (JSON.stringify(cfg.hooks[event] ?? []) !== before) changed = true;
  }

  return { path, source, content: `${JSON.stringify(cfg, null, 2)}\n`, mode: statSync(path).mode & 0o777, changed, purged, coexisting: [...foreign] };
}

function status(root) {
  const out = [];
  for (const { name, path } of targets(root)) {
    if (!existsSync(path)) { out.push(`${name}: not installed`); continue; }
    const { cfg } = readConfig(path);
    for (const event of [...new Set([...EVENTS, ...Object.keys(cfg.hooks ?? {})])]) {
      const entries = (cfg.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []);
      const ours = entries.filter(isOurs).length;
      const nt = entries.filter(isNodeterm).length;
      const other = entries.length - ours - nt;
      if (ours + nt + other === 0) continue;
      out.push(`${name}.${event}: ${ours} doom-term, ${nt} nodeterm, ${other} other`);
    }
  }
  return out;
}

/**
 * Add (or remove) the remote enrichment snippet in a shell's own rc file.
 *
 * Additive and reversible, tagged with the same MARKER the agent hooks use, so
 * one uninstall convention covers both. Runs ON THE REMOTE MACHINE — this is
 * the route for a host you are already sitting on, where injecting a bootstrap
 * would mean typing into whatever the shell is currently doing.
 */
export function installRemoteSnippet({ root = homedir(), remove = false } = {}) {
  const begin = `# >>> doom-term remote >>>  # ${MARKER}`;
  const end = `# <<< doom-term remote <<<  # ${MARKER}`;
  const block = `${begin}\n${readFileSync(REMOTE_SRC, 'utf8').trimEnd()}\n${end}\n`;
  const results = [];
  for (const name of REMOTE_RC) {
    const path = join(root, name);
    if (!existsSync(path)) { results.push({ path, changed: false, note: 'absent' }); continue; }
    const before = readFileSync(path, 'utf8');
    // Strip any block we previously wrote, so install is idempotent and
    // uninstall is exact. The user's own lines are never touched.
    const stripped = before.replace(
      new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g'),
      '',
    );
    const after = remove ? stripped : `${stripped.trimEnd()}\n\n${block}`;
    if (after === before) { results.push({ path, changed: false }); continue; }
    backupOnce(path);
    atomicWrite(path, after, 0o644);
    results.push({ path, changed: true });
  }
  return results;
}

export function runInstaller({ root = homedir(), remove = false, purgeNodeterm = false } = {}) {
  const destination = hookDestination(root);
  // Preflight every vendor before copying the script, making backups, or
  // editing even the first config. Invalid JSON is never an empty config.
  const plans = targets(root).map(t => prepare(t, { remove, purgeNodeterm, destination }));
  for (const plan of plans) {
    if (plan.source !== undefined && readFileSync(plan.path, 'utf8') !== plan.source) {
      throw new Error(`${plan.path}: configuration changed during preflight; retry installation`);
    }
  }
  if (!remove) {
    mkdirSync(dirname(destination), { recursive: true });
    atomicWrite(destination, readFileSync(HOOK_SRC), 0o755);
    if (existsSync(ARTIFACT_SRC)) {
      atomicWrite(artifactHookDestination(root), readFileSync(ARTIFACT_SRC), 0o755);
      const localBin = localBinArtifact(root);
      try {
        mkdirSync(dirname(localBin), { recursive: true });
        atomicWrite(localBin, readFileSync(ARTIFACT_SRC), 0o755);
      } catch {}
    }
  } else {
    try { unlinkSync(destination); } catch {}
    try { unlinkSync(artifactHookDestination(root)); } catch {}
    try { unlinkSync(localBinArtifact(root)); } catch {}
  }
  for (const plan of plans) {
    if (plan.changed) {
      backupOnce(plan.path);
      atomicWrite(plan.path, plan.content, plan.mode);
    }
  }
  // Do not expose configuration contents in logs or the public result.
  return plans.map(({ path, changed, purged, coexisting, note }) => ({ path, changed, purged, coexisting, note }));
}

function main() {
  const remove = process.argv.includes('--remove');
  const root = homedir();
  if (process.argv.includes('--remote')) {
    for (const r of installRemoteSnippet({ root, remove })) {
      console.log(`${r.path}: ${r.note ?? (r.changed ? (remove ? 'removed' : 'installed') : 'unchanged')}`);
    }
    return;
  }
  if (process.argv.includes('--status')) {
    console.log(status(root).join('\n'));
    return;
  }
  const results = runInstaller({ root, remove, purgeNodeterm: process.argv.includes('--purge-nodeterm') });
  console.log(remove ? 'Removed Doom Term hooks.' : `Installed Doom Term hooks -> ${hookDestination(root)}`);
  for (const r of results) {
    const co = r.coexisting?.length ? ` (left other tools' hooks on: ${r.coexisting.join(', ')})` : '';
    const pu = r.purged ? ` (removed ${r.purged} nodeterm entr${r.purged === 1 ? 'y' : 'ies'})` : '';
    console.log(`  ${r.path}: ${r.note ?? (r.changed ? 'updated' : 'unchanged')}${pu}${co}`);
  }
  console.log('\nStatus:');
  console.log(status(root).map((l) => `  ${l}`).join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`Hook installation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
