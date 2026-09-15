#!/bin/sh
# Doom Term agent hook.
#
# The vendor runs this in the agent's critical path and hands it the event
# payload on stdin. Everything here is shaped by one rule: NEVER STALL THE
# AGENT. A hook that hangs is a paused agent, and no telemetry is worth that.
#
#   - stdin and HTTP share a 1.8s deadline, with 0.2s forced-kill grace
#   - input is bounded to 64 KiB; oversized events are dropped
#   - all output discarded
#   - exit 0 unconditionally, including when the daemon is not running
#
# The agent name comes from the URL rather than being spliced into the JSON,
# because rewriting arbitrary JSON in POSIX shell is a bug farm and the payload
# must reach the daemon exactly as the vendor wrote it.
#
# Installed by tools/agent-hooks/install.mjs, which appends to the vendor's hook
# config rather than replacing it — see that script for why.

# GNU coreutils on Linux; Homebrew coreutils calls it gtimeout on macOS.
# If neither exists, skip telemetry without even reading stdin. An unbounded
# fallback in an agent's critical path would violate this hook's contract.
if command -v timeout >/dev/null 2>&1; then
  hook_deadline=timeout
elif command -v gtimeout >/dev/null 2>&1; then
  hook_deadline=gtimeout
else
  exit 0
fi

# The timeout owns a separate process group, including the stdin reader and
# curl. Do not use --foreground: that would leave grandchildren unbounded.
{
  LC_ALL=C "$hook_deadline" --kill-after=0.2s 1.8s sh -c '
    agent=$1
    port=$2
    pane=$3
    incarnation=$4
    # The sentinel preserves trailing newlines through command substitution.
    payload=$(head -c 65537 && printf .) || exit 0
    payload=${payload%.}
    [ -n "$payload" ] && [ "${#payload}" -le 65536 ] || exit 0

    # The pane id is inherited from the PTY, never spliced into vendor JSON.
    if [ -n "$pane" ]; then
      set -- --header "X-Doom-Term-Session: $pane"
    else
      set --
    fi
    if [ -n "$pane" ] && [ -n "$incarnation" ]; then
      set -- "$@" --header "X-Doom-Term-Incarnation: $incarnation"
    fi
    # --disable must be first: user curl defaults can add URLs or output files.
    # A loopback event must also never take an inherited proxy route.
    printf "%s" "$payload" | curl --disable \
      --silent --noproxy "*" --max-time 2 --request POST \
      --header "Content-Type: application/json" "$@" --data-binary @- \
      "http://127.0.0.1:${port}/hook/${agent}"
  ' sh "${1:-unknown}" "${DOOM_PORT:-1421}" "${DOOM_TERM_SESSION_ID:-}" "${DOOM_TERM_INCARNATION:-}"
} >/dev/null 2>&1

exit 0
