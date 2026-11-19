#!/usr/bin/env node
// scripts/relocate-checkout.mjs 的边界回归（主流程在 test-relocate-checkout.mjs）：每条用例自己造一棵最小的树，
// 钉住归属、撞名、资源根、离线兄弟目录、维护锁、目录权限、退回预检这几类「判不准就不许动」的口径。
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { apply } from "./relocate-checkout-apply.mjs";
import { Journal } from "./relocate-checkout-journal.mjs";
import { acquire, liveHolders, release } from "./relocate-checkout-lock.mjs";
import { claudeSlug } from "./relocate-checkout-paths.mjs";
import { scan } from "./relocate-checkout-scan.mjs";

const SCRIPT = fileURLToPath(new URL("./relocate-checkout.mjs", import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|CODEX_HOME$|XDG_|CLAUDE_CONFIG_DIR$|(NAVI|ASH|HARNESS)_)/.test(k)));
const write = (file, text) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };
const jsonl = (cwd) => `${JSON.stringify({ cwd, type: "user" })}\n`;

let passed = 0;
const bases = [];

/** 一棵最小的树：git 仓库、一个工作区、一份库。返回路径和跑 CLI 的函数。 */
function tree({ dataLink = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "relocate-edge-")));
  bases.push(base);
  const home = base;
  const from = join(base, "code", "harness");
  const to = join(base, "code", "navi");
  mkdirSync(from, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", from, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { env, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", ".worktrees/T1", "-b", "T1");
  const data = dataLink ? join(base, "real-data") : join(from, "data");
  mkdirSync(data, { recursive: true });
  if (dataLink) symlinkSync(data, join(from, "data"));
  const db = new DatabaseSync(join(data, "ash.db"));
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, repo_path TEXT); CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, title TEXT, body TEXT);");
  db.prepare("INSERT INTO projects VALUES ('p1', ?)").run(from);
  db.prepare("INSERT INTO tasks VALUES ('t1', 'done', 't', ?)").run(`在 ${from}/.worktrees/T1 干活`);
  db.close();
  const projects = join(home, ".claude", "projects");
  const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [SCRIPT, "--from", from, "--to", to, "--home", home, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", cwd: base });
  return { base, home, from, to, data, projects, cli };
}

const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };
const out = (r) => r.stdout + r.stderr;

