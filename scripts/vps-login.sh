#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

if [[ "${1:-}" != '--display' ]]; then
  for tool in xvfb-run xauth x11vnc websockify openbox curl; do
    command -v "$tool" >/dev/null || { echo "Missing $tool. See SETUP.md."; exit 1; }
  done
  [[ $(id -u) != 0 ]] || { echo 'Run browser login as the scraper user, not root.'; exit 1; }
  [[ -f .auth/vnc.passwd ]] || { echo 'Create .auth/vnc.passwd first. See SETUP.md.'; exit 1; }
  exec xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' bash "$0" --display "$@"
fi
shift
fresh=()
if [[ "${1:-}" == '--fresh' ]]; then fresh=(--fresh); shift; fi
[[ $# == 0 ]] || { echo 'Unsupported login option.'; exit 1; }

log=.auth/remote-login.log
: > "$log"
pids=()
login_pid=''
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$login_pid" ]]; then
    kill -TERM "$login_pid" 2>/dev/null || true
    wait "$login_pid" 2>/dev/null || true
  fi
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
openbox >> "$log" 2>&1 &
pids+=($!)
x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -localhost \
  -rfbport "${LOGIN_VNC_PORT:-5901}" -rfbauth .auth/vnc.passwd -forever -shared >> "$log" 2>&1 &
pids+=($!)
websockify --web=/usr/share/novnc "127.0.0.1:${LOGIN_DESKTOP_PORT:-6081}" \
  "127.0.0.1:${LOGIN_VNC_PORT:-5901}" >> "$log" 2>&1 &
pids+=($!)
ready=false
for attempt in {1..100}; do
  for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null || exit 1; done
  if curl --fail --silent --max-time 2 "http://127.0.0.1:${LOGIN_DESKTOP_PORT:-6081}/vnc.html" >/dev/null; then ready=true; break; fi
  sleep 0.2
done
[[ "$ready" == true ]] || exit 1
echo 'TV_LOGIN_DESKTOP_READY'
"${TV_LOGIN_NODE:-node}" --env-file-if-exists=.env src/login.js \
  --config local --timeout "${LOGIN_TIMEOUT_SECONDS:-1200}" "${fresh[@]}" >> "$log" 2>&1 &
login_pid=$!
# Detect failed display processes while the user completes login.
while kill -0 "$login_pid" 2>/dev/null; do
  for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null || exit 1; done
  sleep 1
done
result=0
wait "$login_pid" || result=$?
login_pid=''
exit "$result"
