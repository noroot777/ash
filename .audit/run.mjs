// 逐个叶子脚本跑一遍,结果追加进 results.jsonl(可续跑)。
// 用法: node .audit/run.mjs [--workers N] [--timeout SEC] [--ids 1,2,3] [--pkg server] [--only-missing]
//       [--progress N] [--label TAG] [--root <被测检出>]
//
// **每一次执行的日志落在 logs/<label>/ 下,不同 label 互不覆盖。** 早先所有执行共用 logs/<叶子名>.log,
// 复核和修复后的验证把初跑那份完整红日志原地盖成了绿日志(第 1 轮自由审查 F2)。label 相同就是
// 「同一次执行续跑」,那才允许写同一个目录。
// --root:被测代码的检出(缺省 = 本工具所在的这一份)。在原基点上重新取证时指向那份 detached 检出,
// 工具、清单和日志仍然落在这里。
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name) => argv.includes(`--${name}`);
const HOME = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const AUDIT = join(HOME, ".audit");
const ROOT = flag("root", HOME).replace(/\/$/, "");
const WORKERS = Number(flag("workers", "4"));
const TIMEOUT = Number(flag("timeout", "600")) * 1000;
const PROGRESS_EVERY = Number(flag("progress", "150"));
const LABEL = flag("label", "sweep");
const LOG_REL = `logs/${LABEL}`;
const LOGS = join(AUDIT, LOG_REL);
mkdirSync(LOGS, { recursive: true });
const BARE = has("bare-env");
const RESULTS = join(AUDIT, flag("out", "results.jsonl"));

const catalog = JSON.parse(readFileSync(join(AUDIT, "catalog.json"), "utf8"));
const PKG_DIR = { root: ROOT, server: join(ROOT, "server"), web: join(ROOT, "web") };

// accept-test.mjs 是门禁编排器本身,它的叶子已各自单列,单跑等于把整条链再跑一遍
const EXCLUDE = new Set(["node scripts/accept-test.mjs"]);

let pool = catalog.leaves.filter((l) => !EXCLUDE.has(l.cmd));
const idsArg = flag("ids", null);
if (idsArg) { const want = new Set(idsArg.split(",").map((s) => Number(s.trim()))); pool = pool.filter((l) => want.has(l.id)); }
const pkgArg = flag("pkg", null);
if (pkgArg) pool = pool.filter((l) => l.pkg === pkgArg);
if (has("gate-only")) pool = pool.filter((l) => l.inGate);
if (has("only-missing") && existsSync(RESULTS)) {
  const done = new Set(readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id));
  pool = pool.filter((l) => !done.has(l.id));
}

const slug = (l) => `${String(l.id).padStart(3, "0")}-${l.pkg}-${(l.cmd.match(/([^/\s]+)\.(ts|tsx|mjs)\b/) ?? [, l.cmd.replace(/\W+/g, "_")])[1]}`;
const TOTAL = pool.length;
let started = 0, finished = 0, green = 0, red = 0;
const t0 = Date.now();

/** 杀 shield 的整个进程组。shield(sh)是组长,所以半径就是这一个叶子。 */
function killGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch {}
}

/** 按 pid 树遍历击杀:先递归收集后代,再从叶子往根开枪。不碰进程组。 */
function killTree(pid) {
  if (!pid) return;
  const kids = (p) => {
    const r = spawnSync("pgrep", ["-P", String(p)], { encoding: "utf8" });
    return (r.stdout ?? "").split("\n").map((s) => Number(s.trim())).filter(Boolean);
  };
  const order = [];
  const walk = (p, depth) => {
    if (depth > 12) return;
    for (const k of kids(p)) { walk(k, depth + 1); order.push(k); }
  };
  walk(pid, 0);
  order.push(pid);
  for (const p of order) { try { process.kill(p, "SIGKILL"); } catch {} }
}

