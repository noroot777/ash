#!/usr/bin/env bash
# 一条龙:重建全部 → 重启 :4317 服务端 → 刷新 harness MCP。
#
#   npm run restart            # 或直接 ./scripts/restart.sh
#   FORCE=1 npm run restart    # 即使有任务在跑也强制重启(会把它们判为 failed)
#   WAIT=1 npm run restart     # 有任务在跑就【等】它们排空再重启,而不是中止
#   SKIP_MCP=1 npm run restart # 只重建+重启 :4317,不刷新 MCP(不打断正在用 harness MCP 的会话)
#   FORCE_MCP=1 npm run restart # 明知有 agent 正握着 MCP 通道,也照样刷新(会掐断它们的交卷)
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
#    不是常驻端口。第 3 步杀掉这些"旧代码"子进程;客户端下次用到时会用新的 mcp/dist 重新拉起。
#    **这一刀是本脚本唯一真能伤到正在干活的 agent 的地方**(重启 :4317 它们无感,见上一条):
#    通道一断,它那轮的 report_stage/complete_task 就撞 `Transport closed`。所以第 3 步之前
#    再问一次服务端「谁手里还握着 MCP」(restart-impact 的 mcpDisrupted),有人握着就**默认
#    跳过刷新**并说明——改了 mcp/ 非要立刻生效再 FORCE_MCP=1 跑一遍。
#    (兜底另有一层:harness 会在回合结算时补录那些"确定没送达"的交卷调用,见
#     server/src/mcp-handoff.ts;但白名单只有三个工具,能不掐断还是不掐断。)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
PORT="${PORT:-4317}"
LOG="${HARNESS_LOG:-/tmp/harness-$PORT.log}"
START_TIMEOUT="${START_TIMEOUT:-30}"
SERVER_NODE="${SERVER_NODE:-$(command -v node)}"

# 本机控制面请求绝不能跟着 HTTP_PROXY / ALL_PROXY 绕去代理。这个环境常驻代理但没设
# NO_PROXY；服务重启的几秒空窗里，代理会记住一次上游失败，于是 server 已经同秒监听，
# 这里仍连续拿到失败并误报「没起来」。所有 :$PORT 探测统一从这一个入口直连。
local_curl() {
  curl --noproxy '*' "$@"
}

# 「现在重启会真正打断几个任务」。**不是** running/queued 的个数 —— agent 的输出
# 走文件之后（server/src/executors/detached.ts），单飞任务的进程压根不随 server 死，
# 重启后按 pid+offset 接管，全程无感；团队调度台进程会断但会自动 --resume 接回。
# 真会被判 failed 的只有：旧代码起的（没 agent_pid）、queued 还没起进程的、进程已
# 经不在的。判据单点在 server 的 /api/restart-impact，跟真正接管时用同一条口径，
# 免得这边说能接、那边又不认。
# server 没起来/查不到 → 算 0（本来就没什么可打断的），照旧重启。
impact_field() { # $1 = survives|resumes|interrupted
  local_curl -fsS "http://localhost:${PORT}/api/restart-impact" 2>/dev/null \
    | { grep -o "\"$1\":\[[^]]*\]" || true; } \
    | { grep -o '"id":"' || true; } | wc -l | tr -d ' '
}
interrupt_count() { impact_field interrupted; }

# 详情:被打断的那几个是谁、为什么。只在真要拦人时才拉，省一次请求。
impact_detail() {
  local_curl -fsS "http://localhost:${PORT}/api/restart-impact" 2>/dev/null \
    | sed 's/{"id"/\n{"id"/g' | grep '"reason"' \
    | sed 's/.*"title":"\([^"]*\)".*"reason":"\([^"]*\)".*/     · \1 —— \2/' | head -8
}

