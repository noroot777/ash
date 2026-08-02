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
#  - 安全闸的判据是「重启会**真正打断**几个任务」，不是「有几个在跑」：agent 的
#    输出走文件之后（server/src/executors/detached.ts），单飞任务的进程不随 server
#    死，重启后按 pid+offset 接管、全程无感；团队调度台进程会断但自动 --resume
#    接回。真会被判 failed 的只剩：旧代码起的（没 agent_pid）、queued 还没起进程
#    的、进程已经不在的。所以「有 3 个任务在跑」现在完全可能是可以随意重启的。
#    判据单点在 server 的 /api/restart-impact，跟真正接管时用同一条口径。
#  - 确定要打断再加 FORCE=1。build 已完成不会丢，只是先不动服务端。
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

# 「现在重启会真正打断几个任务」。**不是** running/queued 的个数 —— agent 的输出
# 走文件之后（server/src/executors/detached.ts），单飞任务的进程压根不随 server 死，
# 重启后按 pid+offset 接管，全程无感；团队调度台进程会断但会自动 --resume 接回。
# 真会被判 failed 的只有：旧代码起的（没 agent_pid）、queued 还没起进程的、进程已
# 经不在的。判据单点在 server 的 /api/restart-impact，跟真正接管时用同一条口径，
# 免得这边说能接、那边又不认。
# server 没起来/查不到 → 算 0（本来就没什么可打断的），照旧重启。
impact_field() { # $1 = survives|resumes|interrupted
  curl -fsS "localhost:${PORT}/api/restart-impact" 2>/dev/null \
    | { grep -o "\"$1\":\[[^]]*\]" || true; } \
    | { grep -o '"id":"' || true; } | wc -l | tr -d ' '
}
interrupt_count() { impact_field interrupted; }

# 详情:被打断的那几个是谁、为什么。只在真要拦人时才拉，省一次请求。
impact_detail() {
  curl -fsS "localhost:${PORT}/api/restart-impact" 2>/dev/null \
    | sed 's/{"id"/\n{"id"/g' | grep '"reason"' \
    | sed 's/.*"title":"\([^"]*\)".*"reason":"\([^"]*\)".*/     · \1 —— \2/' | head -8
}

# WAIT=1 用:轮询到「不再有会被打断的任务」为止,把「人守着等」换成「脚本替你等」。
drain_wait() {
  local n elapsed=0 step=5
  n="$(interrupt_count)"
  [ "${n:-0}" -gt 0 ] || return 0
  echo "  ⏳ WAIT:还有 $n 个任务重启会被打断,等它们跑完(Ctrl-C 可随时放弃)…"
  while [ "${n:-0}" -gt 0 ]; do
    if [ -n "${WAIT_TIMEOUT:-}" ] && [ "$elapsed" -ge "$WAIT_TIMEOUT" ]; then
      echo "  ✕ WAIT 超时(${WAIT_TIMEOUT}s),仍有 $n 个会被打断 —— 已中止,未重启服务端。"
      exit 3
    fi
    sleep "$step"
    elapsed=$((elapsed + step))
    n="$(interrupt_count)"
    if [ $((elapsed % 60)) -eq 0 ] && [ "${n:-0}" -gt 0 ]; then
      echo "  ⏳ 已等 $((elapsed / 60))min,还有 $n 个会被打断…"
    fi
  done
  echo "  ✓ 已经没有会被打断的任务了,继续。"

}

# 先等空再 build:反过来的话,等待期间合进来的提交不会进 dist。
# FORCE 优先 —— 既然打算强杀,等就没有意义了。
if [ -n "${WAIT:-}" ] && [ -z "${FORCE:-}" ]; then drain_wait; fi

echo "▶ 1/3 构建 (shared → web-next → server → mcp)…"
npm run build || { echo "✕ 构建失败,已中止——服务端未重启,跑的还是旧代码。"; exit 1; }

echo "▶ 2/3 重启 :$PORT 服务端…"
OLD="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "$OLD" ]; then
  # 别盲目打断会被打断的任务。注意判据是「重启会**真断**几个」而不是「有几个在跑」：
  # 解绑之后单飞 agent 活得过重启，只剩几类会真断（见 impact_field 上方注释）。
  BUSY="$(interrupt_count)"
  # build 少说几十秒,这期间完全可能又有任务起跑 —— WAIT 模式再排一轮。
  if [ "${BUSY:-0}" -gt 0 ] && [ -n "${WAIT:-}" ] && [ -z "${FORCE:-}" ]; then
    drain_wait
    BUSY="$(interrupt_count)"
  fi
  if [ "${BUSY:-0}" -gt 0 ] && [ -z "${FORCE:-}" ]; then
    echo "  ✋ 重启会打断 $BUSY 个任务(判为 failed) —— 已中止,未重启服务端。"
    impact_detail
    echo "     让脚本替你等它们跑完:  WAIT=1 npm run restart"
    echo "     确定要打断:            FORCE=1 npm run restart"
    echo "     (新代码已 build 进 dist,不会丢;只是暂不重启 :${PORT}。MCP 也未动。)"
    exit 2
  fi
  # 走到这里 = 没有会被打断的任务。可能仍有任务在跑,但它们要么会被接管、要么会
  # 自动 --resume 接回 —— 如实说一句,别让用户以为闸失灵了。
  SAFE="$(impact_field survives)"
  LEAD="$(impact_field resumes)"
  if [ "${SAFE:-0}" -gt 0 ] || [ "${LEAD:-0}" -gt 0 ]; then
    echo "  ✓ 有任务在跑,但重启不会打断:${SAFE} 个会被接管(继续跑,无感)、${LEAD} 个调度台会自动接回。"
  fi
  [ "${BUSY:-0}" -gt 0 ] && echo "  ⚠ FORCE:打断 $BUSY 个**接管不了**的任务(判为 failed,可重试);会被接管的不受影响。"
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
