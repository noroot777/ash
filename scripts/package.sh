#!/usr/bin/env bash
# 打一个可以直接发给别人的分发包(tar.gz)。
#
#   npm run package                 # 打 HEAD,产物落 dist-package/
#   REF=main npm run package        # 打指定 ref
#   OUT=/tmp npm run package        # 换产物目录
#
# 用 `git archive` 而不是 `tar czf .`:只装**入库的文件**,于是 data/(SQLite 库里有
# 你的 API key、任务正文、run 产物)、node_modules/、.worktrees/、*.log 一律不可能
# 混进去 —— 靠人肉 --exclude 迟早会漏,这类漏的代价是把密钥发出去。
#
# 收件人拿到之后:tar xzf → bash scripts/setup.sh(见 docs/install.md)。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

REF="${REF:-HEAD}"
OUT="${OUT:-$REPO/dist-package}"

command -v git >/dev/null 2>&1 || { echo "✕ 需要 git"; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "✕ 这里不是 git 仓库,没法用 git archive 打包"; exit 1; }
git rev-parse --verify "$REF" >/dev/null 2>&1 || { echo "✕ 找不到 ref: $REF"; exit 1; }

SHA="$(git rev-parse --short "$REF")"
STAMP="$(date +%Y%m%d)"
NAME="harness-${STAMP}-${SHA}"
TARBALL="$OUT/${NAME}.tar.gz"

# 未提交的改动不会进包 —— 说清楚,别让人以为「我刚改的那行也发出去了」。
if ! git diff --quiet HEAD 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "⚠ 工作区有未提交/未入库的改动,它们**不会**进包(打的是 $REF=$SHA)。"
  echo "  要一起发出去就先提交,再重跑。"
fi

mkdir -p "$OUT"
echo "▶ 打包 $REF ($SHA) → $TARBALL"
# --prefix:解包后自成一个目录,不会把文件炸进对方的当前目录。
git archive --format=tar.gz --prefix="${NAME}/" -o "$TARBALL" "$REF" || {
  echo "✕ 打包失败"; exit 1;
}

SIZE="$(du -h "$TARBALL" | cut -f1 | tr -d ' ')"
echo "✓ 完成:$TARBALL ($SIZE)"
echo
echo "包里**没有**(也不该有):data/(库+密钥+run 产物)、node_modules/、.worktrees/、*.log"
echo "校验和(可一并发给对方核对):"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$TARBALL"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$TARBALL"
fi
echo
echo "告诉收件人这么做:"
echo "  tar xzf ${NAME}.tar.gz && cd ${NAME} && bash scripts/setup.sh"
echo "(细节与排错见包内 docs/install.md)"