# 同上,但列的是「手里握着 MCP 通道」的那几个(它们没有 reason,只有 pid)。
impact_detail_mcp() {
  local_curl -fsS "http://localhost:${PORT}/api/restart-impact" 2>/dev/null \
    | { grep -o '"mcpDisrupted":\[[^]]*\]' || true; } \
    | tr '{' '\n' | { grep '"pid"' || true; } \
    | sed 's/.*"title":"\([^"]*\)".*"pid":\([0-9]*\).*/     · \1 (pid \2)/' | head -8
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
SERVER_PID="$(node scripts/start-detached.mjs "$LOG" "$SERVER_NODE" server/dist/index.js)" || {
  echo "  ✕ :$PORT 启动命令拉起失败,看 $LOG"
  exit 1
}
READY=0
STARTED_AT=$SECONDS
while [ $((SECONDS - STARTED_AT)) -lt "$START_TIMEOUT" ]; do
  if local_curl -fsS --connect-timeout 1 --max-time 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  # 启动进程已经退出就别傻等满超时；反之给迁移/重启接管留足时间。
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.2
done
if [ "$READY" -eq 1 ]; then
  echo "  ✓ :$PORT 已就绪(日志 $LOG)"
else
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "  ✕ :$PORT 等待 ${START_TIMEOUT}s 仍未就绪,但启动进程还在运行;看 $LOG"
  else
    echo "  ✕ :$PORT 启动进程已退出,看 $LOG"
  fi
  exit 1
fi

echo "▶ 3/3 刷新 harness MCP…"
# 谁手里还握着 MCP 通道。**在服务端重启完之后才问**:此刻接管已经做完,答案是最新的。
# 拿不到(server 没起来/老版本没这个字段)算 0,退回原来的行为。
MCP_HOLDERS="$(impact_field mcpDisrupted)"
if [ -n "${SKIP_MCP:-}" ]; then
  echo "  ⏭ SKIP_MCP:跳过——不动 MCP 子进程,正在用 harness MCP 的会话不会被打断。"
  echo "     (代价:这些会话仍跑旧 mcp/dist;只有改了 mcp/ 才需去掉 SKIP_MCP 再跑一次。)"
elif [ "${MCP_HOLDERS:-0}" -gt 0 ] && [ -z "${FORCE_MCP:-}${FORCE:-}" ]; then
  # 默认不掐断正在干活的 agent:刷新 MCP 的收益只是"旧会话用上新 mcp 代码",
  # 代价却是它这一轮的交卷调用当场失败(2026-08-06 验证白跑)。收益远小于代价,
  # 所以默认让路,并把出路说清楚。
  echo "  ⏭ 有 $MCP_HOLDERS 个正在干活的 agent 手里握着 harness MCP 通道,已跳过刷新以免掐断它们的交卷。"
  impact_detail_mcp
  echo "     (:$PORT 已经是新代码;这些会话仍跑旧 mcp/dist。)"
  echo "     改了 mcp/ 需要立刻生效:  FORCE_MCP=1 npm run restart"
else
  # 末尾锚定 $:只命中独立的 `node …/mcp/dist/index.js` 子进程,绝不误杀含该路径于 --mcp-config 里的
  # claude/codex 父进程(已验证)。
  MCP_PAT="$REPO/mcp/dist/index.js\$"
  # 同上:pgrep 无匹配返回非零,别让 pipefail 触发多余的 echo —— N 保证是单个整数。
  N="$(pgrep -f "$MCP_PAT" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${N:-0}" -gt 0 ]; then
    [ "${MCP_HOLDERS:-0}" -gt 0 ] && echo "  ⚠ 强制刷新:$MCP_HOLDERS 个在跑的 agent 手里的 MCP 通道会被掐断,它们这一轮的交卷调用会失败。"
    pkill -f "$MCP_PAT" 2>/dev/null || true
    echo "  ✓ 清掉 $N 个旧 MCP 进程,下次会话/调用即用新代码"
  else
    echo "  (没有在跑的旧 MCP 进程;新会话会直接用新 mcp/dist)"
  fi
fi

echo "✅ 完成。提示:已经开着的 Codex/Claude 会话要重连或重开,才会用上新的 harness MCP。"
