#!/usr/bin/env bash
# Runs sidemaid in a real Claude Code session and keeps what the terminal shows:
# after the reply (did the pane open by itself?), after /mermaid, and after
# paging back one diagram.
#
#   live-check.sh tmux  <columns> <rows>   screen text, no pictures (alt text instead)
#   live-check.sh iterm <columns> <rows>   screenshots of a new iTerm2 window (macOS)
#
# Env: LIVE_CHECK_CWD   folder the session starts in; Claude Code must trust it (default: $HOME)
#      LIVE_CHECK_OUT   where snapshots go (default: $TMPDIR/sidemaid-live-check)
#      LIVE_CHECK_MODEL model for the reply (default: haiku)
set -euo pipefail

MODE=${1:?usage: live-check.sh tmux|iterm <columns> <rows>}
COLS=${2:?columns}
ROWS=${3:?rows}
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN=$(git -C "$HERE" rev-parse --show-toplevel)
CWD=${LIVE_CHECK_CWD:-$HOME}
OUT=${LIVE_CHECK_OUT:-${TMPDIR:-/tmp}/sidemaid-live-check}
MODEL=${LIVE_CHECK_MODEL:-haiku}
ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
NAME="$MODE-${COLS}x$ROWS"
RUN="$OUT/$NAME"

rm -rf "$RUN" && mkdir -p "$RUN/cache"

# A fresh cache: every run renders with mmdc instead of reusing a PNG.
cat >"$RUN/run.sh" <<EOF
cd $(printf %q "$CWD")
export XDG_CACHE_HOME=$(printf %q "$RUN/cache")
exec claude --plugin-dir $(printf %q "$PLUGIN") --model $(printf %q "$MODEL") \\
  --session-id $ID -n live-check --debug-file $(printf %q "$RUN/debug.log") \\
  "\$(cat $(printf %q "$HERE/prompt.md"))"
EOF

if [ "$MODE" = tmux ]; then
  SESSION="live-check-$$"
  start() { tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" "bash $(printf %q "$RUN/run.sh")"; }
  screen() { tmux capture-pane -p -t "$SESSION"; }
  type_line() { tmux send-keys -t "$SESSION" -l "$1" && sleep 0.5 && tmux send-keys -t "$SESSION" Enter; }
  press() { tmux send-keys -t "$SESSION" "$1"; }
  snap() { screen >"$RUN/$1.txt"; }
  stop() { tmux kill-session -t "$SESSION" 2>/dev/null || true; }
elif [ "$MODE" = iterm ]; then
  WINDOW=$(osascript <<EOF
tell application "iTerm2"
  set w to (create window with default profile)
  tell current session of w
    set columns to $COLS
    set rows to $ROWS
  end tell
  return id of w
end tell
EOF
)
  in_session() { osascript -e "tell application \"iTerm2\" to tell current session of (window id $WINDOW) to $1"; }
  start() { in_session "write text \"bash $RUN/run.sh\""; }
  screen() { in_session "get contents"; }
  type_line() { in_session "write text \"$1\""; }
  press() { in_session "write text \"$1\" newline no"; }
  # screencapture runs from Terminal.app, so only Terminal.app needs the Screen
  # Recording permission; -l captures the iTerm2 window even where covered.
  pgrep -x Terminal >/dev/null && TERMINAL_RAN=yes || TERMINAL_RAN=no
  snap() {
    local tab
    tab=$(osascript -e "tell application \"Terminal\" to do script \"screencapture -x -o -l $WINDOW '$RUN/$1.png'; exit\"")
    for _ in $(seq 1 20); do [ -s "$RUN/$1.png" ] && break; sleep 0.5; done
    osascript -e "tell application \"Terminal\" to close (window id ${tab##*window id })" >/dev/null 2>&1 || true
    [ -s "$RUN/$1.png" ] || echo "no screenshot for $1: does Terminal.app have the Screen Recording permission?" >&2
    screen >"$RUN/$1.txt"
  }
  stop() {
    osascript -e "tell application \"iTerm2\" to close (window id $WINDOW)" >/dev/null 2>&1 || true
    [ "$TERMINAL_RAN" = yes ] || osascript -e 'tell application "Terminal" to quit' >/dev/null 2>&1 || true
  }
else
  echo "mode is tmux or iterm" >&2
  exit 2
fi

cleanup() {
  stop
  # The session was only a probe: drop its transcript, once it has stopped writing it.
  sleep 3
  rm -rf "$HOME"/.claude/projects/*/"$ID".jsonl "$HOME"/.claude/projects/*/"$ID"
}
trap cleanup EXIT

wait_for() { # <grep pattern> <seconds>
  local i=0
  while [ "$i" -lt "$2" ]; do
    screen | grep -q -- "$1" && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

rendered() { find "$RUN/cache" -name '*.png' | wc -l | tr -d ' '; }

start
if wait_for "trust the files\|one you trust" 8; then
  snap 0-trust
  echo "Claude Code asks to trust $CWD: trust it once, or set LIVE_CHECK_CWD" >&2
  exit 1
fi

wait_for "Mermaid #2" 120 || { snap 9-timeout; echo "no reply with two diagrams within 120 s" >&2; exit 1; }
for _ in $(seq 1 60); do [ "$(rendered)" -ge 2 ] && break; sleep 1; done
sleep 2
snap 1-auto

type_line "/mermaid"
sleep 3
snap 2-asked

press p
sleep 2
snap 3-prev

type_line "/exit"
sleep 1

echo "rendered PNGs: $(rendered)"
grep -i "sidemaid" "$RUN/debug.log" | grep -iE "fail|skip|refus|error" | head -20 >"$RUN/hook-problems.txt" || true
echo "hook problems: $(wc -l <"$RUN/hook-problems.txt" | tr -d ' ') (see $RUN/hook-problems.txt)"
echo "snapshots in $RUN"
ls "$RUN"
