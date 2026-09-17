# Window Chrome: Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the OS titlebar with a 28px top bar drawn in the four materials, carrying the agent marks, the title, and `−` `□` `×` — and delete the floating agents indicator it replaces.

**Architecture:** One shared mark renderer extracted from `hud/plate.js` serves both the plate and the bar, so an agent has one colour and one glyph. The bar is a plain React component that works in the browser build; the desktop shell adds `tauri-plugin-decorum` for Windows Snap Layouts and resize, which `decorations: false` alone breaks.

**Tech Stack:** React 19, Tauri v2.2, `tauri-plugin-decorum` 1.1.1, Vitest 3 + jsdom.

**Spec:** [`../specs/2026-09-17-remote-and-render-design.md`](../specs/2026-09-17-remote-and-render-design.md) — Track C.

**Branch**: `feat/remote-enhancement`
**Started**: 2026-09-17

**This plan owns `src-tauri/`, `src/components/TitleBar.tsx`,
`src/components/AgentQueueIndicator.tsx` and `src/hud/plate.js`'s mark table.**
It does not touch `RawTerminalView.tsx`, `backend/` or `crates/`.

**Coordination hazard, verified 2026-09-17.** Seven other live worktrees exist
on this repository, several named for overlapping UI surface —
`.worktrees/bottom-right-panel-redesign`, `.worktrees/frontend-ui-audit-and-fixes`,
`.worktrees/ui-best-practices-alignment`, `.worktrees/visual-bugs-diagnosis`,
`.claude/worktrees/waiting-bar-two-columns`. Run `git worktree list` and check
for in-flight changes to `plate.js`, `App.tsx` and `AgentQueueIndicator.tsx`
before Stage 1.

---

## Global Constraints

**Visual invariants — enforced automatically.**
`src/components/FrontendVisualIntegrity.test.tsx:14-53` walks every `.tsx` and
`.jsx` file under `src/` that does not contain `.test.` in its name and fails on
`shadow-(sm|md|lg|xl|2xl|inner)`, `backdrop-blur`, or `rounded(-\w+)?`. **A new
component anywhere under `src/` is swept with no registration.** Note what that
sweep does *not* catch: `ring-2`, `animate-pulse` and `transition-all` all pass
it today, and `AgentQueueIndicator.tsx` uses all three.

**The fifteen material tokens** are `--plate`, `--ground`, `--ground-2`,
`--bevel-up`, `--bevel-dn`, `--ink`, `--ink-tan`, `--ink-dim`, `--ink-plate`,
`--st-live`, `--st-pass`, `--st-fail`, `--st-wait`, `--st-idle`, `--mono`
(`src/styles/material.css:1-34`). The bar uses these and nothing else — no
literal hex.

**Axiom 1 is the hard one here.** The terminal keeps the keyboard. Every control
in the bar carries `tabIndex={-1}` and cancels `mousedown`, or a click on the
close button moves focus out of the pane and the next keystroke goes nowhere.

**Axiom 2 is amended by the spec**, not evaded: the plate remains the only
persistent *application* chrome; window management gets a strip. Still no tab
strips, no sidebars, no floating toolbars — and this plan removes one.

**`src-tauri` does not build on the bare host.** `webkit2gtk-4.1` is absent
(`pkg-config --exists webkit2gtk-4.1` fails). Use the toolbox, verified running
2026-09-17 with webkit2gtk-4.1 2.52.3, glib 2.84.4, dbus-1 1.16.0, cargo 1.98.0:

```bash
podman exec --user "$USER" -w "$PWD" \
  doom-tauri bash -lc '<command>'
```

A missing-system-package outcome is an **ENVIRONMENT BLOCK** — neither a pass
nor a compile failure. Never report it as either.

---

## File Structure

| File | Responsibility |
| :--- | :--- |
| `src/hud/agentMark.js` **(new)** | One agent, one mark, one colour. Extracted from `plate.js` so the plate and the bar cannot disagree. |
| `src/components/TitleBar.tsx` **(new)** | The 28px strip: marks, drag region, controls. |
| `src/components/TitleBar.test.tsx` **(new)** | Invariants, focus discipline, mark parity. |
| `src/components/AgentQueueIndicator.tsx` | **Deleted** in Stage 5. |
| `src-tauri/tauri.conf.json:22` | `decorations: false`. |
| `src-tauri/capabilities/default.json` | The window permissions decorum needs. |
| `src-tauri/src/lib.rs:12-13` | The `.plugin(...)` call. |

---

