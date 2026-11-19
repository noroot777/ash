// 升级说给人听的那两段:失败时(和升好之后)怎么退回升级前的版本,升好之后的小结。命令都是能原样照抄的 ——
// 回归(test-upgrade.mjs)就是把这几行抠出来原样跑一遍,看能不能回到能用的状态。
import { DB_FILE_NAME } from "./db-file.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";
import { IS_WINDOWS } from "./platform.mjs";
import { short } from "./upgrade-git.mjs";

const quote = (s) => (/[\s"'$`&|;()<>]/.test(s) ? `"${s}"` : s);

/** 「依次执行」那几行。退回到 from 那一版:库已经改成 navi.db、而那一版认不得它时,先(用新版)把库退回旧名。 */
export function rollbackCommands({ from, head, port, serverRunning, renameBack, dataDir }) {
  const cmds = [];
  if (port !== 4317) cmds.push(IS_WINDOWS ? `$env:PORT = "${port}"` : `export PORT=${port}`);
  if (serverRunning) cmds.push("node scripts/stop.mjs");
  if (renameBack) cmds.push(`node scripts/rename-db.mjs --rollback --data ${quote(dataDir)}`);
  if (from !== head) cmds.push(`git reset --keep ${from}`);
  // 那一版自己的 restart:装回它的依赖、构建、起服务(服务停着,先装后停的老问题不存在)。
  cmds.push("node scripts/restart.mjs");
  return cmds;
}

export function printRollback(say, { repo, cmds, backup }) {
  say(`  · 退回升级前的版本,在 ${repo} 下依次执行:`);
  for (const c of cmds) say(`       ${c}`);
  if (backup) {
    say(`  · 库备份在 ${backup}:升级前那一刻的库,连同身份、访问密钥。上面几步之后数据还不对,`);
    say("    停掉服务,把它里面的文件拷回数据目录(同名覆盖)再起。");
  }
}

/** 升好之后那一段人话。 */
export function printSummary(say, s) {
  say("");
  say(s.ok ? "✅ 升好了" : "⚠ 升好了,但有一项要你看一眼(见上面 ✕ 那一行)");
  const pulled = s.from === s.head ? `${short(s.head)}(代码本来就是这一版)` : `${short(s.from)} → ${short(s.head)}(${s.branch},${s.commits} 个新提交)`;
  say(`   代码   ${pulled}`);
  const dbLine = {
    renamed: `${s.db}(这次从 ${LEGACY_DB_FILE} 改名过来,原位置留了一份路标)`,
    failed: `${s.db} —— 库名没改成,照旧用 ${LEGACY_DB_FILE},其余都升好了(原因见上面;收拾好后再跑一次就会改)`,
    keep: `${s.db}(按 --keep-db-name 没改名)`,
    explicit: `${s.db}(按你设的 NAVI_DB)`,
    done: s.db,
    none: `${s.db}(新建的)`,
  }[s.dbOutcome];
  say(`   库     ${dbLine}`);
  say(`   备份   ${s.backup ?? "没有(升级前还没有库)"}`);
  say(`   核对   ${s.check}`);
  say(`   服务   http://localhost:${s.port}(pid ${s.pid})`);
  say(`   日志   ${s.log}`);
  if (s.rollback) printRollback(say, s.rollback);
  if (s.dbOutcome === "keep") say(`  · 以后想把库改成 ${DB_FILE_NAME}:去掉 --keep-db-name 再跑一次 npm run upgrade。`);
}
