// 库文件名（ash.db → navi.db）的回归：
//   ① 选库：新目录建 navi.db；只有 ash.db 开 ash.db；两份都是库、只剩路标、账本还在 —— 一律不起、说清楚；harness.db 改名成 navi.db；
//   ② 镜像：scripts/db-file.mjs 与 server/src/db/path.ts 常量相同、认法相同；跟着库名走的派生文件都在迁移清单里；
//   ③ 迁移命令：改名带上 -wal 与状态文件、留路标、旧版对着路标起不来；中途失败照原样退回；进程被杀之后接着做 / 撤销；
//      有服务在用（新旧两代的锁）就不动；退回再改名来回都不丢东西；
//   ③b 被杀矩阵：改名、退回、撤回途中，每一步之前 / 之后真杀进程，再 --apply / --rollback，都落在「做完」或「原样」上；
//   ④ 真起服务（本机自用模式、临时 HOME、随机端口）：新目录起出来是 navi.db；两份都是库时不起；只有 ash.db 的目录
//      照常起，迁移之后再起，库里的数据、接力身份、远程访问密钥都还是原来那份。
//   ①里另有：显式 NAVI_DB 也不许开改名做到一半的、不许开路标；启动拿锁时重认一遍，选库之后库改了名就不起。
//
// 跑:`npm -w server run test:db-file`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEGACY_DB_FILE, LEGACY_HARNESS_DB_FILE } from "@navi/shared/legacy-names";
import { clearEnv } from "@navi/shared/env-names";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const serverRoot = join(REPO, "server");
const root = mkdtempSync(join(tmpdir(), "navi-db-file-"));
for (const name of ["NAVI_DB", "NAVI_DATA_DIR", "NAVI_RUNS_DIR", "NAVI_UPLOADS_DIR", "NAVI_ALLOW_MULTI"] as const) clearEnv(process.env, name);
// path.ts 在加载那一刻按 NAVI_DATA_DIR 定数据目录：指到一个空的临时目录再导入。
const defaultData = join(root, "default-data");
process.env.NAVI_DATA_DIR = defaultData; // paths.ts 读完就把它从环境里拿掉
const path = await import("../src/db/path.js");
const mirror = await import(new URL("../../scripts/db-file.mjs", import.meta.url).href);
const core = await import(new URL("../../scripts/rename-db-core.mjs", import.meta.url).href);
const SCRIPT = join(REPO, "scripts", "rename-db.mjs");
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const home = join(root, "home");
mkdirSync(home);

let n = 0;
const dir = (label: string) => { const d = join(root, `${++n}-${label}`); mkdirSync(d, { recursive: true }); return d; };
function makeDb(file: string, rows = 3) {
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0; create table probe (id integer primary key)");
  for (let i = 0; i < rows; i += 1) db.exec(`insert into probe values (${i})`);
  return db; // 不关：最后几笔留在 -wal 里，像正在跑的服务刚写过
}
const rowsIn = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return (db.prepare("select count(*) as n from probe").get() as { n: number }).n; } finally { db.close(); }
};
const run = (data: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, "--data", data, ...args], { encoding: "utf8", env: process.env });
const choose = (data: string) => { try { return path.chooseDbFileIn(data); } catch (error) { return error as Error; } };

