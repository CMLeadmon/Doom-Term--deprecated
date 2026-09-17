import { describe, it, expect } from 'vitest';
import { applyTelemetry } from './usePtyEvents';
import type { SystemTelemetryData } from '../types/terminal';
import type { AppTelemetry } from '../hud/state';

const previous: AppTelemetry = {};

const frame = (over: Partial<SystemTelemetryData>): SystemTelemetryData => ({
  session_id: 's1',
  username: 'cml',
  hostname: 'laptop',
  current_dir: '/home/cml',
  git_branch: 'main',
  isolation: 'host',
  agent_key: 'claude',
  agent_name: 'CLAUDE CODE',
  ...over,
});

describe('applyTelemetry', () => {
  it('leaves a local session exactly as it was', () => {
    const next = applyTelemetry(previous, frame({ remote: null }));
    expect(next.branch).toBe('main');
    expect(next.remoteHost).toBeUndefined();
  });

  it('prefers what the remote reported', () => {
    const next = applyTelemetry(previous, frame({
      remote: { host: 'devbox', branch: 'feat/x', busy: true },
    }));
    expect(next.branch).toBe('feat/x');
    expect(next.remoteHost).toBe('devbox');
    expect(next.agentBusy).toBe(true);
  });

  it('renders a field the remote did not report as unknown, never the local one', () => {
    // The whole point. This machine has a branch; it is not the remote's.
    const next = applyTelemetry(previous, frame({ remote: { host: 'devbox' } }));
    expect(next.branch).toBe('');
  });

  it('never coerces an absent percentage to zero', () => {
    const next = applyTelemetry(previous, frame({
      remote: { host: 'devbox' }, context_used: null, rate_used: null,
    }));
    expect(next.contextUsed).toBeUndefined();
    expect(next.rateUsed).toBeUndefined();
  });

  it('keeps the previous busy state when the remote does not say', () => {
    const next = applyTelemetry({ agentBusy: true }, frame({ remote: { host: 'devbox' } }));
    expect(next.agentBusy).toBe(true);
  });
});
