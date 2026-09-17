# Render Pipeline: Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the terminal viewport anchor on an absolute line instead of a scroll pixel, virtualize the row list, and stop silently swallowing refused keystrokes — so scrolling is smooth, history stays intact, and input latency drops.

**Architecture:** Three pure, DOM-free modules (`viewportAnchor`, `rowWindow`, `localEcho`) carry the logic and are tested without a browser; `RawTerminalView` becomes their wiring. `XtermScreen` gains a trim counter so line numbers are absolute and monotonic for the life of a session, which is what makes both the anchor and React's keys stable.

**Tech Stack:** TypeScript 5.7, React 19, `@xterm/headless` 6, Vitest 3 + jsdom, `@testing-library/react` 16.

**Spec:** [`../specs/2026-09-17-remote-and-render-design.md`](../specs/2026-09-17-remote-and-render-design.md) — Track A, and the two shared roots.

**Design**: [`../specs/2026-09-17-remote-and-render-design.md`](../specs/2026-09-17-remote-and-render-design.md)
**Branch**: `feat/remote-enhancement`
**Started**: 2026-09-17

Stages are ordered so each one is independently verifiable and independently
revertable. Stage N does not depend on Stage N+1 landing.

**This plan owns TypeScript only.** Every change to `crates/doom-term-pty/`
— including the DSR-6 fix that Stage 7 depends on — belongs to
[`2026-09-17-remote-awareness.md`](2026-09-17-remote-awareness.md). Two plans
must never edit `demuxer.rs` in the same session.

---

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every stage's requirements implicitly
include this section.

**Visual invariants — enforced by CI (`npm run test`):**
- `* { border-radius: 0; }` is global in `src/styles/material.css`. Tailwind
  `rounded-*` utilities are forbidden.
- Depth comes only from the 1px bevel pair. Blurred `box-shadow`, CSS blur
  filters and drop shadows are forbidden.
  - `--bevel-up: inset 1px 1px 0 #a2a29f, inset -1px -1px 0 #2f2f2e;`
  - `--bevel-dn: inset 1px 1px 0 #171716, inset -1px -1px 0 #8e8e8b;`
- Five canonical state colours, all WCAG 2.1 AA (>= 4.5:1) on `--ground`
  (`#14120f`), validated by `src/styles/material.test.js`:
  `--st-live: #e0a92c`, `--st-pass: #5c9c3a`, `--st-fail: #ef4136`,
  `--st-wait: #5b8ae8`, `--st-idle: #847c6e`.
- Four materials only: Plate, Recess (`#14120f`), the 1px bevel pair, Ink.
- No runtime icon libraries. Unicode/ASCII glyphs only.

**Axioms:**
1. Plain `Ctrl` keys belong unconditionally to the foreground child process.
   Never bind an unadorned `Ctrl+[A-Z]` to an app action.
2. The Status Plate is the only persistent *application* chrome.
3. Never invent telemetry. An unknown value renders `--`, never `0` or `0%`.
4. Four materials, and no fifth.

**Integer metrics:** any surface rendering terminal cells must apply
`--terminal-tracking`, or text and caret drift apart by a full cell every nine
columns.

**Verification — the whole gate:**
```bash
npm run agent:verify
```
Baseline on this branch before any work, measured 2026-09-17: `npm run
typecheck` clean, `npm run hud:check` PASS at 0 mismatched px. This plan must
not move the HUD baseline; if `hud:check` fails, a stage touched the plate and
should not have.

**Commits:** conventional prefix and scope, body states what the code did
before. Never commit to `main`.

---

## File Structure

| File | Responsibility |
| :--- | :--- |
| `src/core/viewportAnchor.ts` **(new)** | The anchor algebra: tail vs. a named line, and resolving one to an array index. Pure. |
| `src/core/rowWindow.ts` **(new)** | Which slice of the buffer is in the DOM, and the two spacer heights. Pure arithmetic. |
| `src/core/localEcho.ts` **(new)** | The prediction ledger: what was typed, what is confirmed, when to engage and when to roll back. Pure. |
| `src/core/xtermScreen.ts` | Gains the trim counter. It is the only object that can measure trimming, because it owns the `Terminal`. |
| `src/core/xtermLines.ts` | Mints absolute `row` and the `L<n>` id from the trim count. |
| `src/types/terminal.ts` | `AnsiLine.row` and `ScreenCursor.row` documented as absolute. |
| `src/components/RawTerminalView.tsx` | Wiring only. Loses ~60 lines of unreachable compensation and the pixel cache. |

---

## Stage 0 — Prove the trim compensation is dead

No production change. The spec claims `RawTerminalView.tsx:385-396` never
executes; a plan that deletes sixty lines on an argument should first make the
argument executable.

- [ ] **Step 1: Write the characterization test**

Add to `src/components/RawTerminalView.test.tsx`, beside the existing trim test:

```tsx
  it('production-shaped lines always start at row 0, so the trim branch cannot fire', () => {
    // getLines() calls linesFrom(buffer, 0, ...) unconditionally
    // (xtermScreen.ts:266), so lines[0].row is 0 on every frame the app ever
    // renders. linesSince(), the only method that yields a non-zero first row,
    // has no caller in src/. The trimmed delta is therefore always 0 - 0.
    const shaped = (count: number, from: number) =>
      Array.from({ length: count }, (_, k) => ({
        id: `row-${from + k}`, row: from + k, spans: [{ text: `${from + k}` }], timestamp: 0,
      }));
    expect(shaped(3, 0)[0].row).toBe(0);
    const rowHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 17 });
    try {
      resetScrollback('dead');
      const props = { ...base, sessionId: 'dead', isActive: true };
      const view = render(<RawTerminalView {...props} lines={shaped(3, 0)} />);
      const scroller = screen.getByTestId('raw-terminal').firstElementChild as HTMLDivElement;
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 100 },
      });
      fireEvent.wheel(scroller, { deltaY: -100 });
      scroller.scrollTop = 300;
      fireEvent.scroll(scroller);
      expect(stateOf('dead').detached).toBe(true);

      // Two rows trimmed. In production the window still reports row 0 first,
      // so the reader is NOT compensated and the text crawls under them.
      view.rerender(<RawTerminalView {...props} lines={shaped(3, 0)} />);
      expect(scroller.scrollTop).toBe(300);   // uncompensated, by construction
      resetScrollback('dead');
    } finally {
      if (rowHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', rowHeight);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    }
  });
```