try {
  // ── ① 选库 ───────────────────────────────────────────────────────────────
  {
    const fresh = dir("fresh");
    assert.deepEqual(choose(fresh), { file: join(fresh, "navi.db"), legacy: false }, "新目录建 navi.db");
    assert.equal(path.resolveNaviDbFile(), resolve(defaultData, "navi.db"), "缺省数据目录也是 navi.db");

    const legacy = dir("legacy");
    makeDb(join(legacy, LEGACY_DB_FILE)).close();
    assert.deepEqual(choose(legacy), { file: join(legacy, LEGACY_DB_FILE), legacy: true }, "还没迁的老安装照常开 ash.db");

    const both = dir("both");
    makeDb(join(both, LEGACY_DB_FILE)).close();
    makeDb(join(both, "navi.db")).close();
    assert.match(String(choose(both)), /都是库，分不清该开哪一份/, "两份都是库：不起");
    writeFileSync(join(both, LEGACY_DB_FILE), "");
    assert.match(String(choose(both)), /都是库/, "认不出的东西按库算，不替人扔");

    const moved = dir("moved");
    makeDb(join(moved, "navi.db")).close();
    writeFileSync(join(moved, LEGACY_DB_FILE), core.markerText("t"));
    assert.deepEqual(choose(moved), { file: join(moved, "navi.db"), legacy: false }, "路标 + navi.db：开 navi.db");
    rmSync(join(moved, "navi.db"));
    assert.match(String(choose(moved)), /路标.*navi\.db 不在/, "只剩路标：不起，也不建空库");
    assert.equal(existsSync(join(moved, "navi.db")), false);

    const halfway = dir("halfway");
    makeDb(join(halfway, LEGACY_DB_FILE)).close();
    writeFileSync(join(halfway, path.DB_RENAME_JOURNAL), "{}");
    assert.match(String(choose(halfway)), /上次没做完/, "账本在：不起");

    const harness = dir("harness");
    writeFileSync(join(harness, LEGACY_HARNESS_DB_FILE), "db");
    assert.deepEqual(choose(harness), { file: join(harness, "navi.db"), legacy: false });
    assert.equal(readFileSync(join(harness, "navi.db"), "utf8"), "db", "harness.db 就地改名成 navi.db");
    // 脚本侧要开库前问的那一句（drizzle 配置用），跟服务拒绝启动的情形一一对上。
    for (const d of [fresh, legacy, both, moved, halfway, harness]) {
      assert.equal(mirror.unclearDbReason(d) !== null, choose(d) instanceof Error, `${d}：脚本侧认不准的判断跟服务对不上`);
    }
    // 显式指定的库：位置照它，改名的安全闸照旧。
    const explicit = (file: string) => { process.env.NAVI_DB = file; try { return path.resolveNaviDbFile(); } catch (error) { return error as Error; } finally { clearEnv(process.env, "NAVI_DB"); } };
    assert.match(String(explicit(join(halfway, LEGACY_DB_FILE))), /上次没做完/, "显式 NAVI_DB 指着改名做到一半的目录：不起");
    assert.match(String(explicit(join(moved, LEGACY_DB_FILE))), /路标.*NAVI_DB 改成/, "显式 NAVI_DB 指着路标：不起、说清改成哪份");
    assert.equal(explicit(join(legacy, LEGACY_DB_FILE)), join(legacy, LEGACY_DB_FILE), "显式指着一份正常的库：照开");
    // 启动在锁里重认：选完之后（拿锁之前）库被退回成旧名，记住的 navi.db 已经不是那份数据。
    const chosen = path.resolveNaviDbFile();
    path.recheckDbFileChoice(chosen);
    mkdirSync(defaultData, { recursive: true });
    makeDb(join(defaultData, LEGACY_DB_FILE)).close();
    assert.throws(() => path.recheckDbFileChoice(chosen), /启动途中库文件改了名/, "选库之后库改了名：不起");
    rmSync(join(defaultData, LEGACY_DB_FILE));
    console.log("✓ 选库：新建 navi.db、老安装开 ash.db、认不准的三种情形不起、harness.db 改成 navi.db；显式路径也过改名的闸；锁里重认");
  }

  // ── ② 镜像与派生文件清单 ─────────────────────────────────────────────────
  {
    for (const key of ["DB_FILE_NAME", "DB_MOVED_MARKER", "DB_RENAME_JOURNAL"] as const) assert.equal(mirror[key], path[key], `${key} 两份不一样`);
    const d = dir("mirror");
    for (const content of [null, "", "SQLite format 3\0", core.markerText("t"), "NAVI-DB"]) {
      const f = join(d, "probe.db");
      rmSync(f, { force: true });
      if (content !== null) writeFileSync(f, content);
      assert.equal(mirror.legacyDbState(f), path.legacyDbState(f), `认法不一致：${JSON.stringify(content)}`);
    }
    // 服务端拿库名拼出来的每一个文件，迁移时要么跟着改名，要么是只对在跑的进程有意义、挪进留底的。
    const derived = new Set<string>();
    for (const file of spawnSync("git", ["ls-files", "server/src"], { cwd: REPO, encoding: "utf8" }).stdout.split("\n").filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(REPO, file), "utf8");
      const constants = Object.fromEntries([...text.matchAll(/const (\w+) = "([^"]+)";/g)].map((m) => [m[1], m[2]]));
      for (const m of text.matchAll(/`\$\{(?:resolveNaviDbFile\(\)|dbFile|db)\}(?:\$\{(\w+)\}|([-.\w]+))`/g)) {
        const suffix = m[1] ? constants[m[1]] ?? (m[1] === "LEGACY_SINGLETON_LOCK_SUFFIX" ? ".ash.lock" : undefined) : m[2];
        assert.ok(suffix, `${file}：${m[0]} 拼的后缀认不出来`);
        derived.add(suffix);
      }
    }
    for (const suffix of derived) {
      assert.ok(mirror.DB_CARRIED_SUFFIXES.includes(suffix) || mirror.isRuntimeResidue(`navi.db${suffix}`, "navi.db"),
        `服务端在库名后面拼了 ${suffix}，迁移清单里没有它：改名之后这份文件就丢了`);
    }
    for (const s of mirror.DB_CARRIED_SUFFIXES.filter((x: string) => x.endsWith(".jsonl"))) assert.ok(mirror.DB_CARRIED_SUFFIXES.includes(`${s}.1`), `${s} 轮转出的 .1 也要带上`);
    // 拿锁先于开库：入口先加载 startup-lock、再加载 main；startup-lock 的静态依赖碰不到一加载就开库的 db/index.ts。
    const src = join(serverRoot, "src");
    const entry = readFileSync(join(src, "index.ts"), "utf8");
    assert.ok(entry.indexOf('import("./startup-lock.js")') >= 0 && entry.indexOf('import("./startup-lock.js")') < entry.indexOf('import("./main.js")'), "入口要先拿锁再加载 main");
    const reach = new Map<string, string | null>([[join(src, "startup-lock.ts"), null]]);
    for (const [file] of reach) {
      for (const m of readFileSync(file, "utf8").matchAll(/^\s*import\s+(?!type\b)(?:[^'"]*?from\s*)?["'](\.[^"']+)\.js["']/gm)) {
        const next = resolve(file, "..", `${m[1]}.ts`);
        if (existsSync(next) && !reach.has(next)) reach.set(next, file);
      }
    }
    const opener = join(src, "db", "index.ts");
    const chain = (f: string | null | undefined): string => (f ? `${chain(reach.get(f))} → ${f.slice(src.length + 1)}` : "");
    assert.ok(!reach.has(opener), `startup-lock 静态引到了开库的模块：${chain(opener)}`);
    console.log(`✓ 镜像一致；服务端在库名后拼的 ${derived.size} 种文件都在迁移清单里；拿锁先于开库`);
  }

  // ── ③ 迁移命令 ───────────────────────────────────────────────────────────
  {
    const data = dir("migrate");
    // 一份「服务停下那一刻」的库：最后几笔还在 -wal 里没落进主文件（开着的时候拷出来，SQLite 关库时会把 -wal 收掉）。
    const source = dir("migrate-source");
    const live = makeDb(join(source, "x.db"), 5);
    live.exec("insert into probe values (100)");
    copyFileSync(join(source, "x.db"), join(data, LEGACY_DB_FILE));
    copyFileSync(join(source, "x.db-wal"), join(data, `${LEGACY_DB_FILE}-wal`));
    live.close();
    writeFileSync(join(data, `${LEGACY_DB_FILE}.identity.json`), '{"who":"me"}');
    writeFileSync(join(data, `${LEGACY_DB_FILE}.remote-access.json`), '{"key":"k"}');
    writeFileSync(join(data, `${LEGACY_DB_FILE}.bak-before-x`), "user backup");
    const deadPid = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(data, `${LEGACY_DB_FILE}.ash.lock`), JSON.stringify({ pid: Number(deadPid) }));
    // 有人开着：新旧两代的锁都算，什么都不动。
    for (const lock of [`${LEGACY_DB_FILE}.ash.lock`, "navi.db.navi.lock"]) {
      writeFileSync(join(data, lock), JSON.stringify({ pid: process.pid }));
      const r = run(data, "--apply");
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stdout, /有人在用/);
      assert.ok(existsSync(join(data, LEGACY_DB_FILE)) && !existsSync(join(data, "navi.db")), `${lock} 活着时没动`);
      rmSync(join(data, lock));
    }
    writeFileSync(join(data, `${LEGACY_DB_FILE}.ash.lock`), JSON.stringify({ pid: Number(deadPid) }));
    const dry = run(data);
    assert.equal(dry.status, 1, dry.stdout);
    assert.ok(existsSync(join(data, LEGACY_DB_FILE)) && !existsSync(join(data, "navi.db")), "演练什么都不改");

    // 中途失败：改到第三步出错，照原样退回、账本删掉。
    const before = readdirSync(data).sort();
    const plan = core.planSteps(data, { direction: "forward", stamp: "fail" });
    let renames = 0;
    const ops = { rename: (a: string, b: string) => { if (++renames === 3) throw new Error("注入的失败"); renameSync(a, b); },
      writeNew: (p: string, t: string) => writeFileSync(p, t, { flag: "wx" }), unlink: (p: string) => rmSync(p) };
    assert.throws(() => core.start(data, plan, { ops }), /注入的失败（已照账本退回原样）/);
    assert.deepEqual(readdirSync(data).sort(), before, "失败之后数据目录跟动手之前一模一样");

    // 进程在半路被杀：账本留着、服务不起；--apply 接着做完。
    const plan2 = core.planSteps(data, { direction: "forward", stamp: "kill" });
    // 被杀之前做了两步（留底那把死锁、-wal），第二步做完还没来得及记进账本
    writeFileSync(core.journalFile(data), JSON.stringify({ version: 2, direction: "forward", createdAt: "t", leftovers: plan2.leftovers, steps: plan2.steps, phase: "do", progress: 1 }));
    mkdirSync(plan2.leftovers, { recursive: true });
    for (const step of plan2.steps.slice(0, 2)) renameSync(step.from, step.to);
    assert.match(String(choose(data)), /上次没做完/, "半路被杀：服务不起");
    const resumed = run(data, "--apply");
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.match(resumed.stdout, /做完了/);
    assert.equal(existsSync(core.journalFile(data)), false);

    assert.equal(rowsIn(join(data, "navi.db")), 6, "-wal 里的写入跟着过来了");
    assert.equal(readFileSync(join(data, "navi.db.identity.json"), "utf8"), '{"who":"me"}', "接力身份跟着改名");
    assert.equal(readFileSync(join(data, "navi.db.remote-access.json"), "utf8"), '{"key":"k"}', "访问密钥跟着改名");
    assert.equal(readFileSync(join(data, `${LEGACY_DB_FILE}.bak-before-x`), "utf8"), "user backup", "用户自己的备份不动");
    assert.equal(existsSync(join(data, `${LEGACY_DB_FILE}.ash.lock`)), false, "死掉的锁不跟着改名");
    assert.ok(readdirSync(join(data, "backups")).some((d) => readdirSync(join(data, "backups", d)).includes(`${LEGACY_DB_FILE}.ash.lock`)), "挪进留底");
    assert.equal(mirror.legacyDbState(join(data, LEGACY_DB_FILE)), "moved", "原地留了路标");
    // 改名之前的服务对着路标：SQLite 当场拒绝，路标原样不动。
    const oldServer = new DatabaseSync(join(data, LEGACY_DB_FILE));
    try { assert.throws(() => oldServer.exec("pragma journal_mode = wal"), /file is not a database/); } finally { oldServer.close(); }
    assert.equal(mirror.legacyDbState(join(data, LEGACY_DB_FILE)), "moved");
    assert.equal(run(data, "--apply").status, 0, "再跑一次：没有要做的");

    // 退回、再改名：来回都不丢东西。
    const back = run(data, "--rollback");
    assert.equal(back.status, 0, back.stdout + back.stderr);
    assert.deepEqual(choose(data), { file: join(data, LEGACY_DB_FILE), legacy: true });
    assert.equal(rowsIn(join(data, LEGACY_DB_FILE)), 6);
    assert.equal(readFileSync(join(data, `${LEGACY_DB_FILE}.identity.json`), "utf8"), '{"who":"me"}');
    assert.equal(run(data, "--apply").status, 0);
    assert.equal(rowsIn(join(data, "navi.db")), 6);

    // 两份都是库：命令也不动。
    const both = dir("both-cli");
    makeDb(join(both, LEGACY_DB_FILE)).close();
    makeDb(join(both, "navi.db")).close();
    const r = run(both, "--apply");
    assert.equal(r.status, 2);
    assert.match(r.stdout, /都是库/);
    console.log("✓ 迁移命令：带上 -wal 与身份/密钥、留路标挡旧版、失败照原样退回、被杀后接着做、有服务在用不动、来回不丢东西");
  }

  // ── ③b 被杀矩阵 ──────────────────────────────────────────────────────────
  {
    // 子进程照常跑生产的 start()，在第 killAt 次文件操作之前 / 之后 SIGKILL 自己（failAt：那一次操作抛错，好走进撤回）。
    const child = join(root, "crash-child.mjs");
    writeFileSync(child, `import { renameSync, unlinkSync, writeFileSync } from "node:fs";
const core = await import(${JSON.stringify(pathToFileURL(join(REPO, "scripts", "rename-db-core.mjs")).href)});
const [data, direction, when, killAt, failAt] = process.argv.slice(2);
let n = 0;
const wrap = (f) => (...a) => {
  n += 1;
  if (n === Number(failAt)) throw new Error("注入的失败");
  if (n === Number(killAt) && when === "before") process.kill(process.pid, "SIGKILL");
  f(...a);
  if (n === Number(killAt) && when === "after") process.kill(process.pid, "SIGKILL");
};
const ops = { rename: wrap(renameSync), writeNew: wrap((p, t) => writeFileSync(p, t, { flag: "wx" })), unlink: wrap(unlinkSync) };
try { core.start(data, core.planSteps(data, { direction, stamp: "crash" }), { ops }); } catch {}
console.log("OPS " + n);
`);
    const crash = (data: string, direction: string, when = "none", killAt = 0, failAt = 0) =>
      spawnSync(process.execPath, [child, data, direction, when, String(killAt), String(failAt)], { encoding: "utf8" });
    // 数据目录的样子：顶层每个文件的内容摘要（留底目录另算 —— 挪进去的那几份只对死掉的进程有意义；路标里带着时间，只记「是路标」）。
    const shape = (d: string) => readdirSync(d).filter((f) => f !== "backups").sort()
      .map((f) => `${f}:${mirror.legacyDbState(join(d, f)) === "moved" ? "路标" : createHash("sha256").update(readFileSync(join(d, f))).digest("hex").slice(0, 12)}`).join(" ");
    const legacyBase = dir("crash-legacy");
    makeDb(join(legacyBase, LEGACY_DB_FILE), 4).close();
    writeFileSync(join(legacyBase, `${LEGACY_DB_FILE}.identity.json`), '{"who":"me"}');
    writeFileSync(join(legacyBase, `${LEGACY_DB_FILE}.remote-access.json`), '{"key":"k"}');
    const deadPid = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(legacyBase, `${LEGACY_DB_FILE}.ash.lock`), JSON.stringify({ pid: Number(deadPid) }));
    const renamedBase = dir("crash-renamed");
    cpSync(legacyBase, renamedBase, { recursive: true });
    assert.equal(run(renamedBase, "--apply").status, 0);
    let cases = 0;
    for (const [direction, base] of [["forward", legacyBase], ["backward", renamedBase]] as const) {
      const scratch = dir(`crash-${direction}-clean`);
      cpSync(base, scratch, { recursive: true });
      const total = Number(/OPS (\d+)/.exec(crash(scratch, direction).stdout)![1]);
      const finished = shape(scratch);
      const original = shape(base);
      assert.notEqual(finished, original);
      // 最后一步失败时，撤回要做几次操作
      const failing = dir(`crash-${direction}-fail`);
      cpSync(base, failing, { recursive: true });
      const undoOps = Number(/OPS (\d+)/.exec(crash(failing, direction, "none", 0, total).stdout)![1]) - total;
      assert.equal(shape(failing), original, `${direction}：最后一步失败，照原样退回`);
      const points = [
        ...Array.from({ length: total }, (_, i) => ({ killAt: i + 1, failAt: 0 })),
        ...Array.from({ length: undoOps }, (_, i) => ({ killAt: total + 1 + i, failAt: total })),
      ];
      for (const { killAt, failAt } of points) {
        for (const when of ["before", "after"]) {
          const label = `${direction} ${failAt ? "撤回途中" : ""}第 ${killAt} 次操作${when === "before" ? "之前" : "之后"}被杀`;
          // 账本里记的是绝对路径：每种接着处理的办法各自从头造一次现场，就地处理。
          const kill = (tag: string) => {
            const crashed = dir(`crash-${direction}-${killAt}-${when}-${tag}`);
            cpSync(base, crashed, { recursive: true });
            // 被杀 = 没走到最后那句 OPS（Windows 上自杀报的是退出码，不是信号）
            assert.doesNotMatch(crash(crashed, direction, when, killAt, failAt).stdout, /OPS/, label);
            assert.ok(existsSync(core.journalFile(crashed)), `${label}：账本留着`);
            assert.match(String(choose(crashed)), /上次没做完/, `${label}：服务不起`);
            return crashed;
          };
          for (const mode of failAt ? ["--rollback"] : ["--apply", "--rollback"]) {
            const crashed = kill(mode.slice(2));
            const r = run(crashed, mode);
            assert.equal(r.status, 0, `${label} → ${mode}：${r.stdout}${r.stderr}`);
            assert.equal(shape(crashed), mode === "--apply" ? finished : original, `${label} → ${mode}：没落在${mode === "--apply" ? "做完" : "原样"}上`);
            assert.equal(existsSync(join(crashed, "backups")), existsSync(join(mode === "--apply" ? scratch : base, "backups")), `${label} → ${mode}：留底目录收拾干净`);
            assert.equal(existsSync(core.journalFile(crashed)), false);
            cases += 1;
          }
          if (failAt) {
            const crashed = kill("apply");
            const r = run(crashed, "--apply");
            assert.equal(r.status, 2, `${label}：撤到一半时 --apply 不接着往前做`);
            assert.match(r.stdout, /只能先 --rollback/);
            assert.ok(existsSync(core.journalFile(crashed)), `${label}：--apply 拒绝时账本原样留着`);
          }
        }
      }
    }
    console.log(`✓ 被杀矩阵：改名、退回、撤回途中每一步前后被杀，${cases} 种接着处理都落在「做完」或「原样」上`);
  }

  // ── ④ 真起服务 ───────────────────────────────────────────────────────────
  {
    const freshData = dir("serve-fresh");
    await withServer(freshData, async () => null);
    assert.ok(existsSync(join(freshData, "navi.db")) && !existsSync(join(freshData, LEGACY_DB_FILE)), "新数据目录起出来是 navi.db");
    const bothData = dir("serve-both");
    makeDb(join(bothData, LEGACY_DB_FILE)).close();
    makeDb(join(bothData, "navi.db")).close();
    await assert.rejects(withServer(bothData, async () => null), /服务没起来[\s\S]*都是库，分不清该开哪一份/, "两份都是库：服务不起、说清楚");

    const oldData = dir("serve-legacy");
    await withServer(oldData, async () => null);
    // 造一份「改名之前的安装」：同一份库和状态文件换回旧名。
    for (const name of readdirSync(oldData)) if (name.startsWith("navi.db")) renameSync(join(oldData, name), join(oldData, `${LEGACY_DB_FILE}${name.slice("navi.db".length)}`));
    const seeded = new DatabaseSync(join(oldData, LEGACY_DB_FILE));
    seeded.exec("create table probe (id integer primary key); insert into probe values (1), (2), (3)");
    seeded.close();
    const before = await withServer(oldData, fingerprint);
    assert.ok(!existsSync(join(oldData, "navi.db")), "老安装照常开 ash.db，不在运行时改名");
    assert.ok(existsSync(join(oldData, `${LEGACY_DB_FILE}.identity.json`)), "身份跟着旧库名落盘");
    const key = "k".repeat(43);
    writeFileSync(join(oldData, `${LEGACY_DB_FILE}.remote-access.json`), JSON.stringify({ version: 1, key, createdAt: "2026-01-01T00:00:00.000Z", devices: [], hosts: [] }));
    const migrated = run(oldData, "--apply");
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    const after = await withServer(oldData, fingerprint);
    assert.equal(rowsIn(join(oldData, "navi.db")), 3, "库里的数据还在");
    assert.equal(after, before, "接力身份（指纹）还是原来那台");
    assert.equal(JSON.parse(readFileSync(join(oldData, "navi.db.remote-access.json"), "utf8")).key, key, "远程访问密钥还是原来那份");
    assert.equal(mirror.legacyDbState(join(oldData, LEGACY_DB_FILE)), "moved");
    console.log("✓ 真起服务：新目录是 navi.db；两份都是库时不起；老安装照常起、迁移之后数据/身份/访问密钥都在");
  }
  console.log("[db-file] all checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((done) => s.close(() => done()));
  return port;
}

/** 本机的接力指纹（探活接口现算，身份文件不在就当场生成一份）。 */
async function fingerprint(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/handoff/ping?intent=probe&nonce=x`);
  const body = await res.json() as { identity?: { fingerprint?: string } };
  assert.ok(body.identity?.fingerprint, `探活没报指纹：${JSON.stringify(body)}`);
  return body.identity.fingerprint;
}

/** 在 data 上起一次真服务，等到它报就绪，跑完 body 再停掉、等它退干净。 */
async function withServer<T>(data: string, body: (port: number) => Promise<T>): Promise<T> {
  const port = await freePort();
  // 环境从零拼：不带门禁或本机 shell 里的库/数据目录变量，也不去问本机真装着的 CLI。Windows 上子进程离了
  // SystemRoot、PATH 起不来，那边照抄这几项。
  const win = process.platform === "win32"
    ? Object.fromEntries(["SystemRoot", "PATH", "Path", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "PATHEXT", "ComSpec"].flatMap((k) => process.env[k] ? [[k, process.env[k]!]] : []))
    : { PATH: "/usr/bin:/bin" };
  const env = { ...win, HOME: home, USERPROFILE: home, PORT: String(port), NAVI_LOCAL_ONLY: "1", NAVI_DATA_DIR: data, NAVI_TEST_NO_MODEL_PROBE: "1" };
  const child = spawn(process.execPath, ["--import", tsx, "src/index.ts"], { cwd: serverRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const exited = new Promise((done) => child.once("exit", done));
  try {
    const deadline = Date.now() + 60_000;
    while (!/server on/.test(output)) {
      if (child.exitCode !== null) throw new Error(`服务没起来：\n${output}`);
      if (Date.now() > deadline) throw new Error(`等不到就绪：\n${output}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    return await body(port);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}
