# Contributing to Doom Term

Thank you for your interest in contributing to **Doom Term**!

## 📜 Code of Conduct & Design Principles

Doom Term follows a strict set of design and engineering principles:

1. **Zero Border Radius**: Every element enforces `* { border-radius: 0 }`. Never introduce rounded corners or soft pill buttons.
2. **Hard 1px Bevels Only**: Depth is produced solely via `--bevel-up` and `--bevel-dn`. No blurred box-shadows or drop-shadow filters.
3. **Calibrated Colors (WCAG 2.1 AA Guaranteed)**:
   - Live: `--st-live: #e0a92c`
   - Passed: `--st-pass: #5c9c3a`
   - Failed: `--st-fail: #ef4136`
   - Waiting: `--st-wait: #5b8ae8`
   - Idle: `--st-idle: #847c6e`
4. **Integer Plate Scaling**: Plate rendering must scale at discrete integer multiples (`1x`, `2x`, `3x`, `4x`), never fractional values.
5. **No Icon Libraries**: Use plain Unicode / ASCII glyphs (`▸`, `▪`, `×`, `⚖`, `❖`, `⑂`) to preserve retro sharpness without runtime asset bloat.
6. **Pass-Through Terminal Ownership**: Plain `Ctrl` keys belong to child processes. Supervisor actions use `Ctrl+Shift`, `Ctrl+K`, or `Ctrl+1..9`.

---

## 🛠️ Development & Verification Workflow

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run full verification before submitting a PR:
   ```bash
   # Unified verification command for agents and contributors:
   npm run agent:verify

   # Or run individual verification suites:
   npm run typecheck         # TypeScript compiler check
   npm test                  # Pure Node tests and Vitest component suites
   npm run hud:check         # Pixel-exact HUD canvas regression check
   cargo check --workspace   # Rust workspace compilation check
   cargo test --workspace    # Rust workspace unit and integration tests
   npm run check:tauri       # The desktop shell. Exit 2 is an ENVIRONMENT
                             # BLOCK — a missing system package — and is
                             # neither a pass nor a failure.
   ```
3. Formatting and lints are a separate CI job, and `agent:verify` does not
   cover them:
   ```bash
   cargo fmt --all --check
   cargo clippy --all-targets -- -D warnings
   ```
   Clippy is a ratchet. The lints that predate its adoption are allowed by name
   in the workspace `Cargo.toml`, so everything else is denied — adding to that
   list is a deliberate act, not a side effect.
4. Building and packaging are documented separately in
   [`docs/BUILDING.md`](docs/BUILDING.md), and cutting a release in
   [`docs/RELEASING.md`](docs/RELEASING.md).
3. Consult [`AGENTS.md`](AGENTS.md) and [`docs/README.md`](docs/README.md) for architectural invariants and system specifications.

