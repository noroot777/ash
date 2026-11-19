// 升级说给人听的那两段:失败时(和升好之后)怎么退回升级前的版本,升好之后的小结。命令都是能原样照抄的 ——
// 回归(test-upgrade.mjs)就是把这几行抠出来原样跑一遍,看能不能回到能用的状态。
import { DB_FILE_NAME } from "./db-file.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";
import { IS_WINDOWS } from "./platform.mjs";
import { short } from "./upgrade-git.mjs";

/**
 * 照抄进 shell 也还是原样的一个参数。退回命令在 Windows 上按 PowerShell 写、别处按 sh 写,所以用各自的单引号:
 * 单引号里 `$`、反引号、双引号都不展开(双引号包不住 `$USER` 这种)。没有要护的字符就原样,命令好读。
 * 反斜杠只在 Windows 上算安全字符(那边是路径分隔符);sh 里裸着的反斜杠会被吃掉,得进引号。
 */
export function shellArg(s, windows = IS_WINDOWS) {
  if (!(windows ? /[^\w@%+=:,./\\-]/ : /[^\w@%+=:,./-]/).test(s)) return s;
  return windows ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 这份安装选数据的那几个环境变量(NAVI_DATA_DIR / NAVI_DB / NAVI_RUNS_DIR),这一次升级时的值。退回命令开头原样设回去:
 * 用户常用命令前缀临时给(`NAVI_DATA_DIR=/x npm run upgrade`),父 shell 里没有,照抄的 restart 就会回落到检出下的默认数据,
 * 起来的是另一份库(审查第 4 轮实测)。每一代名字都设成同一个值:退回去的可能是改名之前的版本,它只认 ASH_*。
 */
export function envLines(vars, windows = IS_WINDOWS) {
  return Object.entries(vars).flatMap(([name, value]) => (windows
    ? [`$env:${name} = '${String(value).replace(/'/g, "''")}'`]
    : [`export ${name}=${shellArg(String(value), false)}`]));
}

/**
 * 退回之后服务开的是不是升级前那份数据:问 /api/health 报的数据目录(跟升级前核对端口上那个服务用的是同一条判据,
 * upgrade-checks 的 identifyServer),两边按真实落点比。对不上退出 1;旧服务不报数据目录就提醒人去页面上看一眼。
 * 写成不带引号的一行 JS(模板字符串、String.raw),照抄进 sh 和 PowerShell 都一样。
 */
export function checkDataCommand(port, dataDir, windows = IS_WINDOWS) {
  const js = "const fs=require(`node:fs`);const real=(p)=>{try{return fs.realpathSync(p)}catch{return p}};"
    + `const want=String.raw\`${dataDir}\`;`
    + `fetch(\`http://127.0.0.1:${port}/api/health\`).then((r)=>r.json()).then((h)=>{const got=h?.instance?.dataDir;`
    + "if(!got){console.log(`⚠ 服务没报它用的数据目录,去页面上确认项目和任务都还在`);return}"
    + "if(real(got)!==real(want)){console.error(`✕ 服务用的数据目录是 ${got},不是升级前那份 ${want}:先停掉它,照上面设好环境变量再起`);process.exit(1)}"
    + "console.log(`✓ 服务用的是升级前那份数据 ${want}`)}).catch((e)=>{console.error(`✕ 问不到服务:${e.message}`);process.exit(1)})";
  return `node -e ${shellArg(js, windows)}`;
}

/**
 * 「依次执行」那几行。退回到 from 那一版:库已经改成 navi.db、而那一版认不得它时,先(用新版)把库退回旧名。
 * serverRunning = 端口上有服务在应答(用 stop.mjs 停);stray = { pid, born }:刚起的服务进程还活着、却没应答(起得慢、卡在迁移里),
 * stop.mjs 问不到它,只能按 pid 结束 —— 用 `stop.mjs --pid --born`:先认准还是当初那一个(出生时刻)、确实在跑服务入口,结束它并
 * **等到它真的退出**才算成功(只发一个信号不算:它卡在同步迁移里时信号要等迁移做完才处理,后面退库名、装旧依赖就跟它撞上)。
 * dataEnv = 这次升级选数据的环境变量(envLines);dataDir = 退回之后服务该用的数据目录,最后一行核对(checkDataCommand)。
 */
export function rollbackCommands({ from, head, port, serverRunning, stray = null, renameBack, dataDir, dataEnv = {}, windows = IS_WINDOWS }) {
  const cmds = [];
  if (port !== 4317) cmds.push(windows ? `$env:PORT = "${port}"` : `export PORT=${port}`);
  cmds.push(...envLines(dataEnv, windows));
  if (serverRunning) cmds.push("node scripts/stop.mjs");
  if (stray) cmds.push(`node scripts/stop.mjs --pid ${stray.pid} --born ${stray.born}`);
  if (renameBack) cmds.push(`node scripts/rename-db.mjs --rollback --data ${shellArg(dataDir, windows)}`);
  if (from !== head) cmds.push(`git reset --keep ${from}`);
  // 那一版自己的 restart:装回它的依赖、构建、起服务(服务停着,先装后停的老问题不存在)。
  cmds.push("node scripts/restart.mjs");
  cmds.push(checkDataCommand(port, dataDir, windows));
  return cmds;
}

export function printRollback(say, { repo, cmds, backup }) {
  say(`  · 退回升级前的版本,在 ${repo} 下依次执行:(哪一行报 ✕ 就停下,先处理它,别往下做)`);
  for (const c of cmds) say(`       ${c}`);
  if (backup) {
    say(`  · 库备份在 ${backup}:升级前那一刻的库(SQLite 做的完整快照,-wal 里的内容已经在里面),连同身份、访问密钥。`);
    say("    上面几步之后数据还不对:停掉服务,删掉数据目录里这份库的 -wal、-shm,再把备份里的文件拷回去(同名覆盖;库是软链就拷到它指着的地方)再起。");
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
