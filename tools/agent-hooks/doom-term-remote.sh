#!/bin/sh
# Doom Term remote enrichment.  # doom-term-hook
#
# Source this from your ~/.bashrc (or ~/.zshrc) ON THE REMOTE MACHINE, and
# Doom Term's status plate will report that machine's host, user, shell,
# directory and branch instead of the laptop's.
#
# It emits iTerm2's documented SetUserVar once per prompt, so it is inert in
# iTerm2, kitty and WezTerm — they set a variable they ignore — rather than
# printing in every terminal that is not Doom Term.
#
# Generated from remote_enrichment_snippet() in
# crates/doom-term-pty/src/shell_integration.rs. The two are one wire format;
# a test asserts they agree.

if [ -z "$DOOM_TERM_BOOTSTRAPPED" ]; then export DOOM_TERM_BOOTSTRAPPED=1; __doom_remote() { __dq() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }; __db=$(git --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null); __dj=$(printf '{"v":1,"host":"%s","user":"%s","shell":"%s","cwd":"%s","branch":"%s"}' "$(__dq "$(hostname -s 2>/dev/null)")" "$(__dq "$USER")" "$(__dq "$(basename "${SHELL:-sh}")")" "$(__dq "$PWD")" "$(__dq "$__db")" | base64 | tr -d '\n'); printf '\033]1337;SetUserVar=doomterm=%s\007' "$__dj"; }; PROMPT_COMMAND="__doom_remote${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi
