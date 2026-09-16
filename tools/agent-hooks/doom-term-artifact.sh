#!/bin/sh
# Doom Term Artifact Publisher.
#
# Allows autonomous agents (Claude Code, Gemini, Codex) or developer shell
# scripts to publish rich interactive artifacts (Markdown, HTML, Diff, Dashboard)
# into Doom Term.
#
# Usage:
#   doom-term-artifact --title "PR Walkthrough" --type markdown report.md
#   git diff | doom-term-artifact --title "Git Diff" --type diff
#   cat dashboard.html | doom-term-artifact --title "Test Metrics" --type html
#
# Options:
#   --title <text>    Human-readable title (default: "Artifact")
#   --type <type>     Content type: markdown | html | diff | dashboard | image (default: markdown)
#   --id <id>         Stable artifact id for updates (optional)
#   --no-open         Do not automatically open a split pane in Doom Term
#   --port <port>     Daemon port (defaults to $DOOM_PORT or 1421)

set -e

TITLE="Artifact"
TYPE="markdown"
ID=""
OPEN_PANE=true
PORT="${DOOM_PORT:-1421}"
FILE=""

is_image_file() {
  case "$1" in
    *.png|*.PNG|*.jpg|*.JPG|*.jpeg|*.JPEG|*.gif|*.GIF|*.webp|*.WEBP|*.svg|*.SVG|*.bmp|*.BMP|*.ico|*.ICO)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

get_image_mime() {
  case "$1" in
    *.png|*.PNG) echo "image/png" ;;
    *.jpg|*.JPG|*.jpeg|*.JPEG) echo "image/jpeg" ;;
    *.gif|*.GIF) echo "image/gif" ;;
    *.webp|*.WEBP) echo "image/webp" ;;
    *.svg|*.SVG) echo "image/svg+xml" ;;
    *.bmp|*.BMP) echo "image/bmp" ;;
    *.ico|*.ICO) echo "image/x-icon" ;;
    *) echo "image/png" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --title)
      TITLE="$2"
      shift 2
      ;;
    --type)
      TYPE="$2"
      shift 2
      ;;
    --id)
      ID="$2"
      shift 2
      ;;
    --no-open)
      OPEN_PANE=false
      shift
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Doom Term Artifact Publisher

Usage:
  doom-term-artifact [options] [file]
  echo "..." | doom-term-artifact [options]

Options:
  --title <text>    Human-readable title (default: "Artifact")
  --type <type>     Content type: markdown | html | diff | dashboard | image (default: markdown)
  --id <id>         Stable artifact id for updates (optional)
  --no-open         Do not automatically open a split pane in Doom Term
  --port <port>     Daemon port (defaults to $DOOM_PORT or 1421)
  -h, --help        Show this help message

Examples:
  doom-term-artifact --title "PR Walkthrough" report.md
  doom-term-artifact --title "Architecture Diagram" architecture.png
  git diff | doom-term-artifact --title "Git Diff" --type diff
EOF
      exit 0
      ;;
    *)
      if [ -z "$FILE" ]; then
        FILE="$1"
        shift
      else
        echo "Unknown argument: $1" >&2
        exit 1
      fi
      ;;
  esac
done

TMP_PAYLOAD=$(mktemp 2>/dev/null || mktemp -t doom_artifact.XXXXXX)
trap 'rm -f "$TMP_PAYLOAD"' EXIT INT TERM

if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const [title, type, id, openPane, filePath, outPath] = process.argv.slice(1);
    let rawContent;
    try {
      rawContent = filePath ? fs.readFileSync(filePath) : fs.readFileSync(0);
    } catch (e) {
      process.stderr.write("Error reading input: " + e.message + "\n");
      process.exit(1);
    }
    const extMatch = filePath ? filePath.match(/\.[^.]+$/) : null;
    const ext = extMatch ? extMatch[0].toLowerCase() : "";
    const mimes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".bmp": "image/bmp",
      ".ico": "image/x-icon",
    };
    let isImage = type === "image" || Boolean(mimes[ext]);
    let mime = mimes[ext] || "image/png";
    let content;
    let finalType = isImage ? "image" : (type || "markdown");
    if (isImage) {
      content = `data:${mime};base64,${rawContent.toString("base64")}`;
    } else {
      content = rawContent.toString("utf8");
    }
    if (!content) {
      process.stderr.write("Error: Artifact content is empty\n");
      process.exit(1);
    }
    const body = {
      title,
      type: finalType,
      content,
      open_pane: openPane === "true",
    };
    if (id) body.id = id;
    fs.writeFileSync(outPath, JSON.stringify(body));
  ' "$TITLE" "$TYPE" "$ID" "$OPEN_PANE" "$FILE" "$TMP_PAYLOAD"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c '
import sys, json, os, mimetypes, base64
title, atype, aid, open_pane, file_path, out_path = sys.argv[1:]
if file_path:
    with open(file_path, "rb") as f:
        raw_content = f.read()
else:
    raw_content = sys.stdin.buffer.read()

ext = os.path.splitext(file_path)[1].lower() if file_path else ""
image_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}
is_image = atype == "image" or ext in image_exts
mime = mimetypes.guess_type(file_path)[0] or "image/png" if is_image else None

if is_image:
    content = f"data:{mime};base64,{base64.b64encode(raw_content).decode(\"ascii\")}"
    final_type = "image"
else:
    content = raw_content.decode("utf-8", errors="replace")
    final_type = atype or "markdown"

if not content:
    sys.stderr.write("Error: Artifact content is empty\n")
    sys.exit(1)

body = {
    "title": title,
    "type": final_type,
    "content": content,
    "open_pane": open_pane == "true",
}
if aid:
    body["id"] = aid

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(body, f)
' "$TITLE" "$TYPE" "$ID" "$OPEN_PANE" "$FILE" "$TMP_PAYLOAD"
else
  # Fallback for simple small inputs
  if [ -n "$FILE" ]; then
    CONTENT=$(cat "$FILE")
  else
    CONTENT=$(cat)
  fi
  ESCAPED_CONTENT=$(printf '%s' "$CONTENT" | awk '{gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\r/, ""); printf "%s\\n", $0}' | sed '$ s/\\n$//')
  printf '{"title":"%s","type":"%s","open_pane":%s,"content":"%s"}' "$TITLE" "$TYPE" "$OPEN_PANE" "$ESCAPED_CONTENT" > "$TMP_PAYLOAD"
fi

HEADERS="Content-Type: application/json"
if [ -n "${DOOM_TERM_SESSION_ID:-}" ]; then
  RESPONSE=$(curl --disable --silent --noproxy "*" --max-time 6 --request POST \
    --header "$HEADERS" \
    --header "X-Doom-Term-Session: ${DOOM_TERM_SESSION_ID}" \
    --data-binary "@$TMP_PAYLOAD" \
    "http://127.0.0.1:${PORT}/artifact" || true)
else
  RESPONSE=$(curl --disable --silent --noproxy "*" --max-time 6 --request POST \
    --header "$HEADERS" \
    --data-binary "@$TMP_PAYLOAD" \
    "http://127.0.0.1:${PORT}/artifact" || true)
fi

if [ -n "$RESPONSE" ]; then
  echo "$RESPONSE"
else
  echo "Artifact published to http://127.0.0.1:${PORT}/artifact"
fi