## Stage 1 — One agent colour table

**Files:**
- Modify: `src/hud/plate.js:122-133`
- Test: `src/hud/plate.test.js` (runner: `node --test`, **not** vitest)

**The live defect.** `plate.js`'s `AGENT_COLORS` has nine keys and no `agy`,
while `MARKS.agy = MARKS.antigravity` exists at `plate.js:395`. `markTones`
(`:163`) falls back to `C.tan` for an unknown key, so an `agy` session **today**
draws Antigravity's prism in the shell's tan. `AgentQueueIndicator.tsx:72`
has `agy: '#d8ecff'` and renders it correctly. Folding the marks together
without fixing this silently changes that agent's colour.

- [ ] **Step 1: Write the failing test**

```js
test('every mark key has a colour, so no agent falls back to the shell tan', () => {
  for (const key of Object.keys(MARKS)) {
    if (key === 'shell' || key === 'terminal' || key === 'bash'
        || key === 'zsh' || key === 'fish' || key === 'none') continue;
    assert.ok(AGENT_COLORS[key], `${key} draws a vendor mark with no vendor colour`);
  }
});

test('agy and antigravity are the same product and the same colour', () => {
  assert.equal(AGENT_COLORS.agy, AGENT_COLORS.antigravity);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test src/hud/plate.test.js`
Expected: FAIL — `agy draws a vendor mark with no vendor colour`.

- [ ] **Step 3: Implement**

`plate.js:122-133`, after the `antigravity` entry:

```js
  // agy is the binary, antigravity the product — the same colour, as
  // MARKS.agy is the same prism. Without this an agy session drew the prism
  // in the shell's tan, because markTones falls back to C.tan for a key with
  // no colour.
  agy: '#d8ecff',
```

- [ ] **Step 4: Run and watch it pass, and confirm the plate is unchanged**

Run: `node --test src/hud/plate.test.js && npm run hud:check`
Expected: PASS, and `hud:check` still 0 mismatched px — `DEFAULT_STATE.agent`
is `'shell'`, so the reference render never draws an `agy` mark.

- [ ] **Step 5: Commit**

```bash
git add src/hud/plate.js src/hud/plate.test.js
git commit -m "fix(hud): give agy its vendor colour

MARKS.agy has drawn Antigravity's prism since it was added, but AGENT_COLORS
had no agy key, so markTones fell back to the shell's tan and the mark came
out the wrong colour. AgentQueueIndicator's private table had it right, which
is how the two disagreed."
```

---

## Stage 2 — One mark renderer

**Files:**
- Create: `src/hud/agentMark.js`
- Modify: `src/hud/plate.js:804-811` — call the extracted function
- Test: `src/hud/agentMark.test.js`

**Interfaces:**
- Produces: `drawAgentMark(surface, key, cx, cy, pulse)` — renders one mark
  centred on `(cx, cy)`; `markSurface(key, size, pulse)` — a standalone
  `Surface` for a component to paint into a canvas.
- Consumes: `MARKS`, `AGENT_COLORS`, `markTones`, `Surface`, `px` — all already
  exported from `plate.js:896`.

**A trap the inventory found.** `MARKS` entries have inconsistent arity:
`gemini` (`:331`), `codex` (`:340`) and `opencode` (`:348`) are declared
`(s, cx, cy, col)` while the rest take `(s, cx, cy, col, dim)`. The single call
site passes five arguments and JS drops the extra. Preserve that — do **not**
"fix" the signatures, which would change three marks' rendering and move the
HUD baseline for no reason.

- [ ] **Step 1: Write the failing tests**

```js
test('draws every known agent without throwing, whatever its arity', () => {
  for (const key of Object.keys(MARKS)) {
    const s = markSurface(key, 24, undefined);
    assert.equal(s.w, 24);
    assert.ok(s.data.some((b) => b !== 0), `${key} drew nothing`);
  }
});

test('an unknown key draws the shell mark, never another vendor\'s logo', () => {
  const unknown = markSurface('not-a-real-agent', 24, undefined);
  const shell = markSurface('shell', 24, undefined);
  assert.deepEqual([...unknown.data], [...shell.data]);
});

test('a still mark and a pulsing mark differ', () => {
  const still = markSurface('claude', 24, undefined);
  const lit = markSurface('claude', 24, 0.5);
  assert.notDeepEqual([...still.data], [...lit.data]);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test src/hud/agentMark.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/hud/agentMark.js`:

