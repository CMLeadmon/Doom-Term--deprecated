import type { StreamDescriptor } from './streamProtocol';

export interface RecoverableSession {
  id: string;
  cwd?: string;
  command?: string;
  durable: boolean;
  incarnation?: string | null;
  identity_status?: 'owned' | 'unidentified' | 'replaced';
  stream?: StreamDescriptor | null;
  /** Required before explicit identification of an unlabelled durable root. */
  pane?: string;
  root_pid?: number;
}
export interface StoredSessionIdentity { id: string; incarnation?: string | null }
export interface RecoveryState {
  matched: string[];
  recoverable: RecoverableSession[];
  snapshots: string[];
  /** Missing from an incomplete inventory is not known to be absent. */
  waiting?: string[];
}
export type SessionBinding = 'ready' | 'waiting' | 'snapshot';
export function knownIncarnation(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
export function sessionBinding(nodeId: string, wasRestored: boolean, reconciled: boolean, state: RecoveryState): SessionBinding {
  if (!wasRestored) return 'ready';
  if (!reconciled || state.waiting?.includes(nodeId)) return 'waiting';
  return state.matched.includes(nodeId) ? 'ready' : 'snapshot';
}

/** Match exact process identities, never an id-only cache or command name.
 * Ambiguous discovery remains an explicit choice; no record can silently win
 * merely by appearing first in an inventory. */
export function reconcileSessions(
  storedSessions: readonly (StoredSessionIdentity | string)[],
  liveSessions: readonly RecoverableSession[],
  complete = true,
): RecoveryState {
  const stored = new Map(storedSessions.map(value => {
    const node = typeof value === 'string' ? { id: value } : value;
    return [node.id, node] as const;
  }));
  const uniqueLive = new Map<string, RecoverableSession>();
  const byId = new Map<string, RecoverableSession[]>();
  for (const session of liveSessions) {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(session.id) || typeof session.durable !== 'boolean') continue;
    const key = session.id + '/' + (session.incarnation ?? '--') + '/' + (session.identity_status ?? 'owned');
    if (uniqueLive.has(key)) continue;
    uniqueLive.set(key, session);
    const group = byId.get(session.id) ?? [];
    group.push(session); byId.set(session.id, group);
  }
  const matched: string[] = [];
  for (const [id, node] of stored) {
    const candidates = byId.get(id);
    if (!knownIncarnation(node.incarnation) || candidates?.length !== 1) continue;
    const candidate = candidates[0];
    if (candidate.incarnation === node.incarnation && (!candidate.identity_status || candidate.identity_status === 'owned')) matched.push(id);
  }
  const matchedSet = new Set(matched);
  const unmatched = [...stored.keys()].filter(id => !matchedSet.has(id));
  // A present but different identity is observed replacement, even if other
  // portions of discovery failed. Truly unlisted identities remain waiting.
  const snapshots = unmatched.filter(id => complete || byId.has(id));
  const waiting = unmatched.filter(id => !complete && !byId.has(id));
  return { matched, recoverable: [...uniqueLive.values()].filter(row => !matchedSet.has(row.id)), snapshots,
    ...(waiting.length ? { waiting } : {}) };
}
