## What changes, and why

<!-- The behaviour before and after. If this fixes something, say what the
     failure looked like from outside — that is what a reader needs to tell a
     fix from a rewrite. -->

## Verification

<!-- What you ran, and what it said. Not "tests pass" — which tests, on which
     platform. -->

- [ ] `npm run agent:verify` passes
- [ ] `cargo fmt --all --check` and `cargo clippy --all-targets -- -D warnings` pass
- [ ] New behaviour has a test that fails without the change

## Invariants

Confirm any that this change touches — see [CONTRIBUTING.md](../CONTRIBUTING.md):

- [ ] **Never invent telemetry.** An unknown metric renders `--`, never `0`, `0%` or `idle`
- [ ] **The terminal stays pass-through.** Plain `Ctrl` keys belong to the child process
- [ ] **Four materials.** Zero border radius, hard 1px bevels, the five state colours, no icon libraries
- [ ] **Integer cell metrics.** Terminal surfaces apply `--terminal-tracking`, canvas scales at integer ratios

## Platforms

<!-- Which platforms did you actually run this on? A cross-platform change
     checked only on Linux is not a problem — saying so is what lets a reviewer
     know where to look. Windows and macOS rows in the README's table stay 🚧
     until someone confirms them on hardware. -->

- [ ] Linux
- [ ] macOS
- [ ] Windows
