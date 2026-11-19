#!/usr/bin/env node
// scripts/relocate-checkout.mjs 的回归：在临时目录里造一棵带工作区（含 --relative-paths 登记的）、嵌套仓库、
// 树外工作区、绝对链接、WAL 模式的库、执行器会话目录（含个人档）、各家配置（含指向 dotfiles 的链接）的树，
// 跑演练 / 各种预检拦截 / 账本写不进去 / 真做 / 核对 / 重跑 / 中途失败后接着做 / 退回（逐字节回到原样）/
// 不留链接 / 拿掉链接。兄弟目录（`harness-old`、`harness中文`、`harness copy`）一个字节都不许碰。
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { apply } from "./relocate-checkout-apply.mjs";
import { Journal } from "./relocate-checkout-journal.mjs";
import { claudeSlug, rewriteJson, rewriteRules, rewriteText } from "./relocate-checkout-paths.mjs";
import { scan } from "./relocate-checkout-scan.mjs";

const SCRIPT = fileURLToPath(new URL("./relocate-checkout.mjs", import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|CODEX_HOME$|XDG_|CLAUDE_CONFIG_DIR$)/.test(k)));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (file, text) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

// ── 路径规则 ─────────────────────────────────────────────────────────────
test("边界：兄弟目录（含中文名、空格后缀）、同名前缀、别的路径里的一段都不换；正文里紧挨汉字的照换", () => {
  const claudeName = (n) => (n.startsWith("-u-code-harness--worktrees-A") ? `-u-code-navi${n.slice("-u-code-harness".length)}` : null);
  const rules = rewriteRules({ from: "/u/code/harness", to: "/u/code/navi", home: "/u", siblings: [" copy"], claudeName });
  const r = (s) => rewriteText(s, rules).text;
  assert.equal(r("cd /u/code/harness && ls /u/code/harness/x"), "cd /u/code/navi && ls /u/code/navi/x");
  assert.equal(r("/u/code/harness-old /u/code/harness2 /u/code/harness.bak/a /u/code/harness@b"), "/u/code/harness-old /u/code/harness2 /u/code/harness.bak/a /u/code/harness@b");
  assert.equal(r("/u/code/harness中文"), "/u/code/harness中文");
  assert.equal(r("/u/code/harness中文/x 和 /u/code/harness/y"), "/u/code/harness中文/x 和 /u/code/navi/y");
  assert.equal(r("/u/code/harness copy/x 与 /u/code/harness (2)"), "/u/code/harness copy/x 与 /u/code/navi (2)");
  assert.equal(r("/u/code/harness:2"), "/u/code/harness:2", "整条路径：后面接着目录名里也能有的标点，是另一个目录");
  assert.equal(r("/v/u/code/harness/a"), "/v/u/code/harness/a");
  assert.equal(r("截图目录/u/code/harness/a.png；仓库是 /u/code/harness。还有 /u/code/harness，分支"), "截图目录/u/code/navi/a.png；仓库是 /u/code/navi。还有 /u/code/navi，分支");
  assert.equal(r('"a":"x\\n/u/code/harness/data"'), '"a":"x\\n/u/code/navi/data"');
  assert.equal(r("file:///u/code/harness/a.png"), "file:///u/code/navi/a.png");
  assert.equal(r("~/code/harness/data ~/code/harnessX ~/code/harness中文"), "~/code/navi/data ~/code/harnessX ~/code/harness中文");
  assert.equal(r("/u/.claude/projects/-u-code-harness--worktrees-A/x /u/.claude/projects/-u-code-harness-old/y -u-code-harness"), "/u/.claude/projects/-u-code-navi--worktrees-A/x /u/.claude/projects/-u-code-harness-old/y -u-code-harness");
});

test("JSON 键改完撞名：两份都原样留着，记进 collisions", () => {
  const rules = rewriteRules({ from: "/u/code/harness", to: "/u/code/navi" });
  const collisions = [];
  const out = rewriteJson({ "/u/code/harness": { a: 1 }, "/u/code/navi": { b: 2 }, "/u/code/harness/x": "/u/code/harness/y" }, rules, collisions);
  assert.deepEqual(out, { "/u/code/harness": { a: 1 }, "/u/code/navi": { b: 2 }, "/u/code/navi/x": "/u/code/navi/y" });
  assert.deepEqual(collisions.map((c) => c.existing), ["/u/code/navi"]);
});

