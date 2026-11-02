#!/bin/sh
# 范围外附加面:mcp(2) + mobile(8)。各自独立临时 ASH_DB,日志逐条落 .audit/extra/。
cd "$(dirname "$0")/../.." || exit 1
ROOT="$(pwd)"
OUT="$ROOT/.audit/extra/extra.jsonl"
: > "$OUT"
run() { # pkg script cmd
  pkg="$1"; script="$2"; shift 2
  stage="$(mktemp -d "${TMPDIR:-/tmp}/ash-audit-extra-XXXXXX")"
  log="$ROOT/.audit/extra/${pkg}-${script}.log"
  t0=$(date +%s)
  ( cd "$ROOT/$pkg" && ASH_DB="$stage/ash.db" sh -c "$*" ) > "$log" 2>&1
  rc=$?
  t1=$(date +%s)
  printf '{"pkg":"%s","script":"%s","rc":%d,"sec":%d,"log":".audit/extra/%s-%s.log"}\n' \
    "$pkg" "$script" "$rc" "$((t1-t0))" "$pkg" "$script" >> "$OUT"
  echo "EXTRA $pkg:$script rc=$rc ${t1_}$((t1-t0))s"
  [ "$rc" = 0 ] && rm -rf "$stage"
}
run mcp test-reconnect        "npm run build && node scripts/test-reconnect.mjs"
run mcp test-read-transcript  "npm run build && node scripts/test-read-transcript.mjs"
for s in project-path session-notices cli-capability markdown-inline; do
  run mobile "test-$s" "node --experimental-strip-types scripts/test-$s.mjs"
done
for s in web-smoke reply-command-ui monitor-strip task-branches; do
  run mobile "test-$s" "node scripts/test-$s.mjs"
done
echo "EXTRA_DONE"