```js
import { MARKS, AGENT_COLORS, markTones, Surface } from './plate.js';

/**
 * One agent, one mark, one colour — for every surface that draws one.
 *
 * The plate and the title bar each used to carry their own agent table, and
 * they disagreed: two colour maps with different values, one set of bitmap
 * marks and one set of hand-drawn SVG paths. An agent's identity is not a
 * per-component decision.
 */
export function drawAgentMark(surface, key, cx, cy, pulse) {
  const tones = markTones(key, pulse);
  // An unrecognised key is not an excuse to draw someone else's logo.
  const mark = MARKS[key] || MARKS.shell;
  // Arity varies: gemini, codex and opencode take no `dim`. Pass both anyway,
  // exactly as plate.js:811 does — JS drops the extra argument.
  mark(surface, cx, cy, tones.core, tones.dim);
  return surface;
}

/** A standalone surface holding one mark, for a component to paint. */
export function markSurface(key, size, pulse) {
  const surface = Surface(size, size);
  return drawAgentMark(surface, key, size / 2, size / 2, pulse);
}

export { AGENT_COLORS };
```

`plate.js:811` becomes a call into it, keeping `well()` and `shockRing()` where
they are — those are plate furniture, not the mark.

- [ ] **Step 4: Run, and confirm the plate is byte-identical**

Run: `node --test src/hud/agentMark.test.js && npm run hud:check`
Expected: PASS and **0 mismatched pixels**. This stage is a pure extraction; a
single changed pixel means the refactor changed behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/hud/agentMark.js src/hud/agentMark.test.js src/hud/plate.js
git commit -m "refactor(hud): extract one agent-mark renderer

Pure extraction — hud:check is unchanged at 0 mismatched pixels."
```

---

## Stage 3 — The bar itself

**Files:**
- Create: `src/components/TitleBar.tsx`, `src/components/TitleBar.test.tsx`

Built and tested as a plain React component first. It renders in `npm run dev`
with no Tauri at all, so every invariant is provable before the desktop shell
is touched.

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TitleBar } from './TitleBar';

const node = (id: string, agent: string | null) => ({
  id, title: `S ${id}`, kind: 'terminal' as const, cwd: '/', gitBranch: '',
  foregroundAgent: agent, parked: false,
});

describe('TitleBar', () => {
  it('draws one mark per agent session and no label', () => {
    render(<TitleBar nodes={[node('a', 'claude'), node('b', 'codex')]}
      activeSessionId="a" onSelectNode={() => {}} title="Doom Term" />);
    expect(screen.getAllByTestId('agent-mark')).toHaveLength(2);
    expect(screen.queryByText(/AGENTS/i)).toBeNull();
  });

  it('never takes the keyboard from the terminal', () => {
    // Axiom 1. A control that can be focused is a control that swallows the
    // next keystroke, and the pane has no way to say why.
    render(<TitleBar nodes={[node('a', 'claude')]} activeSessionId="a"
      onSelectNode={() => {}} title="Doom Term" />);
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('tabindex')).toBe('-1');
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('uses only material tokens, never a literal colour', () => {
    const { container } = render(<TitleBar nodes={[]} activeSessionId={null}
      onSelectNode={() => {}} title="Doom Term" />);
    const inline = container.innerHTML.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(inline).toEqual([]);
  });

  it('carries a drag region for the window', () => {
    const { container } = render(<TitleBar nodes={[]} activeSessionId={null}
      onSelectNode={() => {}} title="Doom Term" />);
    expect(container.querySelector('[data-tauri-drag-region]')).not.toBeNull();
  });

  it('selects the session whose mark was clicked', () => {
    const onSelectNode = vi.fn();
    render(<TitleBar nodes={[node('a', 'claude')]} activeSessionId={null}
      onSelectNode={onSelectNode} title="Doom Term" />);
    fireEvent.click(screen.getAllByTestId('agent-mark')[0]);
    expect(onSelectNode).toHaveBeenCalledWith('a');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/components/TitleBar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/components/TitleBar.tsx`:

