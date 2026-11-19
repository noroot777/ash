// 升级说给人听的那两段:失败时(和升好之后)怎么退回升级前的版本,升好之后的小结。命令都是能原样照抄的 ——
// 回归(test-upgrade.mjs)就是把这几行抠出来原样跑一遍,看能不能回到能用的状态。
import { DB_FILE_NAME } from "./db-file.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";
import { IS_WINDOWS } from "./platform.mjs";
import { short } from "./upgrade-git.mjs";

/**
 * 照抄进 shell 也还是原样的一个参数。退回命令在 Windows 上按 PowerShell 写、别处按 sh 写,所以用各自的单引号:
 * 单引号里 `$`、反引号、双引号都不展开(双引号包不住 `$USER` 这种)。没有要护的字符就原样,命令好读。
 */
export function shellArg(s, windows = IS_WINDOWS) {
  if (!/[^\w@%+=:,./\\-]/.test(s)) return s;
  return windows ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 结束一个还活着的进程(连同它的子进程)的那一行。 */
const killCommand = (pid, windows = IS_WINDOWS) => (windows ? `taskkill /PID ${pid} /T /F` : `kill ${pid}`);

/**
 * 「依次执行」那几行。退回到 from 那一版:库已经改成 navi.db、而那一版认不得它时,先(用新版)把库退回旧名。
 * serverRunning = 端口上有服务在应答(用 stop.mjs 停);strayPid = 刚起的服务进程还活着、却没应答(起得慢、卡在迁移里),
 * stop.mjs 问不到它,只能按 pid 结束 —— 不结束它,退库名会被它占着的锁挡下,它还可能过一会儿自己起来。
 */
export function rollbackCommands({ from, head, port, serverRunning, strayPid = null, renameBack, dataDir, windows = IS_WINDOWS }) {
  const cmds = [];
  if (port !== 4317) cmds.push(windows ? `$env:PORT = "${port}"` : `export PORT=${port}`);
  if (serverRunning) cmds.push("node scripts/stop.mjs");
  if (strayPid) cmds.push(killCommand(strayPid, windows));
  if (renameBack) cmds.push(`node scripts/rename-db.mjs --rollback --data ${shellArg(dataDir, windows)}`);
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
  say(s.ok ? "✅ 升好了" : "⚠ 代码、服务都升好了,但数据核对没过(见上面);再跑一次 npm run upgrade 会先补核,不重启服务");
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
