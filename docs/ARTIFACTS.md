# Doom Term: Artifacts Subsystem

An equivalent to **Claude Code Artifacts** engineered natively for Doom Term.

Artifacts allow autonomous AI agents (`claude`, `codex`, `gemini`, `agy`), developer scripts, and CLI tools to transform complex multi-step terminal work—such as PR walkthroughs, incident reports, code refactoring diffs, and interactive dashboards—into live, standalone visual views.

---

## ⚡ Core Capabilities

1. **Integrated In-App Split Panes (`kind: 'artifact'`)**:
   - Rendered natively in Doom Term's binary `PaneTree`.
   - Formatted Markdown with code syntax blocks, task checkboxes, tables, GitHub-style alerts (`[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), and embedded inline images (`![alt](url)`).
   - Unified/split Git diff viewer with file summary cards, green additions (`--st-pass`), red deletions (`--st-fail`), and hunk stats.
   - Dedicated Image Viewer (`type: 'image'`) with FIT / 1:1 original toggle, dimension readout, and transparency checkerboard.
   - HTML / Web application previews.
2. **Local Daemon Serving & Instant Live Reload**:
   - Every artifact is hosted on loopback at `http://127.0.0.1:1421/artifact/:id`.
   - Standalone pages connect to the daemon's WebSocket and automatically reload when the agent updates the artifact.
   - Raw source accessible at `http://127.0.0.1:1421/artifact/:id/raw`.
3. **Strict Four-Material Compliance**:
   - Striated neutral grey plate header (`--plate`), recessed well (`--ground`, `--ground-2`), hard 1px bevel pair (`--bevel-up`, `--bevel-dn`), and contrast-guarded ink.
   - Zero border radius and pure Unicode glyphs (`❖`, `⑂`, `▤`, `↗`, `×`).
   - Zero blurred shadows or soft material utility classes.

---

## 🛠️ How to Publish Artifacts

### 1. From the Terminal via CLI (`doom-term-artifact`)

**No repository clone required.** Whenever Doom Term launches, the background daemon automatically provisions `doom-term-artifact` into `~/.local/bin/` and ensures it is present on `$PATH` in every child shell:

```bash
# Push a Markdown PR walkthrough (with optional inline ![Alt](url) images)
doom-term-artifact --title "PR Walkthrough" --type markdown report.md

# Publish an image directly (auto-detects PNG/JPEG/SVG/GIF/WebP and base64 encodes)
doom-term-artifact --title "Architecture Diagram" architecture.png

# Pipe Git diff directly to a live diff pane
git diff | doom-term-artifact --title "Refactor Diff" --type diff

# Push an interactive HTML dashboard
cat dashboard.html | doom-term-artifact --title "Test Metrics" --type html

# Update an existing artifact by passing its ID
doom-term-artifact --id "auth-refactor" --title "Updated Auth Diff" --type diff auth.patch
```

*In isolated containers or remote environments, you can also fetch or pipe the CLI helper directly from the running daemon without installing anything:*
```bash
curl -fsSL http://127.0.0.1:1421/doom-term-artifact | sh -s -- --title "Container Log" build.log
```

### 2. From Any Language or Process via HTTP API

The daemon listens on `http://127.0.0.1:1421`:

```http
POST /artifact HTTP/1.1
Host: 127.0.0.1:1421
Content-Type: application/json
X-Doom-Term-Session: <optional_session_id>

{
  "id": "my-artifact-id",
  "title": "Incident Root Cause Analysis",
  "type": "markdown",
  "content": "# Incident RCA\n\nTimeline of events...",
  "open_pane": true
}
```

**Response (`200 OK`)**:
```json
{
  "id": "my-artifact-id",
  "title": "Incident Root Cause Analysis",
  "type": "markdown",
  "version": 1,
  "url": "http://127.0.0.1:1421/artifact/my-artifact-id"
}
```

### 3. From Doom Term Command Palette (`Ctrl+K`)

- Press `Ctrl+K` (or `Ctrl+Shift+P`).
- Select **"Create Blank Artifact Pane"**.
- View or edit the artifact directly inside the split pane.