- [ ] **Step 2: Run it and confirm it passes against today's code**

Run: `npx vitest run src/components/RawTerminalView.test.tsx -t 'cannot fire'`
Expected: PASS. It documents current behaviour; it is not a bug report yet.

- [ ] **Step 3: Commit**

```bash
git add src/components/RawTerminalView.test.tsx
git commit -m "test(terminal): pin the trim compensation's unreachability"
```

---

## Stage 1 — Absolute, monotonic line numbers *(the keystone)*

**Files:**
- Modify: `src/core/xtermScreen.ts` — trim counter, absolute `getCursor()`
- Modify: `src/core/xtermLines.ts:65,131,165,173,177` — absolute `row`, `L<n>` id
- Modify: `src/types/terminal.ts:34-61` — doc comments
- Test: `src/core/xtermScreen.test.ts`, `src/core/xtermLines.test.ts`

**Interfaces:**
- Produces: `XtermScreen.trimmedCount(): number`; `linesFrom(buffer, startLine,
  previous?, trimmed?)`; `AnsiLine.row` and `AnsiLine.id` both absolute, with
  `id === \`L${row}\``.
- Consumes: nothing from earlier stages.

**Why a marker and not arithmetic.** `buffer.length` and `buffer.baseY` both
saturate once scrollback is full, so neither can count trims. `registerMarker`
is xterm's documented handle on a line: its `.line` tracks the line's current
buffer index as the buffer scrolls, and `onDispose` fires when that line is
trimmed away. `XtermScreen` already uses this API in `mark()` (`:256`).

- [ ] **Step 1: Write the failing test for the trim counter**

Add to `src/core/xtermScreen.test.ts`:

```ts
  it('counts lines trimmed off the top, monotonically', async () => {
    const screen = new XtermScreen(10, 3);
    try {
      expect(screen.trimmedCount()).toBe(0);
      // A 3-row grid with the default scrollback still trims eventually; drive
      // far past it so the oldest lines are certainly gone.
      for (let i = 0; i < 40; i++) await parsed(screen, `line${i}\r\n`);
      const first = screen.trimmedCount();
      expect(first).toBeGreaterThan(0);
      for (let i = 0; i < 10; i++) await parsed(screen, `more${i}\r\n`);
      expect(screen.trimmedCount()).toBeGreaterThanOrEqual(first);
    } finally { screen.dispose(); }
  });
```

Note: `XtermScreen` is constructed with `scrollback: SCROLLBACK` (5000) at
`xtermScreen.ts:65`. For this test to trim within 40 lines the constructor must
accept a scrollback override. Add an optional third parameter
`constructor(cols: number, rows: number, scrollback: number = SCROLLBACK)` and
pass it through to `createTerminal`; call it as `new XtermScreen(10, 3, 5)` in
the test.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/core/xtermScreen.test.ts -t 'trimmed off the top'`
Expected: FAIL — `screen.trimmedCount is not a function`.

- [ ] **Step 3: Implement the counter**

In `src/core/xtermScreen.ts`, add fields beside the existing `marks` map:

```ts
  /**
   * Lines trimmed off the top since this screen was created. Monotonic.
   *
   * Neither `buffer.length` nor `buffer.baseY` can supply this: both saturate
   * once scrollback is full, which is exactly when trimming starts. A marker
   * can. Its `.line` is the line's CURRENT buffer index and falls as rows are
   * deleted above it, so the difference between where it was and where it is
   * counts the deletions exactly.
   */
  private trimmed = 0;
  private anchorMarker: IMarker | null = null;
  /** The absolute line number `anchorMarker` was registered on. */
  private anchorAbsolute = 0;

  private syncTrimmed(): void {
    const marker = this.anchorMarker;
    if (marker && !marker.isDisposed && marker.line >= 0) {
      const measured = this.anchorAbsolute - marker.line;
      if (measured > this.trimmed) this.trimmed = measured;
      return;
    }
    // No usable anchor: adopt one at the current cursor. Until a second
    // observation there is nothing to measure, which is correct — a fresh
    // anchor has seen no trimming yet.
    this.anchorMarker = this.term.registerMarker(0) ?? null;
    if (this.anchorMarker) {
      this.anchorAbsolute = this.trimmed + this.anchorMarker.line;
      this.anchorMarker.onDispose(() => { this.anchorMarker = null; });
    }
  }

  trimmedCount(): number {
    this.syncTrimmed();
    return this.trimmed;
  }
