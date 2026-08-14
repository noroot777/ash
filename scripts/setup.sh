#!/usr/bin/env bash
# 在**新机器**上把 harness 装好:装依赖 → 构建 → 接好 MCP → 告诉你怎么起。
#
#   bash scripts/setup.sh
#   PORT=4317 bash scripts/setup.sh      # 换端口(MCP 里写的 URL 会跟着变)
#   SKIP_MCP=1 bash scripts/setup.sh     # 不动 ~/.claude.json 和 ~/.codex/config.toml
#   SKIP_BUILD=1 bash scripts/setup.sh   # 只装依赖、接 MCP,不构建
#
# 幂等:重复跑不会重复写配置,也不会覆盖已有的 harness MCP 条目。
#
# 为什么 MCP 这一步不能省:harness 起的 agent 是靠 harness MCP 的 complete_task 交卷的。
# 没接上 = 每个任务跑完都被判 failed(它压根没有那个工具可调)。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
PORT="${PORT:-4317}"
URL="http://localhost:${PORT}"
FAIL=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }
bad()  { printf '  ✕ %s\n' "$*"; FAIL=1; }

say "▶ 1/5 检查运行环境"

case "$(uname -s)" in
  Darwin|Linux) ok "系统 $(uname -s)" ;;
  *) warn "系统 $(uname -s):脚本按 macOS/Linux 写的(用到 bash/lsof/pkill)。Windows 请在 WSL2 里跑。" ;;
esac

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 20 ]; then
    ok "node $(node -v)"
  else
    bad "node $(node -v) 太旧,需要 >= 20(建议 22 或更新)"
  fi
else
  bad "没有 node。装法:https://nodejs.org 或 nvm install 22"
fi

command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || bad "没有 npm"
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" \
  || bad "没有 git(worktree 隔离、审查 diff、验收合并全靠它)"

[ "$FAIL" -eq 0 ] || { say; say "✕ 环境不满足,先把上面 ✕ 的装好再重跑。"; exit 1; }

say
say "▶ 2/5 安装依赖(npm install,首次要几分钟)"
npm install || { say "  ✕ npm install 失败。常见原因:没网/代理没配/npm registry 不通。"; exit 1; }
ok "依赖装好"

if [ -z "${SKIP_BUILD:-}" ]; then
  say
  say "▶ 3/5 构建(shared → web-next → server → mcp)"
  npm run build || { say "  ✕ 构建失败,上面有报错。修完重跑 bash scripts/setup.sh"; exit 1; }
  ok "构建完成(server 从磁盘读 web-next/dist,mcp/dist/index.js 已就位)"
else
  say
  say "▶ 3/5 构建 —— SKIP_BUILD=1,跳过"
  [ -f mcp/dist/index.js ] || warn "mcp/dist/index.js 不存在,MCP 接上了也起不来"
fi

say
say "▶ 4/5 接上 harness MCP(agent 靠它交卷)"
MCP_ENTRY="$REPO/mcp/dist/index.js"

if [ -n "${SKIP_MCP:-}" ]; then
  warn "SKIP_MCP=1,跳过。稍后自己接(命令见 docs/install.md),否则任务跑完一律记 failed。"
else
  # ── claude ────────────────────────────────────────────────────────────────
  if command -v claude >/dev/null 2>&1; then
    if claude mcp list 2>/dev/null | grep -q '^harness:'; then
      ok "claude:harness 已注册,不动它"
    elif claude mcp add harness --scope user -e "HARNESS_URL=$URL" -- node "$MCP_ENTRY" >/dev/null 2>&1; then
      ok "claude:已注册 harness(user 作用域,编排别的仓库时也在)"
    else
      warn "claude mcp add 失败,手动跑:"
      say  "      claude mcp add harness --scope user -e HARNESS_URL=$URL -- node $MCP_ENTRY"
    fi
  else
    warn "没装 claude CLI,跳过它的 MCP 注册"
  fi

  # ── codex ─────────────────────────────────────────────────────────────────
  CODEX_CFG="${CODEX_HOME:-$HOME/.codex}/config.toml"
  if command -v codex >/dev/null 2>&1; then
    if [ -f "$CODEX_CFG" ] && grep -q '^\[mcp_servers\.harness\]' "$CODEX_CFG"; then
      ok "codex:harness 已在 $CODEX_CFG 里,不动它"
    else
      mkdir -p "$(dirname "$CODEX_CFG")"
      # 先备份再追加:改的是用户自己的配置文件,出错要能一键还原。
      [ -f "$CODEX_CFG" ] && cp "$CODEX_CFG" "$CODEX_CFG.bak-harness-setup"
      {
        printf '\n[mcp_servers.harness]\n'
        printf 'command = "node"\n'
        printf 'args = ["%s"]\n\n' "$MCP_ENTRY"
        printf '[mcp_servers.harness.env]\n'
        printf 'HARNESS_URL = "%s"\n' "$URL"
      } >> "$CODEX_CFG"
      ok "codex:已写入 $CODEX_CFG$([ -f "$CODEX_CFG.bak-harness-setup" ] && printf '(原文件备份在同名 .bak-harness-setup)')"
    fi
  else
    warn "没装 codex CLI,跳过它的 MCP 注册"
  fi
fi

# git hooks:config 不随 clone/解包传播,必须每台机器执行一次。
if [ -d .git ] || [ -f .git ]; then
  git config core.hooksPath .githooks 2>/dev/null && ok "git hooks 已指向 .githooks" \
    || warn "git config core.hooksPath 设置失败(不影响运行,只是少两道提交闸)"
else
  warn "不是 git 仓库(tar 包解出来的通常如此)。harness 本身能跑,但对**它自己这个仓库**做不了 worktree/diff/合并。"
  say  "      想用完整能力:git init && git add -A && git commit -m init && git config core.hooksPath .githooks"
fi

say
say "▶ 5/5 检查可派活的 CLI"
FOUND=0
for cli in claude codex gemini cursor-agent opencode qwen copilot; do
  if command -v "$cli" >/dev/null 2>&1; then
    say "  ✓ $cli — $(command -v "$cli")"
    FOUND=$((FOUND + 1))
  fi
done
if [ "$FOUND" -eq 0 ]; then
  warn "一个 agent CLI 都没有。harness 是**调度台**,自己不写代码,得先装至少一个并登录:"
  say  "      npm install -g @anthropic-ai/claude-code   然后 claude   登录一次"
  say  "      npm install -g @openai/codex               然后 codex    登录一次"
else
  say "  (界面「设置 → 执行器」里能看到完整目录和各自的安装命令)"
fi

say
say "✅ 装完了。起服务:"
say "     npm start                 # 前台跑,:$PORT 同时托管界面和 API"
say "     npm run restart           # 或:构建+后台常驻(日志 /tmp/harness-$PORT.log)"
say
say "  然后浏览器开 $URL —— 第一件事是「新建项目」,填一个 git 仓库的绝对路径。"
say "  数据全在 $REPO/data/(SQLite + run 产物),备份就备份这个目录。"
say "  更多(升级、常驻、排错)见 docs/install.md"
