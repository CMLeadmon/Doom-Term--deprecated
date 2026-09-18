/**
 * Where the PTY daemon is listening.
 *
 * The port used to be a constant in two places. It cannot be any more: the
 * desktop shell moves the daemon off the default when something else already
 * holds it, and a frontend that dials a compiled-in 1421 in that case connects
 * to the stranger instead — which is exactly the failure this replaced, a
 * terminal that never opens and no error anywhere to say why.
 *
 * The shell injects the real port before any page script runs. The default is
 * the fallback for the browser dev server and for tests, where no shell has
 * injected anything and the daemon is wherever `npm run server` put it.
 */
export const DEFAULT_DAEMON_PORT = 1421;

export function daemonPort(): number {
  const injected = (globalThis as { __DOOM_TERM_DAEMON_PORT__?: unknown })
    .__DOOM_TERM_DAEMON_PORT__;
  return typeof injected === 'number' && Number.isInteger(injected) && injected > 0 && injected < 65536
    ? injected
    : DEFAULT_DAEMON_PORT;
}
