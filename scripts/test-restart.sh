#!/usr/bin/env bash
# 回归 restart.sh 的本机探测：即使环境里有 HTTP_PROXY，所有 localhost 请求也必须
# 显式 --noproxy，不能把「代理暂时连不上刚重启的服务」误报成「服务没起来」。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"

cleanup() {
  if [ -f "$TMP/server.pid" ]; then kill "$(cat "$TMP/server.pid")" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

cat > "$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RESTART_TEST_TMP/npm.log"
exit 0
EOF

cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

cat > "$FAKE_BIN/server" <<'EOF'
#!/usr/bin/env bash
echo $$ > "$RESTART_TEST_TMP/server.pid"
trap 'exit 0' TERM INT
while :; do sleep 1; done
EOF

cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
has_noproxy=0
url=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--noproxy" ] && [ "${2:-}" = "*" ]; then
    has_noproxy=1
    shift 2
    continue
  fi
  case "$1" in http://*) url="$1" ;; esac
  shift
done
[ "$has_noproxy" -eq 1 ] || { echo "localhost 请求没有绕过代理" >&2; exit 22; }
case "$url" in
  */api/health) echo '{"ok":true}' ;;
  */api/restart-impact) echo '{"survives":[],"resumes":[],"interrupted":[],"mcpDisrupted":[]}' ;;
  *) echo "意外 URL: $url" >&2; exit 22 ;;
esac
EOF

cat > "$FAKE_BIN/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

chmod +x "$FAKE_BIN"/*

PATH="$FAKE_BIN:$PATH" \
  RESTART_TEST_TMP="$TMP" \
  HTTP_PROXY="http://127.0.0.1:1" \
  ALL_PROXY="socks5://127.0.0.1:1" \
  PORT=14317 \
  HARNESS_LOG="$TMP/harness.log" \
  SERVER_NODE="$FAKE_BIN/server" \
  START_TIMEOUT=2 \
  SKIP_MCP=1 \
  bash "$REPO/scripts/restart.sh" > "$TMP/output.log"

grep -q '14317 已就绪' "$TMP/output.log"
grep -q '✅ 完成' "$TMP/output.log"
[ "$(sed -n '1p' "$TMP/npm.log")" = "install --no-audit --no-fund" ]
[ "$(sed -n '2p' "$TMP/npm.log")" = "run build" ]
SERVER_PID="$(cat "$TMP/server.pid")"
kill -0 "$SERVER_PID"
[ "$(ps -p "$SERVER_PID" -o ppid= | tr -d ' ')" = "1" ]
echo "✓ restart.sh 的本机探测绕过代理，且脚本返回后 detached server 仍在运行"