```tsx
import React, { useEffect, useRef } from 'react';
import { SessionNode } from '../types/sessionTree';
import { isWorking } from '../core/activityMonitor';
import { markSurface } from '../hud/agentMark';
import { pulsePhase } from '../hud/state';

const BAR_H = 28;
const MARK = 20;

export interface TitleBarProps {
  nodes: SessionNode[];
  activeSessionId: string | null;
  onSelectNode: (nodeId: string) => void;
  title: string;
  onMinimize?: () => void;
  onToggleMaximize?: () => void;
  onClose?: () => void;
}

/**
 * One agent mark, painted from the plate's own bitmap.
 *
 * Integer scale only, for the same reason the plate scales at 2 or 3:
 * fractional scaling interpolates and destroys a 1px bitmap. jsdom has no 2D
 * context, so every path here degrades to drawing nothing rather than throwing.
 */
const AgentMark: React.FC<{ agentKey: string; pulse?: number }> = ({ agentKey, pulse }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const surface = markSurface(agentKey, MARK, pulse);
    const scale = 2;
    canvas.width = MARK * scale;
    canvas.height = MARK * scale;
    const image = ctx.createImageData(MARK, MARK);
    image.data.set(surface.data);
    const off = document.createElement('canvas');
    off.width = MARK;
    off.height = MARK;
    off.getContext('2d')?.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, MARK * scale, MARK * scale);
  }, [agentKey, pulse]);
  return <canvas ref={ref} style={{ width: MARK, height: MARK, display: 'block' }} />;
};

export const TitleBar: React.FC<TitleBarProps> = ({
  nodes, activeSessionId, onSelectNode, title,
  onMinimize, onToggleMaximize, onClose,
}) => {
  const agents = nodes.filter((n) => !n.parked && (n.foregroundAgent || n.kind === 'agent'));

  /*
     Axiom 1: the terminal keeps the keyboard.

     tabIndex={-1} alone is not enough — a click focuses an element without
     ever consulting the tab order, and a focused button swallows the next
     keystroke with nothing on screen to say why. That is exactly how the
     pass-through terminal failed before it took focus on activation.
  */
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  const CONTROLS: ReadonlyArray<[string, (() => void) | undefined, string]> = [
    ['\u2212', onMinimize, 'Minimize'],
    ['\u25a1', onToggleMaximize, 'Maximize'],
    ['\u00d7', onClose, 'Close'],
  ];

  return (
    <div
      className="flex items-stretch plate select-none"
      style={{ height: BAR_H, boxShadow: 'var(--bevel-up)' }}
    >
      <div className="flex items-center gap-px pl-1">
        {agents.map((node) => (
          <button
            key={node.id}
            type="button"
            tabIndex={-1}
            data-testid="agent-mark"
            title={`${node.number ? `[${node.number}] ` : ''}${node.title}`}
            onMouseDown={keepFocus}
            onClick={() => onSelectNode(node.id)}
            className="flex items-center justify-center px-1"
            style={{
              height: BAR_H - 6,
              background: 'transparent',
              boxShadow: node.id === activeSessionId ? 'var(--bevel-dn)' : 'none',
            }}
          >
            <AgentMark
              agentKey={(node.foregroundAgent || 'agy').toLowerCase()}
              pulse={isWorking(node.id) ? pulsePhase(Date.now()) : undefined}
            />
          </button>
        ))}
      </div>

      {/* The drag region is the title, which is the one part of a titlebar
          that has nothing else to do. */}
      <div
        data-tauri-drag-region
        className="flex-1 flex items-center justify-center text-[11px] tracking-wider"
        style={{ color: 'var(--ink-plate)' }}
      >
        {title.toUpperCase()}
      </div>

      <div className="flex items-stretch">
        {CONTROLS.map(([glyph, run, label]) => (
          <button
            key={label}
            type="button"
            tabIndex={-1}
            aria-label={label}
            onMouseDown={keepFocus}
            onClick={() => run?.()}
            className="w-[34px] flex items-center justify-center text-[13px] leading-none"
            style={{ color: 'var(--ink-plate)', background: 'transparent' }}
          >
            {glyph}
          </button>
        ))}
      </div>
    </div>
  );
};
```

The controls are Unicode glyphs — `−` U+2212, `□` U+25A1, `×` U+00D7 — per
the no-icon-libraries rule. `data-testid="agent-mark"` sits on the **button**,
not the canvas, so the mark count is assertable in jsdom where there is no 2D
context to paint into.

**`FrontendVisualIntegrity.test.tsx:14-53` sweeps this file automatically**, so
no `rounded-*`, no `shadow-sm|md|lg|xl|2xl|inner`, no `backdrop-blur`. Also
avoid `ring-*`, `animate-*` and `transition-*`: that sweep does not catch them,
and they are what made the old indicator drift out of the system.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/components/TitleBar.test.tsx && npx vitest run src/components/FrontendVisualIntegrity.test.tsx`
Expected: PASS, both.

- [ ] **Step 5: Commit**

```bash
git add src/components/TitleBar.tsx src/components/TitleBar.test.tsx
git commit -m "feat(ui): add the top bar

