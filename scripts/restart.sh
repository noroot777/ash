#!/usr/bin/env bash
# 一条龙:重建全部 → 重启 :4317 服务端 → 刷新 harness MCP。
#
#   npm run restart            # 或直接 ./scripts/restart.sh
#   FORCE=1 npm run restart    # 即使有任务在跑也强制重启(会把它们判为 failed)
#   WAIT=1 npm run restart     # 有任务在跑就【等】它们排空再重启,而不是中止
#   SKIP_MCP=1 npm run restart # 只重建+重启 :4317,不刷新 MCP(不打断正在用 harness MCP 的会话)
#
# 跑法说明:
#  - :4317 跑的是编译后的 dist,所以改完源码必须先 build 再重启,本脚本一并做掉。
#  - 安全闸:若当前有 running/queued 任务,默认【中止】不重启(重启会打断它们);
#    确定要打断再加 FORCE=1。build 已完成不会丢,只是先不动服务端。
#  - WAIT=1 把「人守着等排空」换成「脚本替你等」:先等空再 build,build 期间若又
#    有任务起跑就再等一轮,然后重启。WAIT_TIMEOUT=<秒> 可设上限(默认无限等),
#    等待期间 Ctrl-C 随时可退。FORCE 优先于 WAIT(既然要强杀就不必等)。
#    注意残留竞态:检查与 kill 之间仍可能有 queued 任务抢跑 —— 真正关死这个窗口
#    需要服务端的 drain 模式(停止启动新任务并如实报告已排空),这里够不着。
#  - harness MCP 是每个 Codex/Claude 会话各自 spawn 的 stdio 子进程(node mcp/dist/index.js),
#    不是常驻端口。这里只杀掉这些"旧代码"子进程;客户端下次用到时会用新的 mcp/dist 重新拉起。
#    注意:正在用 harness MCP 的会话会断开,需要重连/重开;别在跑 skill 的当口执行本脚本。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
PORT="${PORT:-4317}"
LOG="${HARNESS_LOG:-/tmp/harness-$PORT.log}"

# 当前 running/queued 任务数。server 没起来/查不到时算 0 —— 那种情况本来就没什么可打断的。
# grep 无匹配会返回非零;pipefail 下别让它污染计数,显式 `|| true` 吞掉,
# wc -l 必然输出一个数,tr 删掉 macOS wc 的前导空格 —— 输出保证是单个整数。
busy_count() {
  curl -fsS "localhost:$PORT/api/tasks" 2>/dev/null \
    | { grep -o '"status":"\(running\|queued\)"' || true; } | wc -l | tr -d ' '
}

# WAIT=1 用:轮询到任务排空为止,把「人守着等」换成「脚本替你等」。
drain_wait() {
  local n elapsed=0 step=5
  n="$(busy_count)"
  [ "${n:-0}" -gt 0 ] || return 0
  echo "  ⏳ WAIT:当前 $n 个任务在 running/queued,等它们排空(Ctrl-C 可随时放弃)…"
  while [ "${n:-0}" -gt 0 ]; do
    if [ -n "${WAIT_TIMEOUT:-}" ] && [ "$elapsed" -ge "$WAIT_TIMEOUT" ]; then
      echo "  ✕ WAIT 超时(${WAIT_TIMEOUT}s),仍有 $n 个任务在跑 —— 已中止,未重启服务端。"
      exit 3
    fi
    sleep "$step"
    elapsed=$((elapsed + step))
    n="$(busy_count)"
    if [ $((elapsed % 60)) -eq 0 ] && [ "${n:-0}" -gt 0 ]; then
      echo "  ⏳ 已等 $((elapsed / 60))min,还有 $n 个在跑…"
    fi
  done
  echo "  ✓ 任务已排空,继续。"
}

# 先等空再 build:反过来的话,等待期间合进来的提交不会进 dist。
# FORCE 优先 —— 既然打算强杀,等就没有意义了。
if [ -n "${WAIT:-}" ] && [ -z "${FORCE:-}" ]; then drain_wait; fi

echo "▶ 1/3 构建 (shared → web → web-next → server → mcp)…"
npm run build || { echo "✕ 构建失败,已中止——服务端未重启,跑的还是旧代码。"; exit 1; }

echo "▶ 2/3 重启 :$PORT 服务端…"
OLD="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "$OLD" ]; then
  # 别盲目打断在跑的任务:默认有 running/queued 就中止(重启会把它们判为 failed)。
  # 确定要打断就 FORCE=1,愿意等就 WAIT=1。
  BUSY="$(busy_count)"
  # build 少说几十秒,这期间完全可能又有任务起跑 —— WAIT 模式再排一轮空。
  if [ "${BUSY:-0}" -gt 0 ] && [ -n "${WAIT:-}" ] && [ -z "${FORCE:-}" ]; then
    drain_wait
    BUSY="$(busy_count)"
  fi
  if [ "${BUSY:-0}" -gt 0 ] && [ -z "${FORCE:-}" ]; then
    echo "  ✋ 当前有 $BUSY 个任务在 running/queued —— 已中止,未重启服务端。"
    echo "     让脚本替你等到排空:  WAIT=1 npm run restart"
    echo "     确定要打断:          FORCE=1 npm run restart"
    echo "     (新代码已 build 进 dist,不会丢;只是暂不重启 :$PORT。MCP 也未动。)"
    exit 2
  fi
  [ "${BUSY:-0}" -gt 0 ] && echo "  ⚠ FORCE:打断 $BUSY 个在跑/排队任务(判为 failed,可重试)。"
  kill "$OLD" 2>/dev/null || true
  for _ in $(seq 1 25); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 || break; sleep 0.2; done
fi
nohup node server/dist/index.js > "$LOG" 2>&1 & disown
for _ in $(seq 1 25); do curl -fsS "localhost:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.2; done
if curl -fsS "localhost:$PORT/api/health" >/dev/null 2>&1; then
  echo "  ✓ :$PORT 已就绪(日志 $LOG)"
else
  echo "  ✕ :$PORT 没起来,看 $LOG"; exit 1
fi

echo "▶ 3/3 刷新 harness MCP…"
if [ -n "${SKIP_MCP:-}" ]; then
  echo "  ⏭ SKIP_MCP:跳过——不动 MCP 子进程,正在用 harness MCP 的会话不会被打断。"
  echo "     (代价:这些会话仍跑旧 mcp/dist;只有改了 mcp/ 才需去掉 SKIP_MCP 再跑一次。)"
else
  # 末尾锚定 $:只命中独立的 `node …/mcp/dist/index.js` 子进程,绝不误杀含该路径于 --mcp-config 里的
  # claude/codex 父进程(已验证)。
  MCP_PAT="$REPO/mcp/dist/index.js\$"
  # 同上:pgrep 无匹配返回非零,别让 pipefail 触发多余的 echo —— N 保证是单个整数。
  N="$(pgrep -f "$MCP_PAT" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${N:-0}" -gt 0 ]; then
    pkill -f "$MCP_PAT" 2>/dev/null || true
    echo "  ✓ 清掉 $N 个旧 MCP 进程,下次会话/调用即用新代码"
  else
    echo "  (没有在跑的旧 MCP 进程;新会话会直接用新 mcp/dist)"
  fi
fi

echo "✅ 完成。提示:已经开着的 Codex/Claude 会话要重连或重开,才会用上新的 harness MCP。"
