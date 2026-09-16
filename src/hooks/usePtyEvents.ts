import { useEffect } from 'react';
import { ProjectWorkspace, SessionNode } from '../types/sessionTree';
import { AnsiLine, ScreenCursor } from '../types/terminal';
import { getEmulator, onScreenParsed } from '../core/emulatorRegistry';
import { noteOutput } from '../core/activityMonitor';
import { attentionQueue } from '../core/attentionQueue';
import { forgetMarkingAgent } from '../core/turnMarks';
import { projectStreamRecord } from '../core/streamProjection';
import type { StreamRecord } from '../core/streamProtocol';
import { ptyClient } from '../core/ptyClient';
import { audioEngine } from '../core/audioEngine';
import { boundCachedLines } from '../core/presentationCache';
import { type AppTelemetry } from '../hud/state';

type WorkspaceUpdater = (updater: (prev: ProjectWorkspace) => ProjectWorkspace) => void;
type TelemetryUpdater = (updater: (prev: AppTelemetry) => AppTelemetry) => void;

/**
 * Which source decides whether the pane is full-screen.
 *
 * The screen model is the default and is right without tmux. Under tmux it is
 * structurally blind: the client is kept out of the alternate buffer on purpose
 * so scrollback and command blocks keep working, so a full-screen program in
 * the pane never touches our buffer type. When the daemon has reported a state,
 * it is the only one that saw the truth.
 */
export function resolveTuiState(
  screenSaysAlt: boolean,
  daemonReported: boolean | undefined
): boolean {
  return daemonReported ?? screenSaysAlt;
}

/**
 * Which node an agent hook event belongs to.
 *
 * The exact answer first: the daemon puts DOOM_TERM_SESSION_ID on every
 * session's environment, the agent inherits it, and its hook script forwards
 * it — so an event that carries one names its pane outright.
 *
 * The directory is only a fallback, and a lossy one. It used to be the ONLY
 * key, via `Object.values(nodes).find(n => n.cwd === cwd)`: two agents in one
 * repository were indistinguishable, so the first-created node absorbed both
 * their prompts and the notification focused the wrong session. It is kept for
 * an agent that was already running before its session carried the variable,
 * and it refuses to guess when more than one node matches — an ambiguous
 * answer is worse than none, because it silently marks a session that is not
 * waiting on anybody.
 *
 * Pure and exported so the correlation is testable without a socket: the
 * previous test only proved a notice preserved the node id it was handed, and
 * never that the id was chosen correctly.
 */
