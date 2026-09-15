import type { RecoveredHistoryPresentation } from '../types/sessionTree';
import type { AnsiLine } from '../types/terminal';
import { archivePresentationText } from '../core/archivePresentation';
import { spanStyle } from '../core/spanStyle';

export function RecoveredHistory({ cache, cacheTruncated, history }: {
  cache: readonly AnsiLine[]; cacheTruncated?: boolean; history: RecoveredHistoryPresentation;
}) {
  const captured = history.status === 'complete' && history.data !== null
    ? archivePresentationText(history.data) : null;
  return <section aria-label="Recovered history" className="recess mb-2 p-2 select-text"
    style={{ color: 'var(--ink)' }}>
    <div className="mb-1 text-[10px] font-bold tracking-wider" style={{ color: 'var(--st-wait)' }}>
      RECOVERED HISTORY · DISCONTINUOUS · POTENTIALLY OVERLAPPING / INCOMPLETE
    </div>
    {cache.length > 0 && <div aria-label="Cached history" className="whitespace-pre">
      {cache.map((line, row) => <div key={`${line.id}-${row}`}>
        {line.spans.map((span, index) => <span key={index} style={spanStyle(span, line.isError)}>{span.text}</span>)}
      </div>)}
    </div>}
    {cacheTruncated && <div className="text-[10px]" style={{ color: 'var(--st-wait)' }}>CACHED PREFIX TRUNCATED</div>}
    {captured !== null && <pre aria-label="Captured tmux history" className="m-0 whitespace-pre-wrap font-inherit">{captured}</pre>}
    {history.historyAtLimit && <div className="text-[10px]" style={{ color: 'var(--st-wait)' }}>TMUX HISTORY LIMIT REACHED</div>}
    {history.status !== 'complete' && <div role="status" className="text-[10px]" style={{ color: 'var(--st-wait)' }}>
      {history.reason ?? (history.status === 'receiving' ? 'RECEIVING CAPTURE…' : 'HISTORY UNAVAILABLE')}
    </div>}
    <div className="mt-1 text-[10px]" style={{ color: 'var(--ink-dim)' }}>
      LIVE VIEW STARTS BELOW · NO PRECISE SEAM IS CLAIMED
    </div>
  </section>;
}