try {
  test("F1 归属：名字撞上工作区的兄弟项目（只有记忆）不认领；--claude-skip 优先于一切；混着树外会话的整目录不动", () => {
    const t = tree();
    // `<from>--worktrees-T1` 是另一个项目，它的 claude 目录名和 `<from>/.worktrees/T1` 的一模一样。
    const twin = join(t.base, "code", "harness--worktrees-T1");
    mkdirSync(twin);
    const dir = join(t.projects, claudeSlug(`${t.from}/.worktrees/T1`));
    write(join(dir, "memory", "m.md"), `兄弟项目 ${twin} 的记忆\n`);
    const mixed = join(t.projects, `${claudeSlug(t.from)}-x`);
    write(join(mixed, "a.jsonl"), jsonl(t.from));
    write(join(mixed, "b.jsonl"), jsonl(join(t.base, "code", "harness-x")));
    const r = t.cli([]);
    assert.match(r.stdout, /2 个目录认不出/, out(r));
    assert.match(r.stdout, /混着树里和树外/);
    assert.match(r.stdout, /claude 会话目录要改名：0 个/);
    const skip = t.cli(["--apply", "--claude-skip", claudeSlug(`${t.from}/.worktrees/T1`), "--claude-skip", mixed]);
    assert.ok([0, 1].includes(skip.status), out(skip));
    assert.equal(readFileSync(join(dir, "memory", "m.md"), "utf8"), `兄弟项目 ${twin} 的记忆\n`, "点名跳过的原地不动");
    assert.ok(!existsSync(join(t.projects, claudeSlug(`${t.to}/.worktrees/T1`))), "也没有搬到新名下");
    assert.deepEqual(readdirSync(mixed).sort(), ["a.jsonl", "b.jsonl"]);
    const bare = t.cli(["--claude-claim", claudeSlug(t.from)]);
    assert.equal(bare.status, 2, "认领只收完整路径");
  });

  test("F1 映射：账本里记过的改名才拿来改文本引用；退回后这笔映射作废", () => {
    const t = tree();
    const wt = join(t.projects, claudeSlug(`${t.from}/.worktrees/T1`));
    write(join(wt, "s.jsonl"), jsonl(`${t.from}/.worktrees/T1`));
    write(join(t.projects, claudeSlug(t.from), "m.jsonl"), jsonl(t.from));
    write(join(t.projects, claudeSlug(t.from), "memory", "a.md"), `工作区会话在 ~/.claude/projects/${claudeSlug(`${t.from}/.worktrees/T1`)}/s.jsonl\n`);
    assert.ok([0, 1].includes(t.cli(["--apply"]).status));
    const mem = readFileSync(join(t.projects, claudeSlug(t.to), "memory", "a.md"), "utf8");
    assert.equal(mem, `工作区会话在 ~/.claude/projects/${claudeSlug(`${t.to}/.worktrees/T1`)}/s.jsonl\n`);
    const history = Journal.claudeHistory(t.home, { from: t.from, to: t.to });
    assert.equal(history.get(`${join(t.home, ".claude")}/projects/${claudeSlug(`${t.from}/.worktrees/T1`)}`), claudeSlug(`${t.to}/.worktrees/T1`));
    assert.equal(t.cli(["--rollback"]).status, 0);
    assert.equal(Journal.claudeHistory(t.home, { from: t.from, to: t.to }).size, 0);
  });

  test("F2 TOML：表头带行尾注释、旧新两张表并存，或 ~/ 写法撞名，都拦下真做，一个字节不动", () => {
    for (const [label, body] of [
      ["行尾注释", (t) => `[projects."${t.from}"] # 旧\ntrust_level = "trusted"\n\n[projects."${t.to}"] # 新\ntrust_level = "untrusted"\n`],
      ["~/ 写法", () => `[projects.'~/code/harness']\na = 1\n\n[projects."~/code/navi"]\nb = 2\n`],
    ]) {
      const t = tree();
      const file = join(t.home, ".codex", "config.toml");
      write(file, body(t));
      const text = readFileSync(file, "utf8");
      const r = t.cli(["--apply"]);
      assert.equal(r.status, 2, `${label}：${out(r)}`);
      assert.match(r.stdout, /改完会和已有的 .* 重名/, label);
      assert.equal(readFileSync(file, "utf8"), text, label);
      assert.ok(existsSync(t.from) && !existsSync(t.to), `${label}：目录没搬`);
    }
  });

  test("F3 资源根：XDG 数据/配置目录、显式 --db 都在树里时，--no-link 搬完照样改到、核对看得见", () => {
    const t = tree();
    const xdg = { XDG_DATA_HOME: join(t.from, "xdg-data"), XDG_CONFIG_HOME: join(t.from, "xdg-config"), NAVI_DB: join(t.from, "data", "ash.db") };
    mkdirSync(join(xdg.XDG_DATA_HOME, "opencode"), { recursive: true });
    const oc = new DatabaseSync(join(xdg.XDG_DATA_HOME, "opencode", "opencode.db"));
    oc.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)");
    oc.prepare("INSERT INTO session VALUES ('o1', ?)").run(`${t.from}/.worktrees/T1`);
    oc.close();
    write(join(xdg.XDG_CONFIG_HOME, "opencode", "opencode.json"), `${JSON.stringify({ mcp: { navi: { command: [`${t.from}/mcp/x.js`] } } })}\n`);
    const db = ["--db", join(t.from, "data", "ash.db")];
    const r = t.cli(["--apply", "--no-link", ...db], xdg);
    assert.equal(r.status, 1, out(r));
    for (const name of Object.keys(xdg)) assert.match(r.stdout, new RegExp(`环境变量 ${name} 还写着旧位置`), name);
    const moved = { XDG_DATA_HOME: join(t.to, "xdg-data"), XDG_CONFIG_HOME: join(t.to, "xdg-config"), NAVI_DB: join(t.to, "data", "ash.db") };
    const ocAfter = new DatabaseSync(join(moved.XDG_DATA_HOME, "opencode", "opencode.db"), { readOnly: true });
    assert.equal(ocAfter.prepare("SELECT directory FROM session").get().directory, `${t.to}/.worktrees/T1`);
    ocAfter.close();
    assert.ok(readFileSync(join(moved.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8").includes(`${t.to}/mcp/x.js`));
    // 搬完之后环境变量还写着旧位置：脚本自己照样找得到东西，但服务和 CLI 照原值读，所以核对不算完；
    // 在改过的环境里核对才干净。一次性的 --db 照旧写旧位置没关系（只给脚本自己找库用）。
    const stale = t.cli(["--verify", ...db], xdg);
    assert.equal(stale.status, 1, out(stale));
    assert.match(stale.stdout, new RegExp(`XDG_DATA_HOME=${moved.XDG_DATA_HOME}`));
    const v = t.cli(["--verify", ...db], moved);
    assert.equal(v.status, 0, out(v));
    assert.match(v.stdout, /opencode 会话的工作目录要改：0 条\n/);
    assert.ok(!v.stdout.includes("没装 opencode"));
  });

  test("F4 离线兄弟目录：库里登记的 `<旧根> copy2` 此刻不在磁盘上，它和正文里提到它的地方都不改", () => {
    const t = tree();
    const copy2 = `${t.from} copy2`;
    const db = new DatabaseSync(join(t.data, "ash.db"));
    db.prepare("INSERT INTO projects VALUES ('p2', ?)").run(copy2);
    db.prepare("INSERT INTO tasks VALUES ('t2', 'done', 't', ?)").run(`对比 ${copy2}/src 和 ${t.from}/src`);
    db.close();
    assert.ok([0, 1].includes(t.cli(["--apply"]).status));
    const after = new DatabaseSync(join(t.to, "data", "ash.db"), { readOnly: true });
    assert.equal(after.prepare("SELECT repo_path FROM projects WHERE id='p2'").get().repo_path, copy2);
    assert.equal(after.prepare("SELECT body FROM tasks WHERE id='t2'").get().body, `对比 ${copy2}/src 和 ${t.to}/src`);
    after.close();
  });

  test("F4 分不清的：库里旧根后面紧跟汉字的，不换、核对不算干净，看过之后 --accept-ambiguous 才放行", () => {
    const t = tree();
    const db = new DatabaseSync(join(t.data, "ash.db"));
    db.prepare("INSERT INTO tasks VALUES ('t3', 'done', 't', ?)").run(`说明：${t.from}对比一下`);
    db.close();
    const r = t.cli(["--apply"]);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /库里 1 处分不清归属的旧路径/);
    assert.equal(t.cli(["--verify", "--accept-ambiguous"]).status, 0);
  });

  test("F5 维护锁：data 是链接时锁落在真实位置、服务看得见；数据目录还没有就先建出来再锁，放锁时删掉", () => {
    const t = tree({ dataLink: true });
    const dbFile = join(t.from, "data", "ash.db");
    const lock = acquire({ dbFile, runsDirs: [join(t.from, "data", "runs")] }, "测试");
    try {
      assert.ok(readdirSync(t.data).some((n) => n.endsWith(".maintenance.lock")), "锁在链接指着的目录里");
      const other = spawnSync(process.execPath, ["--input-type=module", "-e", `import { liveHolders } from ${JSON.stringify(new URL("./relocate-checkout-lock.mjs", import.meta.url).href)}; console.log(JSON.stringify(liveHolders(${JSON.stringify(join(t.data, "ash.db"))})))`], { encoding: "utf8" });
      assert.match(JSON.parse(other.stdout).reasons.join(), /正在维护这份数据/, other.stderr);
    } finally {
      release(lock);
    }
    assert.ok(!readdirSync(t.data).some((n) => n.includes("maintenance")));
    const empty = join(t.base, "nodata", "data");
    const l2 = acquire({ dbFile: join(empty, "ash.db"), runsDirs: [join(empty, "runs")] }, "测试");
    assert.ok(readdirSync(empty).some((n) => n.endsWith(".maintenance.lock")));
    release(l2);
    assert.ok(!existsSync(join(t.base, "nodata")), "替它建的目录空着就删掉");
    assert.equal(liveHolders(join(t.data, "ash.db")).errors.length, 0);
  });

  test("F5 搬完复查：目录一搬完就有进程进到新位置，停下不往下做；账本读不了时退回报错而不是说「没有」", () => {
    const t = tree();
    const journal = Journal.create(t.home, { from: t.from, to: t.to });
    const plan = scan({ from: t.from, to: t.to, home: t.home, env, claims: {} });
    let pid;
    const log = (line) => {
      if (pid || !line.includes("目录：")) return;
      // 交给 sh 放到后台再退出：脚本只把自己的直接子进程（它拉起的 lsof / ps）当成自己人，这个不是。
      pid = Number(spawnSync("/bin/sh", ["-c", "sleep 30 </dev/null >/dev/null 2>&1 & echo $!"], { cwd: t.to, encoding: "utf8" }).stdout.trim());
    };
    try {
      assert.throws(() => apply(plan, { journal, link: true, log, home: t.home, env, claims: {} }), /工作目录在/);
    } finally {
      if (pid) process.kill(pid);
    }
    const relocate = join(t.home, ".navi-relocate");
    chmodSync(relocate, 0o000);
    const r = t.cli(["--rollback"]);
    chmodSync(relocate, 0o755);
    assert.equal(r.status, 2, out(r));
    assert.match(r.stdout, /列不了账本目录/);
    assert.equal(t.cli(["--rollback"]).status, 0);
    assert.ok(existsSync(t.from) && !existsSync(t.to));
  });

  test("F6 权限：并进已有目录后删掉的源目录（0700），退回时按原权限建回；N1 同一毫秒的两份账本不共用目录", () => {
    const t = tree();
    const src = join(t.projects, claudeSlug(`${t.from}/.worktrees/T1`));
    write(join(src, "s.jsonl"), jsonl(`${t.from}/.worktrees/T1`));
    write(join(t.projects, claudeSlug(`${t.to}/.worktrees/T1`), "n.jsonl"), jsonl(`${t.to}/.worktrees/T1`));
    chmodSync(src, 0o700);
    chmodSync(join(t.projects, claudeSlug(`${t.to}/.worktrees/T1`)), 0o700); // 目标比源宽会被拦下（见下面的「合并权限」）
    assert.ok([0, 1].includes(t.cli(["--apply"]).status));
    assert.ok(!existsSync(src));
    assert.equal(t.cli(["--rollback"]).status, 0);
    assert.equal(statSync(src).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(src), ["s.jsonl"]);
    const a = Journal.create(t.home, { from: "/a", to: "/b" });
    const b = Journal.create(t.home, { from: "/c", to: "/d" });
    assert.notEqual(a.dir, b.dir);
  });

  test("N3 退回预检：有进程的工作目录在树里就不退，什么都不动", () => {
    const t = tree();
    assert.ok([0, 1].includes(t.cli(["--apply"]).status));
    const child = spawn("/bin/sleep", ["30"], { cwd: join(t.to, ".worktrees", "T1"), stdio: "ignore" });
    try {
      const r = t.cli(["--rollback"]);
      assert.equal(r.status, 2, out(r));
      assert.match(r.stdout, new RegExp(`不能退回[\\s\\S]*${child.pid}`));
      assert.ok(existsSync(t.to) && lstatSync(t.from).isSymbolicLink(), "还是搬完的样子");
    } finally {
      child.kill();
    }
  });
  test("合并目标：新名字是指向别的项目的链接、旧名字本身是链接，都不动；别的项目一个字节不多", () => {
    const t = tree();
    const other = join(t.base, "other-project");
    mkdirSync(other);
    const src = join(t.projects, claudeSlug(`${t.from}/.worktrees/T1`));
    write(join(src, "s.jsonl"), jsonl(`${t.from}/.worktrees/T1`));
    symlinkSync(other, join(t.projects, claudeSlug(`${t.to}/.worktrees/T1`)));
    const realMain = join(t.base, "elsewhere-main");
    write(join(realMain, "m.jsonl"), jsonl(t.from));
    symlinkSync(realMain, join(t.projects, claudeSlug(t.from)));
    const grok = join(t.home, ".grok", "sessions");
    write(join(grok, encodeURIComponent(`${t.from}/.worktrees/T1`), "g", "chat.jsonl"), "{}\n");
    symlinkSync(other, join(grok, encodeURIComponent(`${t.to}/.worktrees/T1`)));
    const dry = t.cli([]);
    assert.match(dry.stdout, /新名字 .* 已经有了，但它是链接，不往里并/, out(dry));
    assert.match(dry.stdout, new RegExp(`${claudeSlug(t.from).replace(/[-]/g, "\\-")}（是链接，不动`));
    const r = t.cli(["--apply"]);
    assert.equal(r.status, 1, out(r));
    assert.deepEqual(readdirSync(other), [], "别的项目里什么都没进去");
    assert.deepEqual(readdirSync(src), ["s.jsonl"]);
    assert.ok(existsSync(join(grok, encodeURIComponent(`${t.from}/.worktrees/T1`), "g", "chat.jsonl")));
  });

  test("合并权限：目标比源宽（0755 并 0700）就拦下真做，什么都不动；目标收紧到 0700 后才并", () => {
    const t = tree();
    const src = join(t.projects, claudeSlug(`${t.from}/.worktrees/T1`));
    const dst = join(t.projects, claudeSlug(`${t.to}/.worktrees/T1`));
    write(join(src, "s.jsonl"), jsonl(`${t.from}/.worktrees/T1`));
    write(join(dst, "n.jsonl"), jsonl(`${t.to}/.worktrees/T1`));
    chmodSync(src, 0o700);
    chmodSync(dst, 0o755);
    const r = t.cli(["--apply"]);
    assert.equal(r.status, 2, out(r));
    assert.match(r.stdout, /目标权限 0755 比源 0700 宽/);
    assert.ok(existsSync(t.from) && !existsSync(t.to) && existsSync(join(src, "s.jsonl")));
    chmodSync(dst, 0o700);
    assert.ok([0, 1].includes(t.cli(["--apply"]).status));
    assert.deepEqual(readdirSync(dst).sort(), ["n.jsonl", "s.jsonl"]);
    assert.equal(statSync(dst).mode & 0o777, 0o700);
  });

  test("配置里的合法转义：JSONC / TOML 里写成 \\u002f 的旧路径也认得、改得到，注释照留，改完按值核对", () => {
    const t = tree();
    const esc = (p) => p.replace(/\//g, "\\u002f");
    const jsonc = join(t.home, ".config", "opencode", "opencode.jsonc");
    write(jsonc, `{\n  // 工具在 ${t.from}/mcp\n  "mcp": { "navi": { "command": ["${esc(`${t.from}/mcp/x.js`)}"], }, },\n}\n`);
    const toml = join(t.home, ".codex", "config.toml");
    write(toml, `[projects.'${t.from}'] # 旧\ntrust_level = "trusted"\n\n[mcp_servers.navi]\nargs = ["${esc(`${t.from}/mcp/x.js`)}"]\n`);
    const r = t.cli(["--apply", "--no-link"]);
    assert.equal(r.status, 0, out(r));
    const j = readFileSync(jsonc, "utf8");
    assert.ok(j.includes(`// 工具在 ${t.to}/mcp`) && j.includes(`"${t.to}/mcp/x.js"`), j);
    const parsed = JSON.parse(spawnSync("python3", ["-c", "import sys, json, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))", toml], { encoding: "utf8" }).stdout);
    assert.deepEqual(Object.keys(parsed.projects), [t.to]);
    assert.deepEqual(parsed.mcp_servers.navi.args, [`${t.to}/mcp/x.js`]);
    assert.equal(t.cli(["--verify"]).status, 0);
  });

  test("归属证据：有一份会话记录读不出工作目录就整目录不动（点名认领才搬）；同一个会话号两份记录对不上也不认", () => {
    const t = tree();
    const dir = join(t.projects, claudeSlug(`${t.from}/.worktrees/T1`));
    write(join(dir, "a.jsonl"), jsonl(`${t.from}/.worktrees/T1`));
    write(join(dir, "b.jsonl"), `${JSON.stringify({ type: "summary" })}\n`);
    // 工作流目录：会话号 sid 的记录有两份，一份在树里、一份在树外。
    const wf = join(t.projects, `${claudeSlug(`${t.from}/.worktrees/T1`)}-server`);
    mkdirSync(join(wf, "sid"), { recursive: true });
    write(join(t.projects, `${claudeSlug(t.from)}-x`, "sid.jsonl"), jsonl(join(t.base, "code", "harness-x")));
    write(join(t.projects, claudeSlug(t.from), "sid.jsonl"), jsonl(t.from));
    const dry = t.cli([]);
    assert.match(dry.stdout, /1 份会话记录读不出工作目录/, out(dry));
    assert.match(dry.stdout, new RegExp(`${wf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}（目录里没有会话记录`));
    assert.ok([0, 1].includes(t.cli(["--apply", "--claude-claim", dir]).status));
    assert.ok(existsSync(join(t.projects, claudeSlug(`${t.to}/.worktrees/T1`), "b.jsonl")), "点名认领的搬了");
    assert.ok(existsSync(join(wf, "sid")), "对不上的不动");
  });

  test("认领参数：配置目录在树里时，搬前给的完整路径搬后照样认；读不懂的维护锁按「不知道」拦下", () => {
    const t = tree();
    const personal = join(t.from, "data", "user-cli", "u1", "claude");
    const dir = join(personal, "projects", claudeSlug(`${t.from}/.worktrees/T1`));
    write(join(dir, "memory", "m.md"), `在 ${t.from}/.worktrees/T1\n`);
    const claim = ["--claude-claim", dir];
    assert.ok([0, 1].includes(t.cli(["--apply", ...claim]).status));
    const moved = join(t.to, "data", "user-cli", "u1", "claude", "projects", claudeSlug(`${t.to}/.worktrees/T1`));
    assert.equal(readFileSync(join(moved, "memory", "m.md"), "utf8"), `在 ${t.to}/.worktrees/T1\n`);
    assert.equal(t.cli(["--verify", ...claim]).status, 0);
    const u = tree();
    writeFileSync(join(u.data, "ash.db.maintenance.lock"), "{ 半份");
    const r = u.cli(["--apply"]);
    assert.equal(r.status, 2, out(r));
    assert.match(r.stdout, /维护锁 .* 读不懂/);
  });
} finally {
  for (const b of bases) { try { chmodSync(join(b, ".navi-relocate"), 0o755); } catch { /* 没有 */ } rmSync(b, { recursive: true, force: true }); }
}
console.log(`\n${passed} passed`);
