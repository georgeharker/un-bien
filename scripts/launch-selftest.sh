#!/bin/zsh
# un-bien launch self-test — apes the launcher daemon's tmux launch path.
# THROWAWAY debug harness (plan 01M4YEYVNHMYX1PE8XWB3QZNNQ): tight-loop the
# launch failure, then delete this file. Three modes, each narrowing the
# failure class one step:
#   ./launch-selftest.sh                          # 1: your real env
#   env -i HOME=$HOME USER=$USER ./launch-selftest.sh   # 2: launchd-like ENV
#   ./launch-selftest.sh --launchd               # 3: real launchd SESSION
# Mode 1 passing + mode 3 hanging = the launchd-session class (keychain /
# SecurityAgent) — the live hypothesis.
set -u
NAME=${NAME:-selftest}
SESS=un-bien
ME="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
LOG="$HOME/.local/state/un-bien/launch-selftest.log"

step() { print -r -- "\n===== $* =====" }

if [ "${1:-}" = "--launchd-inner" ]; then
  # Inner half of mode 3: run under launchd, everything to the log.
  {
    print -r -- "===== launchd session run: $(date -Iseconds) ====="
    print -r -- "env SHELL: ${SHELL:-<unset>}  PATH: ${PATH:-<unset>}"
  } >> "$LOG"
  exec "$0" >> "$LOG" 2>&1
fi

if [ "${1:-}" = "--launchd" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.georgeharker.unbien.selftest.plist"
  mkdir -p "$(dirname "$LOG")"
  : > "$LOG"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.georgeharker.unbien.selftest</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>${ME}</string><string>--launchd-inner</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${HOME}</string>
    <key>USER</key><string>${USER}</string>
  </dict>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  print -r -- "launchd job submitted — capturing to $LOG (tail -f it in another pane)"
  sleep 10
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
  print -r -- "===== captured log ====="
  cat "$LOG"
  exit 0
fi

# ── the daemon's exact path, step by step, everything inline ──────────────

step "1. resolve launch shell (config→\$SHELL→dscl→zsh)"
SHELL_BIN="${UNBIEN_LAUNCH_SHELL:-${SHELL:-$(dscl . -read "/Users/${USER}" UserShell 2>/dev/null | awk '{print $2}')}}"
SHELL_BIN="${SHELL_BIN:-/bin/zsh}"
print -r -- "resolved shell: $SHELL_BIN"

step "2. has-session probe (wrapped: '\$SHELL' -l -c 'exec tmux has-session')"
"$SHELL_BIN" -l -c "exec tmux has-session -t ${SESS}"
PROBE=$?
print -r -- "probe exit: $PROBE  (0 = session exists → new-window path)"

step "3. the exact argv"
PANE="'${SHELL_BIN}' '-l' -c 'exec env UNBIEN_LAUNCH_REQ=selftest pi -n ${NAME}'"
if [ $PROBE -eq 0 ]; then
  TMUX_CMD="new-window -t ${SESS} -n ${NAME} -- ${PANE}"
else
  TMUX_CMD="new-session -d -s ${SESS} -n ${NAME} -- ${PANE}"
fi
print -r -- "pane command:  ${PANE}"
print -r -- "wrapped call:  ${SHELL_BIN} -l -c 'exec tmux ${TMUX_CMD}'"

step "4. fire it — stdio INHERITED, stderr + exit stream HERE"
"$SHELL_BIN" -l -c "exec tmux ${TMUX_CMD}"
print -r -- "wrapped command exit: $?  (nonzero = tmux-level failure, now visible)"

step "5. tmux state after"
tmux list-sessions 2>&1

print -r -- "\nDone. If a window exists: check its pane (tmux capture-pane -t ${SESS} -p)."
print -r -- "If step 4 HANGS (no output): that is the launchd-session hang — Ctrl-C and compare modes."