#!/usr/bin/env node
// 把数据目录里的库从改名之前的 ash.db 改成 navi.db（连同跟着库名走的身份、访问密钥、账本），或者退回去。
// **只在服务停着的时候做**：拿着维护锁，服务在这期间起不来；改名之前和之后的服务都算。
//
//   node scripts/rename-db.mjs                      演练：说清数据目录现在是什么样、会做什么，什么都不改
//   node scripts/rename-db.mjs --apply              改名（上次做到一半的话：接着做完）
//   node scripts/rename-db.mjs --rollback           退回成 ash.db，好换回改名之前的版本（上次做到一半的话：撤销那一次）
//   --data <目录>                                   数据目录；缺省是 NAVI_DATA_DIR（旧名也认），再缺省是本检出的 data/
//
// 退出码：0 做完 / 没有要做的；1 演练发现有要做的；2 拦下了，什么都没动；3 做的时候失败（已退回原样，或账本还在）。
// 操作单、回退、Windows 上要注意的：docs/rename-db.md。
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_FILE_NAME, DB_RENAME_JOURNAL } from "./db-file.mjs";
import { readStorageEnv } from "./env.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";
import { acquire, liveHolders, release } from "./relocate-checkout-lock.mjs";
import { inspect, planSteps, readJournal, runJournal, start, undoJournal } from "./rename-db-core.mjs";

const say = (s = "") => console.log(s);
const args = process.argv.slice(2);
let mode = "dry-run";
let dataArg = null;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--apply") mode = "apply";
  else if (a === "--rollback") mode = "rollback";
  else if (a === "--data") dataArg = args[++i] ?? null;
  else if (a === "-h" || a === "--help") { say("用法：node scripts/rename-db.mjs [--data <数据目录>] [--apply | --rollback]"); process.exit(0); }
  else { console.error(`认不得的参数：${a}`); process.exit(2); }
}
if (args.includes("--data") && !dataArg) { console.error("--data 后面要写数据目录"); process.exit(2); }

const env = process.env;
const repo = fileURLToPath(new URL("..", import.meta.url));
const dataDir = resolve(dataArg ?? readStorageEnv(env, "NAVI_DATA_DIR") ?? join(repo, "data"));
const runsEnv = readStorageEnv(env, "NAVI_RUNS_DIR");
const runsDirs = [...new Set([join(dataDir, "runs"), ...(runsEnv ? [resolve(runsEnv)] : [])])];
const dbFiles = [join(dataDir, LEGACY_DB_FILE), join(dataDir, DB_FILE_NAME)];
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

function describe(file) {
  try {
    const s = statSync(file);
    return `${(s.size / 1024 / 1024).toFixed(1)} MB，最后修改 ${s.mtime.toLocaleString()}`;
  } catch { return "不在"; }
}

function showSteps(steps) {
  for (const s of steps) {
    if (s.op === "move") say(`  ${s.leftover ? "留底" : "改名"}  ${s.from} → ${s.to}`);
    else say(`  ${s.op === "mark" ? "留路标" : "撤路标"}  ${s.path}`);
  }
}

/** 拿着维护锁跑 fn：锁里再看一眼数据目录（演练和真做之间可能有人动过），fn 返回退出码。 */
function locked(note, fn) {
  let lock;
  try { lock = acquire({ dbFiles, runsDirs }, note); }
  catch (error) { say(`✗ 拿不到维护锁，什么都没动：${error.message}`); return 2; }
  try { return fn(inspect(dataDir)); }
  catch (error) { say(`✗ ${error.message}`); return 3; }
  finally { release(lock); }
}

function explicitDbWarning() {
  const explicit = readStorageEnv(env, "NAVI_DB");
  if (!explicit) return;
  say(`! 这个 shell 里设着 NAVI_DB（旧名也算）=${explicit}：服务照它开库，不看数据目录里叫什么。`);
  say(`  改名之后把它改成 ${join(dataDir, DB_FILE_NAME)}（启动脚本、计划任务里设的也一样），不然服务会去开那份路标。`);
}