export function resolveAgentEventTarget(
  nodes: Record<string, SessionNode>,
  event: { cwd?: string | null; doomSessionId?: string | null },
): SessionNode | null {
  if (event.doomSessionId) {
    return nodes[event.doomSessionId] ?? null;
  }
  if (!event.cwd) return null;
  const matches = Object.values(nodes).filter((node) => node.cwd === event.cwd);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The last full-screen state the daemon reported, per session.
 *
 * Module scope rather than hook state: the value is read inside the parsed-frame
 * handler, which must not re-subscribe every time it changes.
 */
export interface ReportedTuiState { stream: string; active?: boolean }

/** A daemon observation belongs only to the stream that produced it. */
export function advanceReportedTuiState(
  previous: ReportedTuiState | undefined,
  record: StreamRecord,
): ReportedTuiState {
  const stream = `${record.incarnation}/${record.stream_epoch}`;
  const current = previous?.stream === stream ? previous : { stream };
  return record.payload.type === 'Event' && record.payload.payload.type === 'TuiMode'
    ? { stream, active: record.payload.payload.payload.active }
    : current;
}

const reportedTuiState = new Map<string, ReportedTuiState>();

/** Drop only daemon-derived observations; local controls and attention state survive. */
export function clearObservedTelemetry(previous: AppTelemetry, sessionId: string): AppTelemetry {
  return {
    sessionId,
    chips: previous.chips,
    shellMetrics: previous.shellMetrics,
    pendingApproval: previous.pendingApproval,
    permissionMode: previous.permissionMode,
    agentBusy: previous.agentBusy,
    waiting: previous.waiting,
    mode: previous.mode,
    transport: previous.transport,
  };
}

/**
 * Put the session's screen where the one view will read it.
 *
 * There used to be a fork here. An alt-screen program or an inline agent got
 * the screen's own grid; ANYTHING ELSE got a re-read slice of scrollback from
 * a mark, because "anything else" was drawn by the block editor.
 *
 * Deleting the block editor left that second branch feeding a view that no
 * longer exists, and a plain shell rendered a completely blank terminal. There
 * is one view now, so there is one destination: whatever the screen says.
 *
 * Pure and exported so the routing is testable without a registry, a socket or
 * a DOM — the fork above was inline, which is exactly why nothing caught it.
 */
export function applyScreenToNode(
  node: SessionNode,
  lines: AnsiLine[],
  inAltScreen: boolean,
  cursor?: ScreenCursor,
): SessionNode {
  return { ...node, isTuiActive: inAltScreen, tuiLines: lines, cursor };
}

/**
 * Every subscription to the PTY daemon: terminal output, working directory,
 * command boundaries, full-screen mode and agent state, plus telemetry.
 *
 * Registered once for the lifetime of the app — the handlers reach the right
 * session through the id the daemon sends, not through anything captured here.
 */
export function usePtyEvents(setWorkspace: WorkspaceUpdater, setTelemetry: TelemetryUpdater) {
  useEffect(() => {
    const unbindPty = ptyClient.registerHandler({
      onOutput: (_rawChunk, sessionId) => {
        // StreamApplication already parsed these live bytes. Never parse twice.
        noteOutput(sessionId);
        attentionQueue.noteOutput(sessionId);
      },
      onStreamRecord: (record, context) => {
        const id = record.session_id;
        reportedTuiState.set(id, advanceReportedTuiState(reportedTuiState.get(id), record));
        setWorkspace(previous => {
          const node = previous.nodes[id];
          if (!node) return previous;
          const projected = projectStreamRecord(node, record, context);
          return projected === node ? previous : { ...previous, nodes: { ...previous.nodes, [id]: projected } };
        });
        if (context.phase === 'live' && id === ptyClient.getSessionId()
            && record.payload.type === 'Event' && record.payload.payload.type === 'Cwd') {
          ptyClient.requestTelemetry(record.payload.payload.payload.path);
        }
      },
      onStreamActivity: (record) => {
        if (record.session_id === ptyClient.getSessionId() && record.payload.type === 'Event'
            && record.payload.payload.type === 'TuiMode' && record.payload.payload.payload.active) {
          audioEngine.playSound('door', 2);
        }
      },
      onAgentEvent: ({ event, doomSessionId, incarnation, eventId, phase }) => {
        const blocked = event === 'PermissionRequest';
        const cleared = event === 'Stop';
        if (!blocked && !cleared) return;
        setWorkspace((prev) => {
          const match = prev.nodes[doomSessionId];
          if (!match || match.incarnation !== incarnation || match.lastHookEventId === eventId) return prev;
          return {
            ...prev,
            nodes: {
              ...prev.nodes,
              [match.id]: {
                ...match,
                blockedOnUser: blocked,
                lastHookEventId: eventId,
                lastLiveAskEventId: blocked && phase === 'live' ? eventId : match.lastLiveAskEventId,
                attentionSerial: blocked && phase === 'live' ? (match.attentionSerial ?? 0) + 1 : match.attentionSerial,
              },
            },
          };
        });
      },

      onSessionClosed: (sessionId) => {
        reportedTuiState.delete(sessionId);
        forgetMarkingAgent(sessionId);
        setWorkspace((prev) => {
          const target = prev.nodes[sessionId];
          if (!target || target.exited === true) return prev;
          return {
            ...prev,
            nodes: {
              ...prev.nodes,
              [sessionId]: {
                ...target,
                exited: true,
                atPrompt: false,
                blockedOnUser: false,
              },
            },
          };
        });
      },

    });

    const unbindHistory = ptyClient.onHistory((sessionId, history) => {
      setWorkspace(previous => {
        const target = previous.nodes[sessionId];
        if (!target) return previous;
        const cache = target.recoveryCacheLines
          ? { lines: target.recoveryCacheLines, truncated: target.recoveryCacheTruncated === true }
          : boundCachedLines(target.tuiLines);
        // Once a rebuild exists, its original cached screen remains the first
        // half of the combined 8 MiB / 5,000-line budget. Later live frames
        // must not silently enlarge that historical half before another rebuild.
        ptyClient.setCachedHistoryBudget(sessionId, cache.lines);
        const metadata = history.metadata;
        const recoveredHistory = {
          status: history.status, data: history.data, reason: history.reason,
          ...(metadata ? { captureId: metadata.capture_id, historyAtLimit: metadata.history_at_limit } : {}),
          potentiallyOverlapping: true as const, potentiallyIncomplete: true as const,
        };
        return { ...previous, nodes: { ...previous.nodes, [sessionId]: { ...target,
          recoveryCacheLines: cache.lines, recoveryCacheTruncated: cache.truncated,
          recoveredHistory,
        } } };
      });
    });

    // One render per frame per session, however many chunks arrived in it. The
    // previous shape ran a full React update over the whole scrollback for
    // every 8KB chunk the daemon delivered.
    const unbindParsed = onScreenParsed((sessionId) => {
      const emu = getEmulator(sessionId);
      const lines = emu.getLines();
      if (ptyClient.getHistory(sessionId) === null) ptyClient.setCachedHistoryBudget(sessionId, lines);
      const inAltScreen = resolveTuiState(emu.isAltScreen(), reportedTuiState.get(sessionId)?.active);
      // Read WITH the lines, not inside the updater below.
      //
      // `cursor.row` is an index into `lines`, so the two are one observation
      // and have to be taken in the same tick. A state updater is not a tick:
      // React runs it during the next render, and React may run it more than
      // once. The daemon keeps writing into the emulator in between, so the
      // deferred read returned the caret of a buffer that had already scrolled
      // past the snapshot — `baseY + cursorY` then named a row that, in the
      // captured lines, is somewhere else entirely. Observed live as the caret
      // flashing to a row near the top of the pane for a single frame during
      // streaming output, then snapping back.
      const cursor = emu.getCursor();

      setWorkspace((prev) => {
        const target = prev.nodes[sessionId];
        if (!target) return prev;

        const updatedNode = applyScreenToNode(
          target,
          lines,
          inAltScreen,
          cursor,
        );

        return {
          ...prev,
          nodes: {
            ...prev.nodes,
            [updatedNode.id]: updatedNode,
          },
        };
      });
    });

    const unbindTele = ptyClient.onTelemetry((data) => {
      // The kernel's answer about who holds this session's keyboard, pinned to
      // the session that asked. Without the echoed id a reply that lands after
      // a tab switch would put the previous tab's agent on this one, and with
      // it the pass-through mode that agent needs.
      if (data.session_id) {
        const sessionId = data.session_id;
        const agentKey = data.agent_key ?? null;
        setWorkspace((prev) => {
          const target = prev.nodes[sessionId];
          if (!target) return prev;
          const cwd = data.current_dir;
          const gitBranch = data.git_branch ?? '';
          if ((target.foregroundAgent ?? null) === agentKey && target.cwd === cwd && target.gitBranch === gitBranch) return prev;
          return {
            ...prev,
            nodes: { ...prev.nodes, [sessionId]: { ...target, foregroundAgent: agentKey, cwd, gitBranch } },
          };
        });
      }

      if ((data.session_id ?? '') !== ptyClient.getSessionId()) return;
      setTelemetry((prev) => ({
        ...prev,
        sessionId: data.session_id ?? undefined,
        cwd: data.current_dir,
        // A directory that is not a repository has no branch. Do not invent one.
        branch: data.git_branch ?? '',
        isolation: data.isolation,
        agent: data.agent_key ?? 'shell',
        agentName: data.agent_name ?? undefined,
        // null means the daemon could not observe it. Leave it undefined so
        // pct() renders '--'; `?? 0` here would invent a fresh quota.
        rateUsed: data.rate_used ?? undefined,
        contextUsed: data.context_used ?? undefined,
        model: data.agent_model ?? undefined,
      }));
    });

    const unbindTeleUnavailable = ptyClient.onTelemetryUnavailable((sessionId) => {
      if (sessionId !== ptyClient.getSessionId()) return;
      setTelemetry(previous => clearObservedTelemetry(previous, sessionId));
    });

    return () => {
      unbindPty();
      unbindHistory();
      unbindParsed();
      unbindTele();
      unbindTeleUnavailable();
    };
  }, []);

}