```

`IMarker` is already imported at `xtermScreen.ts:3`. `reset()` (`:315`) must
clear the anchor — a reconstructed buffer has no history to have trimmed:

```ts
    this.trimmed = 0;
    this.anchorMarker = null;
    this.anchorAbsolute = 0;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/core/xtermScreen.test.ts -t 'trimmed off the top'`
Expected: PASS.

- [ ] **Step 5: Write the failing test for absolute ids**

Add to `src/core/xtermLines.test.ts`:

```ts
  it('mints an absolute id that survives trimming', () => {
    const term = new Terminal({ cols: 10, rows: 3, scrollback: 5, allowProposedApi: true });
    for (let i = 0; i < 20; i++) term.write(`line${i}\r\n`);
    const before = linesFrom(term.buffer.active, 0, [], 7);
    expect(before[0].id).toBe('L7');
    expect(before[0].row).toBe(7);
    expect(before[1].id).toBe('L8');
    // The same content, two rows further into the session, keeps its number.
    const after = linesFrom(term.buffer.active, 0, [], 9);
    expect(after[0].id).toBe('L9');
  });
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run src/core/xtermLines.test.ts -t 'absolute id'`
Expected: FAIL — ids are `row-0`, `row-1`.

- [ ] **Step 7: Implement absolute numbering**

`src/core/xtermLines.ts:165` — add the parameter:

```ts
export function linesFrom(
  buffer: IBuffer,
  startLine: number,
  previous: AnsiLine[] = [],
  trimmed = 0,
): AnsiLine[] {
```

`:173` — mint from the absolute number, not the buffer index:

```ts
    const absolute = trimmed + y;
    const next = lineToAnsi(line, `L${absolute}`, probe, absolute);
```

`:177` — compare against the absolute number, since that is what `row` now
holds:

```ts
    const unchanged = old && old.row === absolute && old.isWrapped === next.isWrapped
```

`src/core/xtermScreen.ts:266` — pass the count:

```ts
  getLines(): AnsiLine[] {
    this.renderedLines = linesFrom(this.term.buffer.active, 0, this.renderedLines, this.trimmedCount());
    return this.renderedLines;
  }
```

`:301` — `linesSince` has no production caller today but must not be left
inconsistent:

```ts
    return linesFrom(this.term.buffer.active, marker.line, [], this.trimmedCount());
```

`getCursor()` at `:278` — the caret must live in the same space as the rows it
is compared against (`RawTerminalView.tsx:764`):

```ts
    const bufferRow = buffer.baseY + buffer.cursorY;
    const row = this.trimmedCount() + bufferRow;
```
...and the two `buffer.getLine(row)` reads below it become
`buffer.getLine(bufferRow)`, because the buffer is still indexed by its own
row. **Getting this wrong makes the caret read a cell from the wrong line.**

- [ ] **Step 8: Correct the two doc comments that already disagreed**

`src/types/terminal.ts:35` currently says `row` is an "Index into the lines
array"; the implementation has always returned `baseY + cursorY`. Replace both
`row` comments:

```ts
  /**
   * Absolute line number since the session began, monotonic across trimming.
   * NOT an index into the lines array — see `AnsiLine.row`, which is the same
   * space, and `data-terminal-line`, which is not.
   */
  row: number;
```

- [ ] **Step 9: Run the full frontend suite**

Run: `npx vitest run`
Expected: the two new tests PASS. `RawTerminalView.test.tsx` fixtures that
hand-bake `` id: `row-${n}` `` still pass — they construct `AnsiLine` values
directly and never call `linesFrom`. Leave them for Stage 3.

- [ ] **Step 10: Commit**

```bash
git add src/core/xtermScreen.ts src/core/xtermLines.ts src/types/terminal.ts \
        src/core/xtermScreen.test.ts src/core/xtermLines.test.ts
git commit -m "fix(terminal): number lines absolutely, so an id survives trimming

The id was the absolute BUFFER index and shifted by one every time
scrollback trimmed, which its own comment conceded. React keys on it, so
after a trim key L4 named what L5 named a frame earlier and every row below
was re-associated with different content.

getCursor moves into the same space, which also settles a disagreement
ScreenCursor.row's doc comment has had with its implementation since it was
written: the comment said index-into-lines, the code always returned
baseY + cursorY."
```

---

## Stage 2 — The anchor algebra

**Files:**
- Create: `src/core/viewportAnchor.ts`
- Test: `src/core/viewportAnchor.test.ts`

**Interfaces:**
- Consumes: `AnsiLine.id` in `L<n>` form (Stage 1).
- Produces: `ViewportAnchor`, `TAIL`, `anchorAt`, `absoluteOf`, `indexOfAnchor`.

Pure and DOM-free. Nothing imports it yet.

- [ ] **Step 1: Write the failing tests**

Create `src/core/viewportAnchor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TAIL, anchorAt, absoluteOf, indexOfAnchor } from './viewportAnchor';
import type { AnsiLine } from '../types/terminal';

const line = (n: number): AnsiLine => ({ id: `L${n}`, row: n, spans: [{ text: `${n}` }], timestamp: 0 });