function main() {
  say(`数据目录：${dataDir}`);
  const now = inspect(dataDir);
  const live = dbFiles.map((db) => liveHolders(db, runsDirs)).flatMap((r) => [...r.reasons, ...r.errors]);
  if (live.length) {
    say("✗ 这份数据现在有人在用（或者分不清），先停掉服务：");
    for (const r of new Set(live)) say(`  ${r}`);
    return 2;
  }

  if (now.state === "interrupted") {
    const journal = readJournal(dataDir);
    const what = journal.direction === "forward" ? `改名成 ${DB_FILE_NAME}` : `退回成 ${LEGACY_DB_FILE}`;
    say(`上次${what}没做完（账本 ${join(dataDir, DB_RENAME_JOURNAL)}，${journal.createdAt}）。服务在它处理掉之前起不来。`);
    showSteps(journal.steps);
    if (mode === "dry-run") { say(`\n--apply 接着做完，--rollback 撤销这一次、回到它开始之前。`); return 1; }
    return locked(`rename-db ${mode} (resume)`, () => {
      if (mode === "apply") runJournal(dataDir, readJournal(dataDir));
      else undoJournal(dataDir, readJournal(dataDir));
      say(mode === "apply" ? `\n✓ 做完了：${what}。` : "\n✓ 已撤销，回到那一次开始之前的样子。");
      return 0;
    });
  }

  if (now.state === "both") {
    say(`✗ ${DB_FILE_NAME} 和 ${LEGACY_DB_FILE} 都是库，分不清哪份是在用的，不动。服务在这种情况下也不起。`);
    say(`  ${now.navi}：${describe(now.navi)}`);
    say(`  ${now.legacy}：${describe(now.legacy)}`);
    say("  确认要留哪一份，把另一份（连同它名字开头的 -wal、-shm、.identity.json 等）挪出数据目录。");
    return 2;
  }
  if (now.state === "orphan") {
    say(`✗ ${now.legacy} 是改名留下的路标，但 ${now.navi} 不在。库被挪走了？放回来再说，不动。`);
    return 2;
  }
  if (now.state === "empty") {
    say(`这里没有库（${DB_FILE_NAME}、${LEGACY_DB_FILE} 都不在）。新安装起服务会直接建 ${DB_FILE_NAME}，没有要做的。`);
    return mode === "rollback" ? 2 : 0;
  }
  if (now.state === "renamed" && mode !== "rollback") {
    say(`库已经叫 ${DB_FILE_NAME}${now.marker ? `（${LEGACY_DB_FILE} 是改名留下的路标）` : ""}，没有要做的。`);
    explicitDbWarning();
    return 0;
  }
  if (now.state === "legacy" && mode === "rollback") {
    say(`库本来就叫 ${LEGACY_DB_FILE}，没有要退回的。`);
    return 0;
  }

  const direction = now.state === "legacy" ? "forward" : "backward";
  const plan = planSteps(dataDir, { direction, stamp });
  say(direction === "forward" ? `要把 ${LEGACY_DB_FILE} 改名成 ${DB_FILE_NAME}：` : `要把 ${DB_FILE_NAME} 退回成 ${LEGACY_DB_FILE}：`);
  showSteps(plan.steps);
  if (plan.taken.length) {
    say("\n✗ 这些位置已经有东西了，一步都没做（哪一份是真的只有人能认）：");
    for (const t of plan.taken) say(`  ${t}`);
    return 2;
  }
  if (mode === "dry-run") {
    say(`\n演练完毕，什么都没改。服务停着的时候加 --apply 真做。`);
    explicitDbWarning();
    return 1;
  }
  return locked(`rename-db ${direction}`, (again) => {
    if (again.state !== now.state) { say(`✗ 数据目录在这期间变了（${now.state} → ${again.state}），什么都没动，重跑一次看看。`); return 2; }
    const fresh = planSteps(dataDir, { direction, stamp });
    if (fresh.taken.length) { say(`✗ ${fresh.taken.join("、")} 已经有了，什么都没动。`); return 2; }
    start(dataDir, fresh);
    if (direction === "forward") {
      say(`\n✓ 改好了：库现在是 ${join(dataDir, DB_FILE_NAME)}，原来的位置留了一份路标。可以启动服务了。`);
      say(`  要换回改名之前的版本，先停服务再跑 --rollback。`);
    } else {
      say(`\n✓ 退回好了：库现在是 ${join(dataDir, LEGACY_DB_FILE)}。可以换回改名之前的版本了（新版照样认得它）。`);
    }
    explicitDbWarning();
    return 0;
  });
}

let code;
try { code = main(); } catch (error) { say(`\n✗ ${error.message}`); code = 3; }
process.exit(code);