Not mounted yet. Marks come from the plate's own table, so the bar cannot
disagree with the plate about what colour an agent is."
```

---

## Stage 4 — The desktop shell *(spike, then wire)*

**Files:**
- Modify: `src-tauri/Cargo.toml:15`, `src-tauri/src/lib.rs:12-13`,
  `src-tauri/tauri.conf.json:22`, `src-tauri/capabilities/default.json`

**Why a spike.** `decorations: false` alone loses window resize on Windows even
with `resizable: true` ([tauri-apps/tauri#8519](https://github.com/tauri-apps/tauri/issues/8519)).
`tauri-plugin-decorum` 1.1.1 solves it, but its `create_overlay_titlebar()`
**injects its own control buttons** (`button.decorum-tb-btn`,
`button#decorum-tb-minimize`, `#decorum-tb-maximize`, `#decorum-tb-close`) which
are then restyled via CSS. Whether those can be restyled into the four materials
decides which of the two branches below is taken. Both are written out; do not
improvise a third.

- [ ] **Step 1: Add the dependency and register the plugin**

`src-tauri/Cargo.toml`, after `tauri-plugin-notification = "2.2"`:
```toml
# decorations:false alone loses resize and Snap Layouts on Windows
# (tauri-apps/tauri#8519). This keeps both while allowing a custom strip.
tauri-plugin-decorum = "1.1"
```

`src-tauri/src/lib.rs`, immediately after line 13
(`.plugin(tauri_plugin_notification::init())`):
```rust
        .plugin(tauri_plugin_decorum::init())
```

`src-tauri/capabilities/default.json` — append to the `"permissions"` array,
which currently holds exactly `"core:default"`, `"shell:default"`,
`"notification:default"`:
```json
    "core:window:allow-close",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-is-maximized",
    "core:window:allow-start-dragging",
    "decorum:allow-show-snap-overlay"
```

- [ ] **Step 2: Compile in the toolbox**

```bash
podman exec --user "$USER" -w "$PWD" \
  doom-tauri bash -lc 'cargo check --manifest-path src-tauri/Cargo.toml'
```
Expected: compiles. A missing system package here is an ENVIRONMENT BLOCK, not
a failure — but the toolbox was verified to have all four on 2026-09-17, so an
environment block at this step means the container changed and should be
investigated rather than worked around.

- [ ] **Step 3: Run the spike and record the answer**

```bash
podman exec --user "$USER" -w "$PWD" \
  doom-tauri bash -lc 'npm run tauri dev'
```
With `decorations: false` in `tauri.conf.json:22` and
`main_window.create_overlay_titlebar()` in the `setup` closure, answer both:

1. Can `button.decorum-tb-btn` and the three id selectors be restyled to the
   plate materials — square corners, bevel pair, `--ink-plate` glyphs?
2. Do resize borders and Windows Snap Layouts survive?

Write the answer into this file under this step before continuing.

- [ ] **Step 4a: If decorum's buttons restyle cleanly — take this branch**

Keep `create_overlay_titlebar()`. `TitleBar.tsx` renders marks and the drag
region only, and its own `− □ ×` are **removed**; decorum's buttons are styled
in `material.css`:

```css
/* decorum injects the window controls so Snap Layouts and the resize borders
   survive decorations:false. They are ours to paint: square, bevelled, ink on
   plate — the same four materials as everything else. */
div[data-tauri-decorum-tb] { background: var(--plate); box-shadow: var(--bevel-up); height: 28px; }
button.decorum-tb-btn { border-radius: 0; background: transparent; color: var(--ink-plate); }
button.decorum-tb-btn:hover { box-shadow: var(--bevel-dn); }
```

Delete the three control buttons and their tests from `TitleBar.test.tsx`; keep
every other assertion.

- [ ] **Step 4b: If they cannot be restyled — take this branch instead**

Do **not** call `create_overlay_titlebar()`. Keep `TitleBar.tsx`'s own glyph
buttons and drive them through the already-present `@tauri-apps/api`
(`package.json:27`), which has no window plumbing wired anywhere in `src/` yet:

```ts
import { getCurrentWindow } from '@tauri-apps/api/window';
const win = getCurrentWindow();
// minimize / toggleMaximize / close
```