describe('viewportAnchor', () => {
  it('parses an absolute number out of an id', () => {
    expect(absoluteOf('L42')).toBe(42);
    expect(absoluteOf('L0')).toBe(0);
  });

  it('refuses an id it did not mint rather than guessing', () => {
    expect(absoluteOf('row-42')).toBeNull();
    expect(absoluteOf('L')).toBeNull();
    expect(absoluteOf('Lx')).toBeNull();
    expect(absoluteOf('')).toBeNull();
  });

  it('resolves an anchor to an index in O(1), not by scanning', () => {
    const lines = [line(10), line(11), line(12)];
    expect(indexOfAnchor(anchorAt('L11', 0), lines)).toBe(1);
    expect(indexOfAnchor(anchorAt('L10', 0), lines)).toBe(0);
  });

  it('returns null for a line that has been trimmed away', () => {
    const lines = [line(10), line(11), line(12)];
    expect(indexOfAnchor(anchorAt('L9', 0), lines)).toBeNull();
    expect(indexOfAnchor(anchorAt('L13', 0), lines)).toBeNull();
  });

  it('has no index for the tail — the tail is wherever the buffer ends', () => {
    expect(indexOfAnchor(TAIL, [line(10)])).toBeNull();
  });

  it('resolves nothing against an empty buffer', () => {
    expect(indexOfAnchor(anchorAt('L10', 0), [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/core/viewportAnchor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/viewportAnchor.ts`:

```ts
import type { AnsiLine } from '../types/terminal';

/**
 * Where the reader is, stated as a LINE rather than a pixel.
 *
 * A pixel offset cannot survive a buffer whose rows are deleted from the top
 * while new ones arrive at the bottom, and the correction that used to defend
 * one never executed: see the spec's Finding 4. An absolute line number needs
 * no correction, because row N is still row N after the rows above it go.
 */
export type ViewportAnchor =
  | { readonly mode: 'tail' }
  | { readonly mode: 'row'; readonly id: string; readonly offsetPx: number };

/** Following the newest output. The resting state. */
export const TAIL: ViewportAnchor = Object.freeze({ mode: 'tail' as const });

/** `offsetPx` is the anchored line's distance from the top of the viewport. */
export function anchorAt(id: string, offsetPx: number): ViewportAnchor {
  return Object.freeze({ mode: 'row' as const, id, offsetPx });
}

/**
 * The absolute line number an id names, or null when the id is not one of ours.
 *
 * Null rather than a guess: an id minted by something else describes a line
 * this function cannot locate, and returning 0 would silently anchor the
 * reader to the top of the buffer.
 */
export function absoluteOf(id: string): number | null {
  if (!id.startsWith('L') || id.length < 2) return null;
  const digits = id.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  return Number(digits);
}

/**
 * The anchored line's index in `lines`, or null when it is not in the window.
 *
 * Arithmetic, not a scan: ids are consecutive, so the first line's number and
 * the anchor's number give the offset directly. A linear search here would run
 * over 5000 rows on every frame of a streaming agent.
 */
export function indexOfAnchor(anchor: ViewportAnchor, lines: readonly AnsiLine[]): number | null {
  if (anchor.mode === 'tail' || lines.length === 0) return null;
  const first = absoluteOf(lines[0].id);
  const want = absoluteOf(anchor.id);
  if (first === null || want === null) return null;
  const index = want - first;
  return index >= 0 && index < lines.length ? index : null;
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/core/viewportAnchor.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/viewportAnchor.ts src/core/viewportAnchor.test.ts
git commit -m "feat(terminal): add the viewport anchor algebra

Pure and unused. The view adopts it in the next stage."
```

---

## Stage 3 — Adopt the anchor; delete the unreachable compensation

**Files:**
- Modify: `src/components/RawTerminalView.tsx:57,66-69,71-73,264-274,341-364,375-404,406-430`
- Modify: `src/components/RawTerminalView.test.tsx:214-245` — replace the test
  that passes only against an impossible input shape

**Deletions, in full:** `sessionScrollPositions` (`:57`),
`resetSessionScrollPositions` (`:71`), `SCROLL_INTENT_MS` (`:66-69`),
`scrollIntentAtRef`, `gesturing()`, `noteGesture()`, `firstRowRef`
(`:264-274`), and the trim block (`:385-396`).

`resetSessionScrollPositions` is exported. Check for importers before deleting:
`grep -rn "resetSessionScrollPositions" src/` — remove every call site it finds.

- [ ] **Step 1: Replace the misleading test**

Delete `RawTerminalView.test.tsx:214-245` — it asserts
`scrollTop === 300 - 2 * 17` against `row(2), row(3), row(4)`, a first-row
value `getLines()` cannot produce. Replace it with one that uses the real
shape and asserts the reader holds the same *text*:

```tsx
  it('holds a detached reader on the same line while scrollback trims above them', () => {
    // The production shape: getLines() always starts at buffer index 0, so the
    // window's first line carries whatever absolute number it has reached.
    const win = (from: number, count: number) =>
      Array.from({ length: count }, (_, k) => ({
        id: `L${from + k}`, row: from + k, spans: [{ text: `${from + k}` }], timestamp: 0,
      }));
    const rowHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 17 });
    try {
      resetScrollback('trim');
      const props = { ...base, sessionId: 'trim', isActive: true };
      const view = render(<RawTerminalView {...props} lines={win(0, 6)} />);
      const scroller = screen.getByTestId('raw-terminal').firstElementChild as HTMLDivElement;
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 102 },
        clientHeight: { configurable: true, value: 34 },
      });
      fireEvent.wheel(scroller, { deltaY: -100 });
      scroller.scrollTop = 34;           // line L2 at the top of the viewport
      fireEvent.scroll(scroller);
      expect(stateOf('trim').detached).toBe(true);

      // Two lines trimmed: the window now begins at L2, so L2 is index 0.
      view.rerender(<RawTerminalView {...props} lines={win(2, 6)} />);
      expect(scroller.scrollTop).toBe(0);  // same LINE, new pixel
      resetScrollback('trim');
    } finally {
      if (rowHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', rowHeight);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/components/RawTerminalView.test.tsx -t 'same line while scrollback trims'`
Expected: FAIL — `scrollTop` is still 34; nothing re-anchors it.

- [ ] **Step 3: Replace the follow effect**

In `RawTerminalView.tsx`, replace `detachedRef` and the layout effect with an
anchor ref. The effect no longer reads `scrollHeight` to follow; it resolves the
anchor and positions from the anchored row's own `offsetTop`:

```tsx
  const anchorRef = useRef<ViewportAnchor>(TAIL);

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (sessionId) noteTotal(sessionId, lines.length);

    const anchor = anchorRef.current;
    if (anchor.mode === 'tail') {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const index = indexOfAnchor(anchor, lines);
    if (index === null) {
      // The anchored line was trimmed out from under the reader. Following the
      // tail again is the honest answer: the text they were reading is gone,
      // and silently landing them somewhere else would be a guess.
      anchorRef.current = TAIL;
      if (sessionId) reattach(sessionId);
      el.scrollTop = el.scrollHeight;
      return;
    }
    const row = el.querySelector<HTMLElement>(`[data-terminal-line="${index}"]`);
    if (row) el.scrollTop = Math.max(0, row.offsetTop - anchor.offsetPx);
  }, [lines, sessionId]);
```

`handleScroll` sets the anchor from what is actually at the top of the
viewport, and no longer writes a pixel cache:

```tsx
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !sessionId) return;
    const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 24;
    if (atBottom) {
      anchorRef.current = TAIL;
      reattach(sessionId);
      return;
    }
    const rows = el.querySelectorAll<HTMLElement>('[data-terminal-line]');
    let top = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].offsetTop + rows[i].offsetHeight > el.scrollTop) { top = i; break; }
    }
    const line = lines[top];
    if (!line) return;
    anchorRef.current = anchorAt(line.id, rows[top].offsetTop - el.scrollTop);
    detach(sessionId, top);
  };
```

`onWheel` collapses to `onWheel={() => {}}` — delete the handler entirely. The
wheel pre-empt existed only to beat the follow effect to the viewport, and a
tail anchor no longer moves a detached reader.

`End` (`:664-670`) sets `anchorRef.current = TAIL` instead of
`detachedRef.current = false`. Every other `detachedRef.current = true` —
`runViewAction`'s turn-stepping (`:533`) and the search effect (`:556`) — sets
`anchorRef.current = anchorAt(lines[target].id, 0)` instead.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run src/components/RawTerminalView.test.tsx`
Expected: PASS, including the Stage 0 characterization test, which now
describes deleted code — **delete it in this step**, with its reason recorded in
the commit body.

- [ ] **Step 5: Full gate**

Run: `npm run typecheck && npx vitest run`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/RawTerminalView.tsx src/components/RawTerminalView.test.tsx
git commit -m "fix(terminal): anchor the reader to a line, not a scroll pixel

The follow effect re-pinned scrollTop to scrollHeight on every frame and was
defended by a 400ms gesture window, a wheel pre-empt and sixty lines of trim
compensation. The compensation never ran: getLines() always starts at buffer
index 0, so the trimmed delta was always 0 - 0, and its unit test passed only
because it hand-fed a first row getLines() cannot produce.

An anchored line needs none of it."
```

---

## Stage 4 — Smooth scrolling

**Files:**
- Modify: `src/core/viewportAnchor.ts` — add the easing step
- Modify: `src/components/RawTerminalView.tsx` — rAF loop, `overscroll-behavior`
- Test: `src/core/viewportAnchor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('eases toward a target and settles exactly, never asymptotically', () => {
    let at = 0;
    for (let i = 0; i < 200; i++) at = easeScroll(at, 100, 16);
    expect(at).toBe(100);
  });

  it('jumps straight to the target when motion is reduced', () => {
    expect(easeScroll(0, 100, 16, true)).toBe(100);
  });

  it('never overshoots', () => {
    expect(easeScroll(0, 100, 16)).toBeLessThanOrEqual(100);
    expect(easeScroll(100, 0, 16)).toBeGreaterThanOrEqual(0);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/core/viewportAnchor.test.ts -t 'settles exactly'`
Expected: FAIL — `easeScroll` is not exported.

- [ ] **Step 3: Implement**

Append to `src/core/viewportAnchor.ts`:

```ts
/** Time constant, ms. One frame moves ~12% of the remaining distance at 60Hz. */
const EASE_TAU_MS = 120;

/** Below this the remainder is less than a pixel; snap rather than crawl. */
const SNAP_PX = 0.5;

/**
 * One frame of exponential easing toward `target`.
 *
 * Frame-rate independent — the step is derived from elapsed milliseconds, so a
 * dropped frame shows up as a longer step rather than a slower scroll. Snaps
 * inside half a pixel so the loop terminates instead of approaching forever.
 */
export function easeScroll(current: number, target: number, dtMs: number, reduced = false): number {
  if (reduced) return target;
  const remaining = target - current;
  if (Math.abs(remaining) <= SNAP_PX) return target;
  return current + remaining * (1 - Math.exp(-dtMs / EASE_TAU_MS));
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/core/viewportAnchor.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire the rAF loop into the view**

Add to the grid's inline `style` at `RawTerminalView.tsx:772`:

```ts
          overscrollBehavior: 'contain',
```

and drive wheel deltas through the easing loop rather than letting the browser
jump. `prefers-reduced-motion` is read once per gesture:

```tsx
  const scrollTarget = useRef<number | null>(null);
  const scrollFrame = useRef(0);

  const stepScroll = React.useCallback(() => {
    const el = scrollRef.current;
    const target = scrollTarget.current;
    if (!el || target === null) { scrollFrame.current = 0; return; }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const next = easeScroll(el.scrollTop, target, 16, reduced);
    el.scrollTop = next;
    if (next === target) { scrollTarget.current = null; scrollFrame.current = 0; return; }
    scrollFrame.current = requestAnimationFrame(stepScroll);
  }, []);

  useEffect(() => () => { if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current); }, []);
```

The wheel handler becomes:

```tsx
        onWheel={(event) => {
          const el = scrollRef.current;
          if (!el) return;
          event.preventDefault();
          const from = scrollTarget.current ?? el.scrollTop;
          scrollTarget.current = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, from + event.deltaY));
          if (!scrollFrame.current) scrollFrame.current = requestAnimationFrame(stepScroll);
        }}
```

- [ ] **Step 6: Verify by hand in the running app**

Run: `npm run dev`, open a session, run something that produces >200 lines
(`seq 1 500`), and scroll with the wheel.
Expected: motion eases rather than jumping; scrolling up while output streams
holds position; `End` returns to the tail.

- [ ] **Step 7: Commit**

```bash
git add src/core/viewportAnchor.ts src/core/viewportAnchor.test.ts src/components/RawTerminalView.tsx
git commit -m "feat(terminal): ease wheel scrolling instead of jumping

There was no smooth scrolling of any kind; the only scroll-behavior in src/
was an unrelated scrollIntoView in the command palette."
```

---

## Stage 5 — The row window

**Files:**
- Create: `src/core/rowWindow.ts`
- Test: `src/core/rowWindow.test.ts`

Pure arithmetic, nothing imported it yet.

- [ ] **Step 1: Write the failing tests**

Create `src/core/rowWindow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rowWindow } from './rowWindow';

describe('rowWindow', () => {
  it('covers the viewport plus overscan on both sides', () => {
    const w = rowWindow({ firstVisible: 100, viewportRows: 30, overscan: 10, total: 500, rowHeight: 17 });
    expect(w.start).toBe(90);
    expect(w.end).toBe(140);
  });

  it('clamps at the top without negative padding', () => {
    const w = rowWindow({ firstVisible: 2, viewportRows: 30, overscan: 10, total: 500, rowHeight: 17 });
    expect(w.start).toBe(0);
    expect(w.padTopPx).toBe(0);
  });

  it('clamps at the end of the buffer', () => {
    const w = rowWindow({ firstVisible: 480, viewportRows: 30, overscan: 10, total: 500, rowHeight: 17 });
    expect(w.end).toBe(500);
    expect(w.padBottomPx).toBe(0);
  });

  it('padding plus rendered rows always equals the whole buffer height', () => {
    for (const firstVisible of [0, 7, 100, 480, 499]) {
      const w = rowWindow({ firstVisible, viewportRows: 30, overscan: 10, total: 500, rowHeight: 17 });
      expect(w.padTopPx + (w.end - w.start) * 17 + w.padBottomPx).toBe(500 * 17);
    }
  });

  it('renders everything when the buffer is smaller than the viewport', () => {
    const w = rowWindow({ firstVisible: 0, viewportRows: 30, overscan: 10, total: 4, rowHeight: 17 });
    expect(w).toMatchObject({ start: 0, end: 4, padTopPx: 0, padBottomPx: 0 });
  });

  it('renders nothing for an empty buffer rather than dividing by zero', () => {
    const w = rowWindow({ firstVisible: 0, viewportRows: 30, overscan: 10, total: 0, rowHeight: 17 });
    expect(w).toMatchObject({ start: 0, end: 0, padTopPx: 0, padBottomPx: 0 });
  });

  it('renders everything when the row height is not yet measured', () => {
    // Before first layout offsetHeight is 0. Windowing on a zero height would
    // put every row in the same place; render the lot until a real measurement.
    const w = rowWindow({ firstVisible: 0, viewportRows: 30, overscan: 10, total: 500, rowHeight: 0 });
    expect(w).toMatchObject({ start: 0, end: 500, padTopPx: 0, padBottomPx: 0 });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/core/rowWindow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/rowWindow.ts`:

```ts
export interface RowWindowInput {
  /** Index of the first row inside the viewport. */
  firstVisible: number;
  viewportRows: number;
  overscan: number;
  total: number;
  /** Measured line-box height. 0 means "not laid out yet". */
  rowHeight: number;
}

export interface RowWindow {
  /** Inclusive. */
  start: number;
  /** Exclusive. */
  end: number;
  padTopPx: number;
  padBottomPx: number;
}

/**
 * Which rows belong in the DOM.
 *
 * The whole buffer used to be rendered — 5000 elements reconciled on every
 * frame of a streaming agent, and on every keystroke. Two spacer divs stand in
 * for what is not rendered so the scroll height, and therefore every pixel
 * offset the anchor resolves against, is unchanged.
 */
export function rowWindow({ firstVisible, viewportRows, overscan, total, rowHeight }: RowWindowInput): RowWindow {
  if (total <= 0) return { start: 0, end: 0, padTopPx: 0, padBottomPx: 0 };
  // An unmeasured row height cannot place anything. Render everything rather
  // than stack the buffer at offset zero.
  if (rowHeight <= 0) return { start: 0, end: total, padTopPx: 0, padBottomPx: 0 };

  const start = Math.max(0, Math.min(total, firstVisible - overscan));
  const end = Math.max(start, Math.min(total, firstVisible + viewportRows + overscan));
  return {
    start,
    end,
    padTopPx: start * rowHeight,
    padBottomPx: (total - end) * rowHeight,
  };
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/core/rowWindow.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/rowWindow.ts src/core/rowWindow.test.ts
git commit -m "feat(terminal): add row-window arithmetic

Pure and unused. The view adopts it in the next stage."
```

---

## Stage 6 — Virtualize the row list

**Files:**
- Modify: `src/components/RawTerminalView.tsx:762-782` — render a slice
- Modify: `src/components/RawTerminalView.tsx:688-702` — `handleMouseDown`
- Test: `src/components/RawTerminalView.test.tsx`

**The addressing change that makes this safe.** `data-terminal-line={index}`
is the array index today (`:100`), and every query passes array-index values
(`:536`, `:558`, `:696`, `:697`). Once only a slice is rendered, an index
outside the window has no element. Keep the attribute as the array index — the
anchor resolves through it — and make every consumer tolerate a miss.

- [ ] **Step 1: Write the failing tests**

```tsx
  it('renders a window of rows, not the whole buffer', () => {
    const many = Array.from({ length: 2000 }, (_, k) => ({
      id: `L${k}`, row: k, spans: [{ text: `${k}` }], timestamp: 0,
    }));
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 17 });
    render(<RawTerminalView {...base} sessionId="virt" isActive lines={many} />);
    const rendered = screen.getByTestId('raw-terminal').querySelectorAll('[data-terminal-line]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(2000);
  });

  it('selects a command region whose ends are outside the rendered window', () => {
    // commandRegion works on the lines ARRAY, so a region may span rows that
    // are not in the DOM. Resolving it must not silently select nothing.
    const many = Array.from({ length: 2000 }, (_, k) => ({
      id: `L${k}`, row: k, spans: [{ text: `${k}` }], timestamp: 0,
    }));
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 17 });
    const { container } = render(<RawTerminalView {...base} sessionId="sel" isActive lines={many} />);
    const anyRow = container.querySelector('[data-terminal-line]') as HTMLElement;
    fireEvent.mouseDown(anyRow, { detail: 3, ctrlKey: true });
    expect(window.getSelection()?.toString()).not.toBe('');
  });
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/components/RawTerminalView.test.tsx -t 'window of rows'`
Expected: FAIL — all 2000 rows are rendered.

- [ ] **Step 3: Implement the slice**

Replace the `lines.map(...)` block at `:762-782`:

```tsx
        <div style={{ height: `${win.padTopPx}px` }} aria-hidden="true" />
        {lines.slice(win.start, win.end).map((line, offset) => {
          const i = win.start + offset;
          const isCursorHere = isActive && cursor && cursor.visible !== false
            ? (line.row !== undefined ? cursor.row === line.row : cursor.row === i)
            : false;
          return (
            <TerminalLineRow
              key={line.id}
              line={line}
              index={i}
              isMarked={marks.has(i)}
              isCursorHere={isCursorHere}
              cursorCol={isCursorHere ? cursor?.col : undefined}
              cursorGlyph={isCursorHere ? cursor?.glyph : undefined}
              cursorCells={isCursorHere ? cursor?.cells : undefined}
              hasFocus={isCursorHere ? hasFocus : false}
            />
          );
        })}
        <div style={{ height: `${win.padBottomPx}px` }} aria-hidden="true" />
```

with `win` computed above the return:

```tsx
  const [rowHeight, setRowHeight] = useState(0);
  const [firstVisible, setFirstVisible] = useState(0);
  const win = rowWindow({
    firstVisible,
    viewportRows: Math.ceil((scrollRef.current?.clientHeight ?? 0) / Math.max(1, rowHeight)),
    overscan: 20,
    total: lines.length,
    rowHeight,
  });
```

`setRowHeight` is set from the first rendered row in the existing layout effect,
and `setFirstVisible` from `handleScroll`'s computed `top`.

- [ ] **Step 4: Make `handleMouseDown` tolerate rows outside the window**

`:696-697` currently requires both boundary elements to exist. Scroll the
endpoints into the window first, then select:

```tsx
    const bring = (index: number) => {
      const found = scrollRef.current?.querySelector<HTMLElement>(`[data-terminal-line="${index}"]`);
      if (found) return found;
      setFirstVisible(Math.max(0, index - 5));
      return null;
    };
    const start = bring(region.start);
    const end = bring(region.end);
    if (!start || !end) return;   // re-render brought them in; the next click lands
```

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run src/components/RawTerminalView.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full gate**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/RawTerminalView.tsx src/components/RawTerminalView.test.tsx
git commit -m "perf(terminal): render a window of rows, not the whole buffer

lines.map rendered every row it was given. At the 5000-line scrollback limit
that is 5000 elements reconciled per frame of a streaming agent, and per
keystroke, before an echo could paint."
```

---

## Stage 7 — Refused input is reported, never swallowed

**Files:**
- Modify: `src/core/ptyClient.ts:390-395` — already returns a boolean
- Modify: `src/components/RawTerminalView.tsx:25-49,671-675` — `onWrite` returns
- Modify: `src/App.tsx:520,530` — pass the boolean through
- Test: `src/components/RawTerminalView.test.tsx`

`mutate()` returns false whenever the attachment is not `ready`
(`sessionAttachment.ts:277-282`), so `writeToSession` already returns false —
but `handleKeyDown` (`:671-675`) discards it and calls `preventDefault()`
anyway. The keystroke reaches nothing and leaves no trace.

- [ ] **Step 1: Write the failing test**

```tsx
  it('reports a refused keystroke instead of swallowing it', () => {
    const onWrite = vi.fn(() => false);   // attachment not ready
    render(<RawTerminalView {...base} onWrite={onWrite} sessionId="refuse" isActive />);
    fireEvent.keyDown(screen.getByTestId('raw-terminal'), { key: 'a' });
    expect(onWrite).toHaveBeenCalledWith('a');
    expect(screen.getByRole('status').textContent).toMatch(/not accepting input/i);
  });

  it('says nothing when the keystroke was accepted', () => {
    const onWrite = vi.fn(() => true);
    render(<RawTerminalView {...base} onWrite={onWrite} sessionId="ok" isActive />);
    fireEvent.keyDown(screen.getByTestId('raw-terminal'), { key: 'a' });
    expect(screen.queryByRole('status')).toBeNull();
  });
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/components/RawTerminalView.test.tsx -t 'refused keystroke'`
Expected: FAIL — no status element appears.

- [ ] **Step 3: Implement**

`RawTerminalViewProps` (`:27`): `onWrite: (data: string) => boolean | void;`

`:671-675`:

```tsx
    const bytes = keyToBytes(e);
    if (bytes !== null) {
      e.preventDefault();
      if (onWrite(bytes) === false) {
        // No queue and no replay: bytes held now would land in whatever the
        // child is doing by the time it is ready. The same discipline the
        // paste contract sets out. An unknown delivery is reported as unknown.
        setClipboardNotice('Terminal is not accepting input yet; that keystroke was not sent.');
      }
    }
```

In `src/App.tsx` at `:520` and `:530`, the `onWrite` prop must return
`ptyClient.writeToSession(...)`'s boolean rather than discarding it.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/components/RawTerminalView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/RawTerminalView.tsx src/App.tsx src/components/RawTerminalView.test.tsx
git commit -m "fix(terminal): report a refused keystroke rather than swallowing it

mutate() returns false whenever the attachment is not ready, so a key typed
before a session settles reached nothing — while preventDefault ran anyway,
so it left no trace at all. This is one of the two hypotheses for the sticky
first character; it is a defect either way."
```

---

## Stage 8 — The prediction ledger

**Files:**
- Create: `src/core/localEcho.ts`
- Test: `src/core/localEcho.test.ts`

Pure. Nothing imports it yet. Rules are VS Code's, whose defaults are
`localEchoLatencyThreshold: 30` and
`localEchoExcludePrograms: ['vim','vi','nano','tmux']`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { shouldEngage, predict, reconcile, EXCLUDED_PROGRAMS } from './localEcho';

describe('localEcho', () => {
  it('stays disengaged until latency has actually been measured', () => {
    expect(shouldEngage({ rttMs: null, altScreen: false, foreground: null })).toBe(false);
  });

  it('stays disengaged on a fast link', () => {
    expect(shouldEngage({ rttMs: 8, altScreen: false, foreground: null })).toBe(false);
  });

  it('engages above the threshold', () => {
    expect(shouldEngage({ rttMs: 120, altScreen: false, foreground: null })).toBe(true);
  });

  it('never engages on the alternate screen', () => {
    expect(shouldEngage({ rttMs: 400, altScreen: true, foreground: null })).toBe(false);
  });

  it('never engages for a full-screen editor', () => {
    for (const program of EXCLUDED_PROGRAMS) {
      expect(shouldEngage({ rttMs: 400, altScreen: false, foreground: program })).toBe(false);
    }
  });

  it('predicts printable ASCII only', () => {
    expect(predict([], 'a')).toEqual(['a']);
    expect(predict([], '\x1b[A')).toBeNull();
    expect(predict([], '\r')).toBeNull();
    expect(predict([], '\x03')).toBeNull();
  });

  it('lets backspace erase a prediction it made', () => {
    expect(predict(['a', 'b'], '\x7f')).toEqual(['a']);
  });

  it('refuses backspace with nothing of its own to erase', () => {
    // Erasing past our own predictions would delete a character the child
    // actually has, which we cannot see and must not guess about.
    expect(predict([], '\x7f')).toBeNull();
  });

  it('keeps predictions the child confirms, in order', () => {
    expect(reconcile(['a', 'b'], 'ab')).toEqual([]);
    expect(reconcile(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('drops every prediction on the first disagreement', () => {
    expect(reconcile(['a', 'b'], 'x')).toBeNull();
    expect(reconcile(['a'], '\x1b[2J')).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/core/localEcho.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/localEcho.ts`:

```ts
/**
 * Predictive local echo.
 *
 * Over SSH the round trip is the whole of the input latency, and the only
 * thing that touches it is drawing the character before the child confirms it.
 * The rules are VS Code's, which has the field evidence: engage above 30ms,
 * disengage on the alternate screen and for full-screen editors, roll the
 * whole ledger back on any disagreement.
 *
 * ── ON AXIOM 3 ─────────────────────────────────────────────────────────────
 *
 * Painting an unconfirmed character is putting something on screen that the
 * child has not said. It is admissible only because it is VISIBLY a
 * prediction: the view renders these cells in `--st-idle`, one of the five
 * canonical state colours, whose meaning is already "not settled". A stated
 * uncertainty is what Axiom 3 asks for. An unstated one would not be.
 *
 * This layer never changes what is sent. `keyToBytes` still hands the child
 * exactly the bytes it always did.
 */

/** VS Code's `localEchoLatencyThreshold` default. */
export const LATENCY_THRESHOLD_MS = 30;

/** VS Code's `localEchoExcludePrograms` default. */
export const EXCLUDED_PROGRAMS: readonly string[] = ['vim', 'vi', 'nano', 'tmux'];

export interface EchoConditions {
  /** Measured round trip, or null when there is no measurement yet. */
  rttMs: number | null;
  altScreen: boolean;
  /** The kernel's foreground answer, or null when unknown. */
  foreground: string | null;
}

export function shouldEngage({ rttMs, altScreen, foreground }: EchoConditions): boolean {
  // No measurement is not a fast link and not a slow one. It is no answer, and
  // predicting on no answer would be inventing the reason to predict.
  if (rttMs === null) return false;
  if (altScreen) return false;
  if (foreground !== null && EXCLUDED_PROGRAMS.includes(foreground)) return false;
  return rttMs > LATENCY_THRESHOLD_MS;
}

/**
 * The ledger after one keystroke, or null when this key is not predictable.
 *
 * Null is not a failure — it means "send it and wait", which is what the
 * terminal did for every key before this existed.
 */
export function predict(pending: readonly string[], bytes: string): string[] | null {
  if (bytes === '\x7f') {
    // Only ever erase our own. A backspace past the ledger edits a buffer we
    // cannot see.
    return pending.length > 0 ? pending.slice(0, -1) : null;
  }
  if (bytes.length !== 1) return null;
  const code = bytes.charCodeAt(0);
  if (code < 0x20 || code > 0x7e) return null;
  return [...pending, bytes];
}

/**
 * The ledger after the child's own output arrives, or null to roll everything
 * back.
 *
 * Rolling back the WHOLE ledger on one disagreement, rather than resyncing, is
 * deliberate: a partial reconciliation would leave predictions standing that
 * are now attached to the wrong column, and a wrong character drawn
 * confidently is worse than a character drawn late.
 */
export function reconcile(pending: readonly string[], confirmed: string): string[] | null {
  let i = 0;
  for (const ch of confirmed) {
    if (i >= pending.length) break;
    if (ch !== pending[i]) return null;
    i++;
  }
  return pending.slice(i);
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/core/localEcho.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/localEcho.ts src/core/localEcho.test.ts
git commit -m "feat(terminal): add the local-echo prediction ledger

Pure and unused. Rules are VS Code's defaults: 30ms threshold, excluded
programs, whole-ledger rollback on disagreement."
```

---

## Stage 9 — Wire local echo into the view

**Files:**
- Modify: `src/components/RawTerminalView.tsx` — render pending predictions
- Modify: `src/core/ptyClient.ts` — RTT sampling
- Test: `src/components/RawTerminalView.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
  it('paints an unconfirmed keystroke in the unsettled colour, then clears it', () => {
    const onWrite = vi.fn(() => true);
    const view = render(
      <RawTerminalView {...base} onWrite={onWrite} sessionId="echo" isActive
        lines={[{ id: 'L0', row: 0, spans: [{ text: '$ ' }], timestamp: 0 }]}
        echoRttMs={200} />);
    fireEvent.keyDown(screen.getByTestId('raw-terminal'), { key: 'x' });
    const predicted = screen.getByTestId('echo-prediction');
    expect(predicted.textContent).toBe('x');
    expect(predicted).toHaveStyle({ color: 'var(--st-idle)' });

    // The child confirms it; the prediction must disappear rather than double.
    view.rerender(
      <RawTerminalView {...base} onWrite={onWrite} sessionId="echo" isActive
        lines={[{ id: 'L0', row: 0, spans: [{ text: '$ x' }], timestamp: 0 }]}
        echoRttMs={200} />);
    expect(screen.queryByTestId('echo-prediction')).toBeNull();
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/RawTerminalView.test.tsx -t 'unconfirmed keystroke'`
Expected: FAIL — no `echo-prediction` element.

- [ ] **Step 3: Implement**

Hold the ledger in a ref, feed `predict()` from `handleKeyDown` after a
successful `onWrite`, and `reconcile()` from the `lines` layout effect against
the text appended to the cursor's line since the previous frame. Render the
remainder as a span immediately after the cursor:

```tsx
        {pending.length > 0 && (
          <span data-testid="echo-prediction" style={{
            color: 'var(--st-idle)',
            letterSpacing: 'var(--terminal-tracking, 0px)',
          }}>{pending.join('')}</span>
        )}
```

`--terminal-tracking` is mandatory here: this span renders terminal cells, and
without it the predicted text advances by the font's fractional metric and
walks off the grid the caret is on.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/components/RawTerminalView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify against a real remote**

Run: `npm run dev`, SSH to a host with visible latency, type at a prompt.
Expected: characters appear immediately in the dim unsettled colour and
resolve to full ink as the remote confirms them; running `vim` disengages
prediction entirely; `Ctrl+C` is never predicted.

- [ ] **Step 6: Full gate**

Run: `npm run agent:verify`
Expected: every step passes. `hud:check` must still be PASS at 0 mismatched
pixels — this plan never touches the plate.

- [ ] **Step 7: Commit**

```bash
git add src/components/RawTerminalView.tsx src/core/ptyClient.ts src/components/RawTerminalView.test.tsx
git commit -m "feat(terminal): draw unconfirmed keystrokes in the unsettled colour

Over SSH the round trip was the whole of the input latency and nothing
addressed it. Predictions render in --st-idle, which already means unsettled,
so an unconfirmed cell is visibly distinct from a confirmed one."
```

---

## Verification summary

| Stage | Command | Expected |
| :--- | :--- | :--- |
| 0 | `npx vitest run src/components/RawTerminalView.test.tsx` | PASS — documents dead code |
| 1 | `npx vitest run src/core/xtermScreen.test.ts src/core/xtermLines.test.ts` | PASS |
| 2 | `npx vitest run src/core/viewportAnchor.test.ts` | PASS, 6 tests |
| 3 | `npm run typecheck && npx vitest run` | clean |
| 4 | `npx vitest run src/core/viewportAnchor.test.ts` + manual wheel check | PASS, 9 tests |
| 5 | `npx vitest run src/core/rowWindow.test.ts` | PASS, 7 tests |
| 6 | `npm run typecheck && npx vitest run && npm run build` | clean |
| 7 | `npx vitest run src/components/RawTerminalView.test.tsx` | PASS |
| 8 | `npx vitest run src/core/localEcho.test.ts` | PASS, 10 tests |
| 9 | `npm run agent:verify` | all pass, `hud:check` unchanged |

**What this plan does not fix.** The sticky first character is not closed by
Stage 7 alone. Stage 7 removes one of the two hypotheses; the other — an agent
computing its composer geometry from the demuxer's fabricated `CSI 6n` reply —
is Rust, and belongs to
[`2026-09-17-remote-awareness.md`](2026-09-17-remote-awareness.md). Neither
plan may claim the symptom is fixed until a reproduction shows which one caused
it.
