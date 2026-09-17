# Doom Term Documentation Portal & System Taxonomy

Welcome to the **Doom Term** documentation portal. This directory and its subdirectories contain the architectural specifications, design system references, implementation maps, and historical evolution logs of Doom Term.

---

## 🗺️ Documentation Taxonomy & Status

To prevent specification drift and ensure autonomous coding agents and human contributors reference the correct source of truth, documentation is categorized by operational status:

```
Doom Term Documentation
├── 🟢 Active / Authoritative (Current Production Truth)
│   ├── AGENTS.md (Repo Root)                -> Operational directives & invariants for AI agents
│   ├── README.md (Repo Root)                -> User-facing product overview, quickstart & 10 Reformation UX capabilities
│   ├── CONTRIBUTING.md (Repo Root)          -> Contribution guidelines, material rules, verification checklist
│   ├── CHANGELOG.md (Repo Root)             -> Per-release changes, and the limitations each release ships with
│   ├── docs/BUILDING.md                     -> Prerequisites, dev loop, cross-compiling for Windows
│   ├── docs/RELEASING.md                    -> Cutting a release; verifying checksums and provenance
│   └── docs/REFORMATION_AGENT_REVIEW.md     -> Component entry points, test proofs, and review contracts
│
├── 🎨 Design System & Visual Testing
│   ├── docs/design/reference/               -> Discrete PNG reference baselines (plate-480@1x.png, plate-480@4x.png)
│   └── docs/design/ds/                      -> HTML component proofs and material specimen
│
├── 📜 Chronological Evolution (Specs & Plans)
│   ├── docs/superpowers/specs/              -> Approved milestone design specifications (2026-08-28 to 2026-09-01)
│   └── docs/superpowers/plans/              -> Detailed execution checklists and phased implementation plans
│
└── 📦 Historical Archive (Pre-Reformation Feasibility Studies)
    └── DOOM_TERM_BLUEPRINT.md (Repo Root)   -> Initial August 2026 conceptual study (superseded by Reformation)
```

---

## 🟢 1. Active & Authoritative Documentation

### [`AGENTS.md`](../AGENTS.md)
* **Status**: **Authoritative Ground Truth for AI Agents**
* **Audience**: Autonomous coding agents (Claude Code, Gemini, Codex, Antigravity, OpenCode, Cursor).
* **Contents**:
  * Four Core Axioms (Pass-through terminal, status plate as only chrome, observed telemetry only, four materials and no fifth).
  * Design invariants (Zero border-radius, 1px hard bevels, 5 canonical WCAG AA state colors, integer cell metrics).
  * System architecture topology (PTY crate, daemon, desktop Tauri shell, frontend).
  * Keymap ownership contract (`src/core/keymap.ts`).
  * Agent hooks infrastructure (`tools/agent-hooks/doom-term-hook.sh`).
  * Unified development & verification commands (`npm run agent:verify`).

### [`README.md`](../README.md)
* **Status**: **Authoritative Product & Quickstart Guide**
* **Audience**: End users, developers, and evaluators.
* **Contents**:
  * Vision, quickstart installation, desktop sidecar vs browser execution.
  * The Classic Status Bar (STBAR) developer telemetry mapping.
  * The 10 Reformation UX capabilities.
  * Keyboard shortcut reference table.

### [`docs/REFORMATION_AGENT_REVIEW.md`](REFORMATION_AGENT_REVIEW.md)
* **Status**: **Feature & Review Contract Map**
* **Audience**: Code reviewers and agents verifying PRs.
* **Contents**:
  * Mapping of each of the 10 Reformation UX improvements to exact production source files and test files:
    1. Attention queue & acknowledgement policy ([`src/core/attentionQueue.ts`](../src/core/attentionQueue.ts))
    2. Routed native notifications ([`src/core/sessionNotifications.ts`](../src/core/sessionNotifications.ts))
    3. Attention-first / MRU `Ctrl+K` session switcher ([`src/core/sessionSwitcher.ts`](../src/core/sessionSwitcher.ts))
    4. Terminal clipboard contract & trusted turn selection ([`src/core/terminalSelection.ts`](../src/core/terminalSelection.ts))
    5. Navigable turn marks ([`src/core/turnMarks.ts`](../src/core/turnMarks.ts))
    6. Developer quick select overlay ([`src/core/quickSelect.ts`](../src/core/quickSelect.ts))
    7. Binary split pane tree persistence ([`src/core/paneTree.ts`](../src/core/paneTree.ts))
    8. Spatial focus navigation & transient pane labels ([`src/components/PaneSelectOverlay.tsx`](../src/components/PaneSelectOverlay.tsx))
    9. Safe process termination: PARK vs KILL ([`src/core/sessionClose.ts`](../src/core/sessionClose.ts))
    10. Durable tmux session discovery & explicit recovery ([`src/core/sessionRecovery.ts`](../src/core/sessionRecovery.ts))
  * Persistence schema changes (`SessionNode` telemetry fields, `PaneTree` binary union).

### [`CONTRIBUTING.md`](../CONTRIBUTING.md)
* **Status**: **Active Guidelines for Contributions**
* **Contents**:
  * Material design invariants and contrast constraints.
  * Pre-PR verification checklist (`npm run agent:verify`).

---

## 🎨 2. Design System & Visual Regression Testing

* **[`docs/design/reference/`](design/reference/)**:
  Contains pixel-exact PNG renders of the Status Plate (`plate-480@1x.png`, `plate-480@4x.png`).
  - Run `npm run hud:check` to automatically compare actual canvas render against reference baselines.
  - Run `npm run hud:ref` to regenerate reference baselines when intentional Status Bar layout changes are made.
* **[`src/styles/material.css`](../src/styles/material.css)** & **[`src/styles/material.test.js`](../src/styles/material.test.js)**:
  Single CSS variable declarations for plate, recess, bevel, and state tokens, coupled with automated tests calculating WCAG 2.1 AA relative luminance and verifying the global `border-radius: 0` reset.

---

## 📜 3. Chronological Milestone Specifications & Plans

Located in [`docs/superpowers/`](superpowers/):
* **`specs/`**:
  * `2026-08-28-doom-term-review.md`: Clean-slate review establishing core axioms.
  * `2026-08-29-doom-term-terminal-foundation-design.md`: Terminal emulation and integer cell geometry.
  * `2026-08-31-agent-question-detection.md`: Vendor agent hooks and question interception.
  * `2026-09-01-reformation-design.md`: 10 core Reformation UX capabilities.
* **`plans/`**:
  * Step-by-step implementation checklists for each corresponding specification.

---

## 📦 4. Historical Archive

* **[`DOOM_TERM_BLUEPRINT.md`](../DOOM_TERM_BLUEPRINT.md)**:
  * Contains the initial August 2026 concept feasibility study.
  * **Note**: Pre-Reformation speculative features (Warp-like DOM block cards, Doomguy facial sprites, weapon ammo counters, WebGL CRT shaders, multi-lens review panels) have been superseded by the production Reformation architecture. Retained for historical context.