// ── 夹具 ───────────────────────────────────────────────────────────────────
const base = realpathSync(mkdtempSync(join(tmpdir(), "relocate-test-")));
const home = base; // 旧根在家目录下，~/ 写法也要换
const from = join(base, "code", "harness");
const to = join(base, "code", "navi");
const sibling = join(base, "code", "harness-old");
const zh = `${from}中文`;
const copy = `${from} copy`;
const outside = join(base, "outside-wt");
const outsideRel = join(base, "outside-rel");
const dotfile = join(base, "dotfiles", "codex.toml");
const projects = join(home, ".claude", "projects");
const zhClaude = join(projects, claudeSlug(zh));
const SKIP = ["--claude-skip", claudeSlug(zh)];
const runWith = (cwd, extraEnv, args) => spawnSync(process.execPath, [SCRIPT, "--from", from, "--to", to, "--home", home, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", cwd });
const runIn = (cwd, ...args) => runWith(cwd, {}, [...args, ...SKIP]);
const run = (...args) => runIn(base, ...args);
const raw = (...args) => runWith(base, {}, args);
const zshrcOld = `alias navi='cd ${from}'\n`;

function build() {
  mkdirSync(from, { recursive: true });
  git(from, "init", "-q", "-b", "main");
  write(join(from, "README.md"), "x\n");
  git(from, "add", ".");
  git(from, "commit", "-q", "-m", "init");
  git(from, "worktree", "add", "-q", ".worktrees/T1", "-b", "navi/T1");
  git(from, "worktree", "add", "-q", ".worktrees/T2", "-b", "navi/T2");
  git(from, "worktree", "add", "-q", outside, "-b", "outside");
  git(from, "worktree", "add", "-q", "--relative-paths", outsideRel, "-b", "outside-rel");
  // 嵌套仓库（无仓库项目的 scratch）和它自己的工作区
  const scratch = join(from, "data", "scratch", "S");
  mkdirSync(scratch, { recursive: true });
  git(scratch, "init", "-q", "-b", "main");
  git(scratch, "commit", "-q", "--allow-empty", "-m", "s");
  git(scratch, "worktree", "add", "-q", ".worktrees/S1", "-b", "s1");
  // 链接：工作区借主仓 node_modules（绝对）、相对链接、指向兄弟目录的绝对链接
  write(join(from, "node_modules", "pkg", "index.js"), "1\n");
  symlinkSync(join(from, "node_modules"), join(from, ".worktrees", "T1", "node_modules"));
  symlinkSync("../README.md", join(from, ".worktrees", "rel-link"));
  for (const d of [sibling, zh, copy]) mkdirSync(d, { recursive: true });
  symlinkSync(sibling, join(from, "to-sibling"));
  // 库：WAL 模式（干净关闭后没有 -wal，打开一查就会有 —— 不能拿它当「服务没停」）
  const db = new DatabaseSync(join(from, "data", "ash.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE projects (id TEXT PRIMARY KEY, repo_path TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, title TEXT, body TEXT, updated_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT, agent_type TEXT, cwd TEXT, agent_out_path TEXT, cli_config_dir TEXT, n INTEGER);
    CREATE TABLE monitors (id TEXT PRIMARY KEY, task_id TEXT, status TEXT, cwd TEXT);
    CREATE TABLE task_writes (task_id TEXT NOT NULL, path TEXT NOT NULL, weak INTEGER NOT NULL, PRIMARY KEY (task_id, path, weak));
    CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
    CREATE TABLE blobs (id INTEGER PRIMARY KEY, b BLOB);
  `);
  db.prepare("INSERT INTO projects VALUES ('p1', ?), ('p2', ?), ('p3', ?), ('p4', ?)").run(from, sibling, zh, copy);
  db.prepare("INSERT INTO tasks VALUES ('T1', 'paused', 't', ?, '2026-01-01')").run(`看图 ${from}/data/uploads/a.png 和 ~/code/harness/data，截图目录${from}/data/runs/x.png，别动 ${sibling}/x、${zh}/y、${copy}/z 与 ${from}.bak`);
  db.prepare("INSERT INTO sessions VALUES ('s1', 'T1', 'claude', ?, ?, ?, 7), ('s2', 'T1', 'codex', ?, NULL, ?, 1)").run(
    join(from, ".worktrees", "T1"), join(from, "data", "runs", "T1", "out.jsonl"), join(from, "data", "user-cli", "u1", "claude"),
    join(from, ".worktrees", "T2"), join(from, "data", "user-cli", "u1", "codex"));
  db.prepare("INSERT INTO monitors VALUES ('m1', 'T1', 'exited', ?)").run(from);
  db.prepare("INSERT INTO task_writes VALUES ('T1', ?, 0)").run(join(projects, claudeSlug(from), "memory", "a.md"));
  db.prepare("INSERT INTO kv VALUES ('k', ?)").run(`${from}/x`);
  db.prepare("INSERT INTO blobs VALUES (1, ?)").run(Buffer.from(`${from}/raw`));
  db.close();
  write(join(from, "data", "skill-calibrations.json"), `${JSON.stringify({ [`claude\u0000${from}/.worktrees/T1`]: { ok: 1 } }, null, 2)}\n`);
  // claude：主目录（带长期记忆）、工作区会话（自己也有记忆）、按会话号挂在工作区下的工作流目录、兄弟目录的会话、
  // 目标已存在要合并的，以及兄弟目录 harness中文 只留了记忆、没有会话记录的那个（认不出，不许动）
  write(join(projects, claudeSlug(from), "memory", "a.md"), `仓库在 ${from}，记忆在 ${projects}/${claudeSlug(from)}/memory\n`);
  write(join(projects, claudeSlug(`${from}/.worktrees/T1`), "s1.jsonl"), `${JSON.stringify({ cwd: `${from}/.worktrees/T1`, type: "user" })}\n`);
  write(join(projects, claudeSlug(`${from}/.worktrees/T1`), "memory", "notes", "b.md"), `工作区在 ${from}/.worktrees/T1\n`);
  write(join(projects, `${claudeSlug(`${from}/.worktrees/T1`)}-server`, "s1", "workflows", "x.js"), "1\n");
  write(join(projects, claudeSlug(sibling), "z.jsonl"), `${JSON.stringify({ cwd: sibling })}\n`);
  write(join(projects, claudeSlug(`${from}/.worktrees/T2`), "s2.jsonl"), `${JSON.stringify({ cwd: `${from}/.worktrees/T2` })}\n`);
  write(join(projects, claudeSlug(`${from}/.worktrees/T2`), "same.txt"), "same\n");
  write(join(projects, claudeSlug(`${to}/.worktrees/T2`), "same.txt"), "same\n");
  write(join(projects, claudeSlug(`${to}/.worktrees/T2`), "new.jsonl"), `${JSON.stringify({ cwd: `${to}/.worktrees/T2` })}\n`);
  write(join(zhClaude, "memory", "z.md"), `兄弟项目 ${zh}\n`);
  // 个人档：树里的 claude / codex 配置目录（会话目录、配置正文都要跟着换）
  const personal = join(from, "data", "user-cli", "u1");
  write(join(personal, "claude", "settings.json"), `${JSON.stringify({ hooks: { cmd: `${from}/scripts/hook.sh` } })}\n`);
  write(join(personal, "claude", "projects", claudeSlug(`${from}/.worktrees/T1`), "p.jsonl"), `${JSON.stringify({ cwd: `${from}/.worktrees/T1` })}\n`);
  write(join(personal, "codex", "config.toml"), `[mcp_servers.mine]\nargs = ["${from}/tools/mine.js"]\n`);
  // grok、opencode
  write(join(home, ".grok", "sessions", encodeURIComponent(`${from}/.worktrees/T1`), "g1", "chat.jsonl"), "{}\n");
  write(join(home, ".grok", "sessions", encodeURIComponent(sibling), "g2", "chat.jsonl"), "{}\n");
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
  const oc = new DatabaseSync(join(home, ".local", "share", "opencode", "opencode.db"));
  oc.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE workspace (id TEXT PRIMARY KEY, directory TEXT);");
  oc.prepare("INSERT INTO session VALUES ('o1', ?), ('o2', ?)").run(`${from}/.worktrees/T2`, sibling);
  oc.close();
  // 配置：codex 的那份是指向 dotfiles 里 0600 文件的链接
  write(join(home, ".claude.json"), `${JSON.stringify({ projects: { [from]: { a: 1 }, [sibling]: { b: 2 }, [zh]: { c: 3 } }, mcpServers: { navi: { command: "node", args: [`${from}/mcp/dist/index.js`] } } }, null, 2)}\n`);
  write(dotfile, `[projects."${from}"]\ntrust_level = "trusted"\n\n[mcp_servers.navi]\nargs = ["${from}/mcp/dist/index.js"]\n`);
  chmodSync(dotfile, 0o600);
  mkdirSync(join(home, ".codex"), { recursive: true });
  symlinkSync(dotfile, join(home, ".codex", "config.toml"));
  write(join(home, ".zshrc"), zshrcOld);
}

/** 夹具此刻的样子：库里所有行、配置和记忆的正文、目录清单、链接目标与权限、git 工作区登记。 */
function snapshot() {
  const out = {};
  const dump = (file) => {
    const db = new DatabaseSync(file, { readOnly: true });
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    const rows = Object.fromEntries(t.map((n) => [n, JSON.stringify(db.prepare(`SELECT * FROM "${n}"`).all().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v]))))]));
    db.close();
    return rows;
  };
  const root = existsSync(join(from, "data", "ash.db")) ? from : to;
  out.db = dump(join(root, "data", "ash.db"));
  out.oc = dump(join(home, ".local", "share", "opencode", "opencode.db"));
  for (const f of [".claude.json", ".zshrc"]) out[f] = readFileSync(join(home, f), "utf8");
  out.codex = [readlinkSync(join(home, ".codex", "config.toml")), readFileSync(dotfile, "utf8"), statSync(dotfile).mode & 0o777];
  out.calib = readFileSync(join(root, "data", "skill-calibrations.json"), "utf8");
  out.personal = [readFileSync(join(root, "data", "user-cli", "u1", "claude", "settings.json"), "utf8"), readFileSync(join(root, "data", "user-cli", "u1", "codex", "config.toml"), "utf8"), readdirSync(join(root, "data", "user-cli", "u1", "claude", "projects")).sort()];
  const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).sort() : []);
  out.claude = walk(projects);
  out.grok = walk(join(home, ".grok", "sessions"));
  const memory = (r, ...p) => join(projects, claudeSlug(r), ...p);
  out.memory = readFileSync(existsSync(memory(from)) ? memory(from, "memory", "a.md") : memory(to, "memory", "a.md"), "utf8");
  out.tree = [existsSync(from) && !lstatSync(from).isSymbolicLink(), existsSync(to)];
  out.links = [readlinkSync(join(from, ".worktrees", "T1", "node_modules")), readlinkSync(join(from, ".worktrees", "rel-link"))];
  out.gitdirs = [join(from, ".worktrees", "T1", ".git"), join(from, ".git", "worktrees", "T1", "gitdir"), join(outside, ".git"), join(outsideRel, ".git"), join(from, ".git", "worktrees", "outside-rel", "gitdir")].map((f) => readFileSync(f, "utf8"));
  out.data = readdirSync(join(root, "data")).sort();
  return out;
}

const setTask = (status) => { const db = new DatabaseSync(join(from, "data", "ash.db")); db.prepare("UPDATE tasks SET status=? WHERE id='T1'").run(status); db.close(); };

try {
  build();
  const before = snapshot();

  test("演练：列出要做的、认不出的 claude 目录列出来不动、退出码 1、什么都不改", () => {
    const r = raw();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /演练完毕/);
    assert.match(r.stdout, /claude 会话目录要改名：5 个/);
    assert.match(r.stdout, new RegExp(`1 个目录认不出是不是这棵树的[^\\n]*\\n\\s+${zhClaude.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(r.stdout, /grok 会话目录要改名：1 个/);
    assert.match(r.stdout, /opencode 会话的工作目录要改：1 条/);
    assert.match(r.stdout, /\.zshrc 里写着旧路径/);
    assert.match(r.stdout, /链接，改它指着的/);
    assert.deepEqual(snapshot(), before);
  });

  test("预检：有任务在跑就拒绝，什么都不动", () => {
    setTask("running");
    const r = run("--apply");
    setTask("paused");
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /有任务在跑/);
    assert.deepEqual(snapshot(), before);
  });

  test("预检：有进程的工作目录在树里就拒绝", () => {
    const child = spawn("/bin/sleep", ["30"], { cwd: join(from, ".worktrees", "T2"), stdio: "ignore" });
    try {
      const r = run("--apply");
      assert.equal(r.status, 2, r.stdout);
      assert.match(r.stdout, new RegExp(`${child.pid}\\s+sleep`));
    } finally {
      child.kill();
    }
    assert.deepEqual(snapshot(), before);
  });

  test("预检：配置里旧键改完会和已有的新键撞名就拒绝（不悄悄丢掉任何一份）", () => {
    const file = join(home, ".claude.json");
    const cj = JSON.parse(before[".claude.json"]);
    cj.projects[to] = { allowedTools: [] };
    writeFileSync(file, JSON.stringify(cj, null, 2));
    const r = run("--apply");
    writeFileSync(file, before[".claude.json"]);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /改完会和已有的 .* 重名/);
    assert.deepEqual(snapshot(), before);
  });

  test("预检：查不出谁在树里（lsof 跑不成）就拒绝 —— 不知道不等于没有", () => {
    const shim = join(base, "shim");
    write(join(shim, "lsof"), "#!/bin/sh\necho 'lsof: permission denied' >&2\nexit 1\n");
    chmodSync(join(shim, "lsof"), 0o755);
    const r = runWith(base, { PATH: `${shim}:${env.PATH}` }, ["--apply", ...SKIP]);
    rmSync(shim, { recursive: true });
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /清点不完整/);
    assert.match(r.stdout, /列进程的工作目录失败/);
    assert.deepEqual(snapshot(), before);
  });

  test("预检：另一个进程拿着维护锁（另一次迁移、离线回填）就拒绝；放锁之后不留痕迹", () => {
    const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const lock = join(from, "data", "ash.db.maintenance.lock");
    writeFileSync(lock, JSON.stringify({ pid: child.pid, processStartedAtMs: Date.now(), note: "测试里的另一次维护" }));
    try {
      const r = run("--apply");
      assert.equal(r.status, 2, r.stdout);
      assert.match(r.stdout, /拿不到维护锁.*测试里的另一次维护/);
    } finally {
      child.kill();
      unlinkSync(lock);
    }
    assert.deepEqual(snapshot(), before);
  });

  test("账本写不进去：动手前的意图落不了盘就不动手；动完之后落不了盘，退回照样找得到这一步", () => {
    const journalTmp = (p) => String(p).includes(".navi-relocate") && String(p).endsWith(".tmp");
    const inject = (when) => {
      const original = fs.openSync;
      fs.openSync = function patched(p, ...rest) {
        if (journalTmp(p) && when()) throw Object.assign(new Error("注入的磁盘写满"), { code: "ENOSPC" });
        return original.call(this, p, ...rest);
      };
      syncBuiltinESMExports();
      return () => { fs.openSync = original; syncBuiltinESMExports(); };
    };
    const claims = { ours: [], skip: [claudeSlug(zh)] };
    for (const [label, when, moved] of [["意图", () => true, false], ["完成", () => existsSync(to), true]]) {
      const plan = scan({ from, to, home, env, claims });
      const journal = Journal.create(home, { from, to });
      const restore = inject(when);
      try {
        assert.throws(() => apply(plan, { journal, link: true, log: () => {}, home, env, claims }), /注入的磁盘写满/, label);
      } finally {
        restore();
      }
      assert.equal(existsSync(to), moved, `${label}：目录${moved ? "已经" : "没有"}搬`);
      const r = run("--rollback");
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(snapshot(), before, label);
    }
  });

  test("中途失败：停在出错那一步、退出码 3；修好后重跑接着做完（在树里起跑，自己拉起的 lsof 不算占用）", () => {
    const ocFile = join(home, ".local", "share", "opencode", "opencode.db");
    chmodSync(ocFile, 0o444);
    const r = runIn(from, "--apply");
    chmodSync(ocFile, 0o644);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /做到一半失败/);
    assert.ok(lstatSync(from).isSymbolicLink() && existsSync(join(to, "data", "ash.db")), "目录已经搬了");
    const again = run("--apply");
    assert.equal(again.status, 1, again.stdout + again.stderr);
    assert.match(again.stdout, /搬完了，但还没完：.*\.zshrc 里的旧路径/);
    assert.ok(again.stdout.trimEnd().split("\n").at(-1).includes("搬完了"), "结论在最后一行");
  });

  test("搬完：git 认得每个工作区（含相对路径登记的），各处旧路径都换了，边界外的没动", () => {
    assert.equal(readlinkSync(from), "navi");
    for (const wt of [join(to, ".worktrees", "T1"), join(to, ".worktrees", "T2"), outside, outsideRel, join(to, "data", "scratch", "S", ".worktrees", "S1")]) {
      assert.equal(git(wt, "rev-parse", "--show-toplevel").trim(), wt);
      git(wt, "status", "--short");
    }
    assert.ok(!git(to, "worktree", "list", "--porcelain").includes(from));
    assert.equal(readFileSync(join(outsideRel, ".git"), "utf8"), "gitdir: ../code/navi/.git/worktrees/outside-rel\n", "相对登记按新位置重算，仍是相对的");
    assert.equal(readlinkSync(join(to, ".worktrees", "T1", "node_modules")), join(to, "node_modules"));
    assert.equal(readlinkSync(join(to, ".worktrees", "rel-link")), "../README.md");
    assert.equal(readlinkSync(join(to, "to-sibling")), sibling);
    assert.ok(!readdirSync(join(to, "data")).some((n) => n.includes("maintenance") || n.includes("claim")), "维护锁放掉了");
    const db = new DatabaseSync(join(to, "data", "ash.db"), { readOnly: true });
    assert.deepEqual(db.prepare("SELECT repo_path FROM projects ORDER BY id").all().map((r) => r.repo_path), [to, sibling, zh, copy]);
    assert.equal(db.prepare("SELECT body FROM tasks").get().body, `看图 ${to}/data/uploads/a.png 和 ~/code/navi/data，截图目录${to}/data/runs/x.png，别动 ${sibling}/x、${zh}/y、${copy}/z 与 ${from}.bak`);
    assert.equal(db.prepare("SELECT updated_at FROM tasks").get().updated_at, "2026-01-01");
    const s = db.prepare("SELECT * FROM sessions WHERE id='s1'").get();
    assert.deepEqual([s.cwd, s.agent_out_path, s.cli_config_dir, s.n], [join(to, ".worktrees", "T1"), join(to, "data", "runs", "T1", "out.jsonl"), join(to, "data", "user-cli", "u1", "claude"), 7]);
    assert.equal(db.prepare("SELECT path FROM task_writes").get().path, join(projects, claudeSlug(to), "memory", "a.md"));
    assert.equal(db.prepare("SELECT v FROM kv").get().v, `${to}/x`);
    assert.equal(Buffer.from(db.prepare("SELECT b FROM blobs").get().b).toString(), `${from}/raw`, "BLOB 不碰");
    db.close();
    { const c = readFileSync(join(to, "data", "skill-calibrations.json"), "utf8"); assert.ok(c.includes(`claude\\u0000${to}/.worktrees/T1`), c); }
    assert.ok(existsSync(join(projects, claudeSlug(to), "memory", "a.md")) && !existsSync(join(projects, claudeSlug(from))));
    assert.equal(readFileSync(join(projects, claudeSlug(to), "memory", "a.md"), "utf8"), `仓库在 ${to}，记忆在 ${projects}/${claudeSlug(to)}/memory\n`);
    assert.equal(readFileSync(join(projects, claudeSlug(`${to}/.worktrees/T1`), "memory", "notes", "b.md"), "utf8"), `工作区在 ${to}/.worktrees/T1\n`, "工作区自己的记忆也换");
    assert.ok(existsSync(join(projects, claudeSlug(`${to}/.worktrees/T1`), "s1.jsonl")));
    assert.ok(existsSync(join(projects, `${claudeSlug(`${to}/.worktrees/T1`)}-server`, "s1", "workflows", "x.js")), "按会话号认领的工作流目录");
    assert.deepEqual(readdirSync(join(projects, claudeSlug(`${to}/.worktrees/T2`))).sort(), ["new.jsonl", "s2.jsonl", "same.txt"]);
    assert.ok(existsSync(join(projects, claudeSlug(sibling), "z.jsonl")), "兄弟目录的会话不动");
    assert.equal(readFileSync(join(zhClaude, "memory", "z.md"), "utf8"), `兄弟项目 ${zh}\n`, "认不出归属的目录不动");
    const personal = join(to, "data", "user-cli", "u1");
    assert.ok(readFileSync(join(personal, "claude", "settings.json"), "utf8").includes(`${to}/scripts/hook.sh`));
    assert.equal(readFileSync(join(personal, "codex", "config.toml"), "utf8"), `[mcp_servers.mine]\nargs = ["${to}/tools/mine.js"]\n`);
    assert.deepEqual(readdirSync(join(personal, "claude", "projects")), [claudeSlug(`${to}/.worktrees/T1`)]);
    assert.ok(existsSync(join(home, ".grok", "sessions", encodeURIComponent(`${to}/.worktrees/T1`), "g1")));
    assert.ok(existsSync(join(home, ".grok", "sessions", encodeURIComponent(sibling))));
    const oc = new DatabaseSync(join(home, ".local", "share", "opencode", "opencode.db"), { readOnly: true });
    assert.deepEqual(oc.prepare("SELECT directory FROM session ORDER BY id").all().map((r) => r.directory), [`${to}/.worktrees/T2`, sibling]);
    oc.close();
    const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    assert.deepEqual(Object.keys(cj.projects).sort(), [sibling, to, zh].sort());
    assert.deepEqual(cj.mcpServers.navi.args, [`${to}/mcp/dist/index.js`]);
    const codex = join(home, ".codex", "config.toml");
    assert.ok(lstatSync(codex).isSymbolicLink() && readlinkSync(codex) === dotfile, "链接还是链接");
    assert.equal(readFileSync(dotfile, "utf8"), `[projects."${to}"]\ntrust_level = "trusted"\n\n[mcp_servers.navi]\nargs = ["${to}/mcp/dist/index.js"]\n`);
    assert.equal(statSync(dotfile).mode & 0o777, 0o600, "权限照旧");
    assert.equal(readFileSync(join(home, ".zshrc"), "utf8"), zshrcOld, "shell 配置只报不改");
  });

  test("核对：还有只报不改的旧路径就不算完；改掉之后干净，退出码 0；再跑一遍什么都不做", () => {
    const v = run("--verify");
    assert.equal(v.status, 1, v.stdout + v.stderr);
    assert.match(v.stdout, /还没完：.*\.zshrc/);
    writeFileSync(join(home, ".zshrc"), `alias navi='cd ${to}'\n`);
    const clean = run("--verify");
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    const snap = snapshot();
    const again = run("--apply");
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.deepEqual(snapshot(), snap);
    writeFileSync(join(home, ".zshrc"), zshrcOld);
  });

  test("退回：所有账本从新到旧全退，逐字节回到搬之前（链接、权限都是原样）", () => {
    const r = run("--rollback");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = snapshot();
    for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], k);
    for (const wt of [join(from, ".worktrees", "T1"), outside, outsideRel]) assert.equal(git(wt, "rev-parse", "--show-toplevel").trim(), wt);
    assert.equal(run("--rollback").stdout.trim(), "没有要退回的账本（~/.navi-relocate/*/journal.json）");
  });

  test("不留链接：--no-link；树外工作区（含相对登记的）不靠链接也认得；之后 --unlink 无事可做", () => {
    const r = run("--apply", "--no-link");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(!existsSync(from));
    for (const wt of [outside, outsideRel]) assert.equal(git(wt, "rev-parse", "--show-toplevel").trim(), wt);
    assert.equal(readFileSync(join(to, "data", "user-cli", "u1", "codex", "config.toml"), "utf8"), `[mcp_servers.mine]\nargs = ["${to}/tools/mine.js"]\n`, "树里的个人档第一遍就改到");
    assert.equal(run("--unlink").status, 0);
    assert.equal(run("--rollback").status, 0);
    assert.deepEqual(snapshot(), before);
  });

  test("拿掉链接：认不出的会话目录、只报不改的旧路径都会拦下；处理完才删", () => {
    run("--apply");
    assert.ok(lstatSync(from).isSymbolicLink());
    const unsure = raw("--unlink");
    assert.equal(unsure.status, 1, unsure.stdout);
    assert.match(unsure.stdout, /链接先留着：.*认不出归属的 claude 会话目录/);
    const rc = run("--unlink");
    assert.equal(rc.status, 1, rc.stdout);
    assert.match(rc.stdout, /链接先留着：.*\.zshrc/);
    writeFileSync(join(home, ".zshrc"), `alias navi='cd ${to}'\n`);
    const r = run("--unlink");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(from) && existsSync(to));
  });

  test("目标已存在：演练和真做都拒绝", () => {
    mkdirSync(from);
    const r = run("--apply");
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /已经存在/);
    rmSync(from, { recursive: true });
  });
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log(`\n${passed} passed`);
