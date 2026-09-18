import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PtyClient } from './ptyClient';

const validInc = (n: number) => n.toString(16).padStart(32, '0');

describe('PtyClient Failure Containment', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('does not restart the shared connection when a single attachment faults', () => {
    const restartSpy = vi.fn();
    const client = new PtyClient({
      socket: () => ({
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
        close: vi.fn(),
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
      }) as any,
    });

    (client as any).connection.restart = restartSpy;
    (client as any).connection.current = { status: 'ready' };

    client.ensureSession('pane-1', '/tmp', validInc(1));
    const binding1 = (client as any).bindings.get('pane-1');
    expect(binding1).toBeDefined();

    // Trigger attachment failure on pane-1
    binding1.attachment.options.onFailure('Simulated stream parser error');

    // The shared connection must NOT be restarted
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('does not restart connection when attach promise rejects', async () => {
    const restartSpy = vi.fn();
    const client = new PtyClient({
      socket: () => ({
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
        close: vi.fn(),
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
      }) as any,
    });

    (client as any).connection.restart = restartSpy;
    (client as any).connection.current = { status: 'ready' };

    client.ensureSession('pane-2', '/tmp', validInc(2));
    const binding = (client as any).bindings.get('pane-2');
    expect(binding).toBeDefined();

    // Mock attach rejecting
    binding.attachment.attach = vi.fn().mockRejectedValue(new Error('Daemon attach rejected'));
    binding.attempted = false;
    (client as any).pumpBindings();

    // Advance only enough for attach promise to settle, not handshake timer
    await vi.advanceTimersByTimeAsync(100);
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('clears binding.reason and permits input once attachment reaches ready', () => {
    const client = new PtyClient();
    (client as any).connection.current = { status: 'ready' };

    client.ensureSession('pane-3', '/tmp', validInc(3));
    const binding = (client as any).bindings.get('pane-3');
    expect(binding).toBeDefined();
    binding.reason = 'Previous creation error';

    // Mock attachment ready
    binding.attachment = {
      state: { status: 'ready', reason: null },
      mutate: vi.fn().mockReturnValue(true),
    };

    // inputReadiness must allow input once status is ready
    expect(client.inputReadiness('pane-3')).toBeNull();
    expect(client.writeToSession('pane-3', 'echo hello\n')).toBe(true);
  });

  it('times out an unsent create intent if connection never becomes ready', async () => {
    const client = new PtyClient();
    (client as any).connection.current = { status: 'disconnected' };

    const promise = client.createSession('unconnected-session', 80, 24);
    vi.advanceTimersByTime(5100);

    await expect(promise).rejects.toThrow(/timed out/i);
  });

  it('releases concurrency slot if attachment stalls beyond lease deadline', () => {
    const client = new PtyClient();
    (client as any).connection.current = { status: 'ready' };

    // Simulate 4 stalled attachments
    for (let i = 1; i <= 4; i++) {
      client.ensureSession(`stalled-${i}`, '/tmp', validInc(i));
    }

    expect((client as any).attaching.size).toBe(4);

    // 5th session would normally be starved
    client.ensureSession('stalled-5', '/tmp', validInc(5));
    const binding5 = (client as any).bindings.get('stalled-5');
    expect(binding5.attempted).toBe(false);

    // Advance past the attachment lease deadline (10s)
    vi.advanceTimersByTime(10100);

    // Stalled slots must be released, allowing stalled-5 to attach
    expect(binding5.attempted).toBe(true);
  });
});
