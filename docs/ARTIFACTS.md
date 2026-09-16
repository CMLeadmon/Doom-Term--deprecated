# Doom Term: Artifacts Subsystem

An equivalent to **Claude Code Artifacts** engineered natively for Doom Term.

Artifacts allow autonomous AI agents (`claude`, `codex`, `gemini`, `agy`), developer scripts, and CLI tools to transform complex multi-step terminal work—such as PR walkthroughs, incident reports, code refactoring diffs, and interactive dashboards—into live, standalone visual views.

---

## ⚡ Core Capabilities

1. **Integrated In-App Split Panes (`kind: 'artifact'`)**:
   - Rendered natively in Doom Term's binary `PaneTree`.
   - Formatted Markdown with code syntax blocks, task checkboxes, tables, and GitHub-style alerts (`[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`).
   - Unified/split Git diff viewer with file summary cards, green additions (`--st-pass`), red deletions (`--st-fail`), and hunk stats.
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

### 1. From the Terminal via CLI (`doom-term-artifact.sh`)

Any child shell running inside Doom Term has `doom-term-artifact.sh` available in `tools/agent-hooks/`:

```bash
# Push a Markdown PR walkthrough
tools/agent-hooks/doom-term-artifact.sh --title "PR Walkthrough" --type markdown report.md

# Pipe Git diff directly to a live diff pane
git diff | tools/agent-hooks/doom-term-artifact.sh --title "Refactor Diff" --type diff

# Push an interactive HTML dashboard
cat dashboard.html | tools/agent-hooks/doom-term-artifact.sh --title "Test Metrics" --type html

# Update an existing artifact by passing its ID
tools/agent-hooks/doom-term-artifact.sh --id "auth-refactor" --title "Updated Auth Diff" --type diff auth.patch
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
