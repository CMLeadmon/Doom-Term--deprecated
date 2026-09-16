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

if [ -n "$FILE" ]; then
  if [ ! -f "$FILE" ]; then
    echo "Error: File not found: $FILE" >&2
    exit 1
  fi
  if is_image_file "$FILE" || [ "$TYPE" = "image" ]; then
    TYPE="image"
    MIME=$(get_image_mime "$FILE")
    if command -v base64 >/dev/null 2>&1; then
      B64=$(base64 "$FILE" 2>/dev/null | tr -d '\r\n')
    elif command -v python3 >/dev/null 2>&1; then
      B64=$(python3 -c 'import sys, base64; sys.stdout.write(base64.b64encode(open(sys.argv[1], "rb").read()).decode("ascii"))' "$FILE")
    elif command -v node >/dev/null 2>&1; then
      B64=$(node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]).toString("base64"))' "$FILE")
    else
      echo "Error: base64 utility required to encode image file" >&2
      exit 1
    fi
    CONTENT="data:${MIME};base64,${B64}"
  else
    CONTENT=$(cat "$FILE")
  fi
else
  # Read from stdin
  CONTENT=$(cat)
fi

if [ -z "$CONTENT" ]; then
  echo "Error: Artifact content is empty" >&2
  exit 1
fi

# Build JSON payload using python or node if available, or lightweight sed escaping
if command -v node >/dev/null 2>&1; then
  PAYLOAD=$(node -e '
    const [title, type, id, openPane, content] = process.argv.slice(1);
    const body = {
      title,
      type,
      content,
      open_pane: openPane === "true",
    };
    if (id) body.id = id;
    process.stdout.write(JSON.stringify(body));
  ' "$TITLE" "$TYPE" "$ID" "$OPEN_PANE" "$CONTENT")
elif command -v python3 >/dev/null 2>&1; then
  PAYLOAD=$(python3 -c '
import sys, json
title, atype, aid, open_pane, content = sys.argv[1:]
body = {
    "title": title,
    "type": atype,
    "content": content,
    "open_pane": open_pane == "true",
}
if aid:
    body["id"] = aid
sys.stdout.write(json.dumps(body))
' "$TITLE" "$TYPE" "$ID" "$OPEN_PANE" "$CONTENT")
else
  # Fallback: simple string escaping
  ESCAPED_CONTENT=$(printf '%s' "$CONTENT" | awk '{gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\r/, ""); printf "%s\\n", $0}' | sed '$ s/\\n$//')
  PAYLOAD=$(printf '{"title":"%s","type":"%s","open_pane":%s,"content":"%s"}' "$TITLE" "$TYPE" "$OPEN_PANE" "$ESCAPED_CONTENT")
fi

HEADERS="Content-Type: application/json"
if [ -n "${DOOM_TERM_SESSION_ID:-}" ]; then
  RESPONSE=$(curl --disable --silent --noproxy "*" --max-time 4 --request POST \
    --header "$HEADERS" \
    --header "X-Doom-Term-Session: ${DOOM_TERM_SESSION_ID}" \
    --data-binary "$PAYLOAD" \
    "http://127.0.0.1:${PORT}/artifact" || true)
else
  RESPONSE=$(curl --disable --silent --noproxy "*" --max-time 4 --request POST \
    --header "$HEADERS" \
    --data-binary "$PAYLOAD" \
    "http://127.0.0.1:${PORT}/artifact" || true)
fi

if [ -n "$RESPONSE" ]; then
  echo "$RESPONSE"
else
  echo "Artifact published to http://127.0.0.1:${PORT}/artifact"
fi