function runOne(leaf) {
  return new Promise((resolve) => {
    const name = slug(leaf);
    const logPath = join(LOGS, `${name}.log`);
    const stage = mkdtempSync(join(tmpdir(), `ash-audit-${leaf.id}-`));
    const env = { ...process.env };
    // **ASH_RUNS_DIR 只在非 bare 模式下设**。它不只是「产物落哪」:
    // server/src/executors/spawn.ts 的 guardAgentSpawn 把「ASH_RUNS_DIR 已设」当作
    // 「我在测试隔离环境里」的判据,于是一律拒绝起执行器。一批测试(test-cli-overrides、
    // test-worktree-recovery、test-native-steer…)自己不设它、并且**指望真的 spawn 出
    // 它们摆在 PATH 上的假 CLI**,照它们被记录的跑法(裸 `tsx scripts/test-X.ts`)那道闸
    // 本来是关着的。全局设上去就把它们判成假红。
    // ASH_DB 则必须设:scripts/tmp-db.ts 的 requireTmpDb 没有它就 exit(1)。
    env.ASH_DB = join(stage, "ash.db");
    if (!BARE) {
      delete env.ASH_ALLOW_REAL_AGENT;
      env.ASH_RUNS_DIR = join(stage, "runs");
      env.ASH_UPLOADS_DIR = join(stage, "uploads");
      env.CI = "1";
    }
    const fd = openSync(logPath, "w");
    const begun = Date.now();
    // **进程组:加一层 shield**。两种朴素写法都出过事:
    //  · detached 直接套在被测脚本上 → 它当上组长,而一批被测产品代码的职责正是「杀干净同组
    //    进程」,于是测试把自己 SIGTERM 掉、报 exit=143 的假红(第一版的坑)。
    //  · 完全不 detached → 测试和本 runner 同组,组杀把 runner 连哨兵外壳一起带走(第二版的
    //    坑:bare2 跑到第 9 条时整树被杀、无退出码)。
    // 正解是 detached 套在 **sh** 上:sh 是组长,被测脚本是组内非组长 —— 和 `npm run test:*`
    // 下「测试继承调用方的组、组长是祖先」完全同形,忠实度不打折;而组杀的半径只到 shield。
    // 命令后面必须再跟一条语句,否则 sh 会 exec 优化掉自己、让被测脚本直接当上组长。
    const child = spawn("sh", ["-c", `${leaf.cmd}\n__rc=$?; exit $__rc`],
      { cwd: PKG_DIR[leaf.pkg], env, stdio: ["ignore", fd, fd], detached: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); killTree(child.pid); }, TIMEOUT);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      closeSync(fd);
      // 收掉还活着的后代(测试自己没收干净的那些)。shield 自己就是组长,所以这一刀
      // 的半径只到本叶子,见上面 spawn 处的说明。
      killGroup(child.pid);
      killTree(child.pid);
      let log = "";
      try { log = readFileSync(logPath, "utf8"); } catch {}
      const bytes = (() => { try { return statSync(logPath).size; } catch { return 0; } })();
      const verdict = timedOut ? "timeout" : code === 0 ? "green" : "red";
      const row = {
        id: leaf.id, pkg: leaf.pkg, cmd: leaf.cmd, inGate: leaf.inGate, entries: leaf.entries,
        label: LABEL, verdict, exitCode: code, signal, ms: Date.now() - begun, log: `.audit/${LOG_REL}/${name}.log`,
        logBytes: bytes, tail: log.slice(-4000), stage,
      };
      appendFileSync(RESULTS, JSON.stringify(row) + "\n");
      if (verdict === "green") { green += 1; try { rmSync(stage, { recursive: true, force: true }); } catch {} }
      else red += 1;
      finished += 1;
      if (finished % PROGRESS_EVERY === 0) {
        console.log(`PROGRESS ${finished}/${TOTAL} green=${green} red=${red} elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
      }
      resolve();
    });
    child.on("error", (err) => {
      clearTimeout(timer); closeSync(fd);
      appendFileSync(RESULTS, JSON.stringify({ id: leaf.id, pkg: leaf.pkg, cmd: leaf.cmd, inGate: leaf.inGate, entries: leaf.entries, label: LABEL, verdict: "spawn-error", error: String(err), ms: Date.now() - begun }) + "\n");
      red += 1; finished += 1; resolve();
    });
  });
}

const queue = [...pool];
const worker = async () => { while (queue.length) { const leaf = queue.shift(); started += 1; await runOne(leaf); } };
console.log(`START total=${TOTAL} workers=${WORKERS} timeout=${TIMEOUT / 1000}s label=${LABEL} bare=${BARE}`);
await Promise.all(Array.from({ length: Math.min(WORKERS, TOTAL) || 1 }, worker));
console.log(`AUDIT_EXIT=0 total=${TOTAL} green=${green} red=${red} elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