Keep the decorum plugin registered anyway, solely for
`decorum:allow-show-snap-overlay` on hover of the maximize glyph — that is the
one Windows affordance a hand-rolled control cannot reproduce. Add a
`cfg(windows)` note in `lib.rs` recording that resize borders are decorum's, not
ours.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/ src/components/TitleBar.tsx src/components/TitleBar.test.tsx src/styles/material.css
git commit -m "feat(shell): custom window chrome, with Snap Layouts intact

decorations:false alone loses resize on Windows even with resizable:true
(tauri-apps/tauri#8519); decorum keeps both. Records which branch the spike
took and why."
```

---

## Stage 5 — Mount the bar, delete the indicator

**Files:**
- Modify: `src/App.tsx:28` (import), `:573` (layout), `:580` (the call site)
- Delete: `src/components/AgentQueueIndicator.tsx`

`AgentQueueIndicator` has exactly one call site — `App.tsx:580` — and no test
file references it by name, so the deletion is clean.

- [ ] **Step 1: Write the failing test**

Add to `src/components/FrontendVisualIntegrity.test.tsx`, which already imports
`fs` and `path` (`:3-4`). An existence check, not a read — `readFileSync` on a
missing file throws rather than returning a falsy value, so it cannot express
"this must be gone":

```tsx
  it('no longer ships the floating agents indicator', () => {
    expect(fs.existsSync(path.resolve(__dirname, 'AgentQueueIndicator.tsx'))).toBe(false);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/FrontendVisualIntegrity.test.tsx -t 'floating agents indicator'`
Expected: FAIL — the file exists.

- [ ] **Step 3: Implement**

`App.tsx:573` — the bar becomes the first child of the outer column, above the
`flex-1` content div at `:579`:

```tsx
    <div className="flex flex-col h-screen w-screen overflow-hidden select-none font-mono" style={{ background: 'var(--ground)' }}>
      <div className="shrink-0">
        <TitleBar
          nodes={workspaceNodes}
          activeSessionId={activeGroup.activeNodeId}
          onSelectNode={handleSelectNode}
          title="Doom Term"
        />
      </div>
      <SessionModeNotice sessionId={activeNode?.id ?? null} />
```

Remove the `<AgentQueueIndicator .../>` block at `:580-584` and the import at
`:28`. Then `rm src/components/AgentQueueIndicator.tsx`.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: clean. `npm run build` matters here — the bundler catches a dangling
import that `tsc --noEmit` can miss.

- [ ] **Step 5: Verify by eye**

Run: `npm run dev`. Confirm the bar sits above the terminal, marks appear for
agent sessions only, clicking a mark switches session, the terminal keeps the
caret throughout, and nothing floats over the pane.

- [ ] **Step 6: Commit**

```bash
git add -A src/App.tsx src/components/
git commit -m "feat(ui): fold the agent marks into the top bar

AgentQueueIndicator floated over the terminal at absolute top-2 right-4 —
persistent chrome that Axiom 2 forbids and that was never granted an
exception. It also carried its own agent colour table, its own hand-drawn
SVGs, and animate-pulse, ring-2 and transition-all, none of which the
visual-integrity sweep catches."
```

---

## Stage 6 — Full gate

- [ ] **Step 1: Run everything**

```bash
npm run agent:verify
```
Expected: typecheck, test, build, hud:check, cargo:check, cargo:test all pass.

- [ ] **Step 2: Run the Tauri check in the toolbox, not on the host**

```bash
podman exec --user "$USER" -w "$PWD" \
  doom-tauri bash -lc 'npm run check:tauri'
```
Expected: pass. On the bare host this step prints ENVIRONMENT BLOCK, which is
neither a pass nor a failure — `agent:verify`'s own `check:tauri` will do
exactly that here, and that is expected rather than a regression.

- [ ] **Step 3: Confirm the HUD baseline never moved**

```bash
npm run hud:check
```
Expected: PASS, 0 mismatched px. This plan must not move it; only the remote
plan's Stage 7 may.

---

## Verification summary

| Stage | Command | Expected |
| :--- | :--- | :--- |
| 1 | `node --test src/hud/plate.test.js && npm run hud:check` | PASS, 0 mismatched px |
| 2 | `node --test src/hud/agentMark.test.js && npm run hud:check` | PASS, byte-identical plate |
| 3 | `npx vitest run src/components/TitleBar.test.tsx` | PASS, 5 tests |
| 4 | `podman exec … doom-tauri … cargo check --manifest-path src-tauri/Cargo.toml` | compiles; spike answer recorded |
| 5 | `npx vitest run && npm run typecheck && npm run build` | clean |
| 6 | `npm run agent:verify` + toolbox `check:tauri` | all pass |
