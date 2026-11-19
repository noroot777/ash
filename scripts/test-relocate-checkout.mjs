#!/usr/bin/env node
// scripts/relocate-checkout.mjs 的回归：在临时目录里造一棵带工作区、嵌套仓库、树外工作区、
// 绝对链接、库、执行器会话目录、各家配置的树，跑演练 / 预检拦截 / 真做 / 核对 / 重跑 /
// 中途失败后接着做 / 退回（逐字节回到原样） / 不留链接 / 拿掉链接。
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { claudeSlug, rewriteRules, rewriteText } from "./relocate-checkout-paths.mjs";

const SCRIPT = fileURLToPath(new URL("./relocate-checkout.mjs", import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|CODEX_HOME$|XDG_|CLAUDE_CONFIG_DIR$)/.test(k)));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (file, text) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

// ── 路径规则 ─────────────────────────────────────────────────────────────
test("边界：兄弟目录、同名前缀、别的路径里的一段都不换", () => {
  const rules = rewriteRules({ from: "/u/code/harness", to: "/u/code/navi", home: "/u" });
  const r = (s) => rewriteText(s, rules).text;
  assert.equal(r("cd /u/code/harness && ls /u/code/harness/x"), "cd /u/code/navi && ls /u/code/navi/x");
  assert.equal(r("/u/code/harness-old /u/code/harness2 /u/code/harness.bak/a"), "/u/code/harness-old /u/code/harness2 /u/code/harness.bak/a");
  assert.equal(r("/v/u/code/harness/a"), "/v/u/code/harness/a");
  assert.equal(r("目录是 /u/code/harness。还有 /u/code/harness."), "目录是 /u/code/navi。还有 /u/code/navi.");
  assert.equal(r('"a":"x\\n/u/code/harness/data"'), '"a":"x\\n/u/code/navi/data"');
  assert.equal(r("file:///u/code/harness/a.png"), "file:///u/code/navi/a.png");
  assert.equal(r("~/code/harness/data ~/code/harnessX"), "~/code/navi/data ~/code/harnessX");
  assert.equal(r("/u/.claude/projects/-u-code-harness--worktrees-A/x -u-code-harness"), "/u/.claude/projects/-u-code-navi--worktrees-A/x -u-code-harness");
});

// ── 夹具 ───────────────────────────────────────────────────────────────────
const base = realpathSync(mkdtempSync(join(tmpdir(), "relocate-test-")));
const home = base; // 旧根在家目录下，~/ 写法也要换
const from = join(base, "code", "harness");
const to = join(base, "code", "navi");
const sibling = join(base, "code", "harness-old");
const outside = join(base, "outside-wt");
const run = (...args) => spawnSync(process.execPath, [SCRIPT, "--from", from, "--to", to, "--home", home, ...args], { env, encoding: "utf8", cwd: base });

function build() {
  mkdirSync(from, { recursive: true });
  git(from, "init", "-q", "-b", "main");
  write(join(from, "README.md"), "x\n");
  git(from, "add", ".");
  git(from, "commit", "-q", "-m", "init");
  git(from, "worktree", "add", "-q", ".worktrees/T1", "-b", "navi/T1");
  git(from, "worktree", "add", "-q", ".worktrees/T2", "-b", "navi/T2");
  git(from, "worktree", "add", "-q", outside, "-b", "outside");
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
  mkdirSync(sibling, { recursive: true });
  symlinkSync(sibling, join(from, "to-sibling"));
  // 库
  const db = new DatabaseSync(join(from, "data", "ash.db"));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, repo_path TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, title TEXT, body TEXT, updated_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT, agent_type TEXT, cwd TEXT, agent_out_path TEXT, cli_config_dir TEXT, n INTEGER);
    CREATE TABLE monitors (id TEXT PRIMARY KEY, task_id TEXT, status TEXT, cwd TEXT);
    CREATE TABLE task_writes (task_id TEXT NOT NULL, path TEXT NOT NULL, weak INTEGER NOT NULL, PRIMARY KEY (task_id, path, weak));
    CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
    CREATE TABLE blobs (id INTEGER PRIMARY KEY, b BLOB);
  `);
  db.prepare("INSERT INTO projects VALUES ('p1', ?), ('p2', ?)").run(from, sibling);
  db.prepare("INSERT INTO tasks VALUES ('T1', 'paused', 't', ?, '2026-01-01')").run(`看图 ${from}/data/uploads/a.png 和 ~/code/harness/data，别动 ${sibling}/x 与 ${from}.bak`);
  db.prepare("INSERT INTO sessions VALUES ('s1', 'T1', 'claude', ?, ?, NULL, 7)").run(join(from, ".worktrees", "T1"), join(from, "data", "runs", "T1", "out.jsonl"));
  db.prepare("INSERT INTO monitors VALUES ('m1', 'T1', 'exited', ?)").run(from);
  db.prepare("INSERT INTO task_writes VALUES ('T1', ?, 0)").run(join(home, ".claude", "projects", claudeSlug(from), "memory", "a.md"));
  db.prepare("INSERT INTO kv VALUES ('k', ?)").run(`${from}/x`);
  db.prepare("INSERT INTO blobs VALUES (1, ?)").run(Buffer.from(`${from}/raw`));
  db.close();
  write(join(from, "data", "skill-calibrations.json"), `${JSON.stringify({ [`claude\u0000${from}/.worktrees/T1`]: { ok: 1 } }, null, 2)}\n`);
  // claude：主目录（带长期记忆）、工作区会话、没有会话记录的子目录、兄弟目录的会话、目标已存在要合并的
  const projects = join(home, ".claude", "projects");
  write(join(projects, claudeSlug(from), "memory", "a.md"), `仓库在 ${from}，记忆在 ${projects}/${claudeSlug(from)}/memory\n`);
  write(join(projects, claudeSlug(`${from}/.worktrees/T1`), "s1.jsonl"), `${JSON.stringify({ cwd: `${from}/.worktrees/T1`, type: "user" })}\n`);
  write(join(projects, `${claudeSlug(`${from}/.worktrees/T9`)}-server`, "wf", "x.js"), "1\n");
  write(join(projects, claudeSlug(sibling), "z.jsonl"), `${JSON.stringify({ cwd: sibling })}\n`);
  write(join(projects, claudeSlug(`${from}/.worktrees/T2`), "s2.jsonl"), `${JSON.stringify({ cwd: `${from}/.worktrees/T2` })}\n`);
  write(join(projects, claudeSlug(`${from}/.worktrees/T2`), "same.txt"), "same\n");
  write(join(projects, claudeSlug(`${to}/.worktrees/T2`), "same.txt"), "same\n");
  write(join(projects, claudeSlug(`${to}/.worktrees/T2`), "new.jsonl"), `${JSON.stringify({ cwd: `${to}/.worktrees/T2` })}\n`);
  // grok、opencode
  write(join(home, ".grok", "sessions", encodeURIComponent(`${from}/.worktrees/T1`), "g1", "chat.jsonl"), "{}\n");
  write(join(home, ".grok", "sessions", encodeURIComponent(sibling), "g2", "chat.jsonl"), "{}\n");
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
  const oc = new DatabaseSync(join(home, ".local", "share", "opencode", "opencode.db"));
  oc.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE workspace (id TEXT PRIMARY KEY, directory TEXT);");
  oc.prepare("INSERT INTO session VALUES ('o1', ?), ('o2', ?)").run(`${from}/.worktrees/T2`, sibling);
  oc.close();
  // 配置
  write(join(home, ".claude.json"), `${JSON.stringify({ projects: { [from]: { a: 1 }, [sibling]: { b: 2 } }, mcpServers: { navi: { command: "node", args: [`${from}/mcp/dist/index.js`] } } }, null, 2)}\n`);
  write(join(home, ".codex", "config.toml"), `[projects."${from}"]\ntrust_level = "trusted"\n\n[mcp_servers.navi]\nargs = ["${from}/mcp/dist/index.js"]\n`);
  write(join(home, ".zshrc"), `alias navi='cd ${from}'\n`);
}

/** 夹具此刻的样子：库里所有行、配置和记忆的正文、目录清单、链接目标、git 工作区登记。 */
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
  for (const f of [".claude.json", ".codex/config.toml", ".zshrc"]) out[f] = readFileSync(join(home, f), "utf8");
  out.calib = readFileSync(join(root, "data", "skill-calibrations.json"), "utf8");
  const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).sort() : []);
  out.claude = walk(join(home, ".claude", "projects"));
  out.grok = walk(join(home, ".grok", "sessions"));
  const memory = (root) => join(home, ".claude", "projects", claudeSlug(root), "memory", "a.md");
  out.memory = readFileSync(existsSync(memory(from)) ? memory(from) : memory(to), "utf8");
  out.tree = [existsSync(from) && !lstatSync(from).isSymbolicLink(), existsSync(to)];
  out.links = [readlinkSync(join(from, ".worktrees", "T1", "node_modules")), readlinkSync(join(from, ".worktrees", "rel-link"))];
  out.gitdirs = [readFileSync(join(from, ".worktrees", "T1", ".git"), "utf8"), readFileSync(join(from, ".git", "worktrees", "T1", "gitdir"), "utf8"), readFileSync(join(outside, ".git"), "utf8")];
  return out;
}

try {
  build();
  const before = snapshot();

  test("演练：列出要做的、退出码 1、什么都不改", () => {
    const r = run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /演练完毕/);
    assert.match(r.stdout, /claude 会话目录要改名：4 个/);
    assert.match(r.stdout, /grok 会话目录要改名：1 个/);
    assert.match(r.stdout, /opencode 会话的工作目录要改：1 条/);
    assert.match(r.stdout, /\.zshrc 里写着旧路径/);
    assert.deepEqual(snapshot(), before);
  });

  test("预检：有任务在跑就拒绝，什么都不动", () => {
    const db = new DatabaseSync(join(from, "data", "ash.db"));
    db.exec("UPDATE tasks SET status='running' WHERE id='T1'");
    db.close();
    const r = run("--apply");
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /有任务在跑/);
    const db2 = new DatabaseSync(join(from, "data", "ash.db"));
    db2.exec("UPDATE tasks SET status='paused' WHERE id='T1'");
    db2.close();
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

  test("中途失败：停在出错那一步、退出码 3；修好后重跑接着做完", () => {
    const ocFile = join(home, ".local", "share", "opencode", "opencode.db");
    chmodSync(ocFile, 0o444);
    const r = run("--apply");
    chmodSync(ocFile, 0o644);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /做到一半失败/);
    assert.ok(lstatSync(from).isSymbolicLink() && existsSync(join(to, "data", "ash.db")), "目录已经搬了");
    const again = run("--apply");
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /搬完了/);
  });

  test("搬完：git 认得每个工作区，各处旧路径都换了，边界外的没动", () => {
    assert.equal(readlinkSync(from), "navi");
    for (const wt of [join(to, ".worktrees", "T1"), join(to, ".worktrees", "T2"), outside, join(to, "data", "scratch", "S", ".worktrees", "S1")]) {
      assert.equal(git(wt, "rev-parse", "--show-toplevel").trim(), wt);
      git(wt, "status", "--short");
    }
    assert.ok(!git(to, "worktree", "list", "--porcelain").includes(from));
    assert.equal(readlinkSync(join(to, ".worktrees", "T1", "node_modules")), join(to, "node_modules"));
    assert.equal(readlinkSync(join(to, ".worktrees", "rel-link")), "../README.md");
    assert.equal(readlinkSync(join(to, "to-sibling")), sibling);
    const db = new DatabaseSync(join(to, "data", "ash.db"), { readOnly: true });
    assert.equal(db.prepare("SELECT repo_path FROM projects WHERE id='p1'").get().repo_path, to);
    assert.equal(db.prepare("SELECT repo_path FROM projects WHERE id='p2'").get().repo_path, sibling);
    assert.equal(db.prepare("SELECT body FROM tasks").get().body, `看图 ${to}/data/uploads/a.png 和 ~/code/navi/data，别动 ${sibling}/x 与 ${from}.bak`);
    assert.equal(db.prepare("SELECT updated_at FROM tasks").get().updated_at, "2026-01-01");
    const s = db.prepare("SELECT * FROM sessions").get();
    assert.deepEqual([s.cwd, s.agent_out_path, s.n], [join(to, ".worktrees", "T1"), join(to, "data", "runs", "T1", "out.jsonl"), 7]);
    assert.equal(db.prepare("SELECT path FROM task_writes").get().path, join(home, ".claude", "projects", claudeSlug(to), "memory", "a.md"));
    assert.equal(db.prepare("SELECT v FROM kv").get().v, `${to}/x`);
    assert.equal(Buffer.from(db.prepare("SELECT b FROM blobs").get().b).toString(), `${from}/raw`, "BLOB 不碰");
    db.close();
    assert.ok(readFileSync(join(to, "data", "skill-calibrations.json"), "utf8").includes(`claude\\u0000${to}/.worktrees/T1`));
    const projects = join(home, ".claude", "projects");
    assert.ok(existsSync(join(projects, claudeSlug(to), "memory", "a.md")) && !existsSync(join(projects, claudeSlug(from))));
    assert.equal(readFileSync(join(projects, claudeSlug(to), "memory", "a.md"), "utf8"), `仓库在 ${to}，记忆在 ${projects}/${claudeSlug(to)}/memory\n`);
    assert.ok(existsSync(join(projects, claudeSlug(`${to}/.worktrees/T1`), "s1.jsonl")));
    assert.ok(existsSync(join(projects, `${claudeSlug(`${to}/.worktrees/T9`)}-server`, "wf", "x.js")));
    assert.deepEqual(readdirSync(join(projects, claudeSlug(`${to}/.worktrees/T2`))).sort(), ["new.jsonl", "s2.jsonl", "same.txt"]);
    assert.ok(existsSync(join(projects, claudeSlug(sibling), "z.jsonl")), "兄弟目录的会话不动");
    assert.ok(existsSync(join(home, ".grok", "sessions", encodeURIComponent(`${to}/.worktrees/T1`), "g1")));
    assert.ok(existsSync(join(home, ".grok", "sessions", encodeURIComponent(sibling))));
    const oc = new DatabaseSync(join(home, ".local", "share", "opencode", "opencode.db"), { readOnly: true });
    assert.deepEqual(oc.prepare("SELECT directory FROM session ORDER BY id").all().map((r) => r.directory), [`${to}/.worktrees/T2`, sibling]);
    oc.close();
    const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    assert.deepEqual(Object.keys(cj.projects).sort(), [sibling, to].sort());
    assert.deepEqual(cj.mcpServers.navi.args, [`${to}/mcp/dist/index.js`]);
    assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), `[projects."${to}"]\ntrust_level = "trusted"\n\n[mcp_servers.navi]\nargs = ["${to}/mcp/dist/index.js"]\n`);
    assert.equal(readFileSync(join(home, ".zshrc"), "utf8"), before[".zshrc"], "shell 配置只报不改");
  });

  test("核对：干净，退出码 0；再跑一遍什么都不做", () => {
    const v = run("--verify");
    assert.equal(v.status, 0, v.stdout + v.stderr);
    const snap = snapshot();
    const again = run("--apply");
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.deepEqual(snapshot(), snap);
  });

  test("退回：两份账本从新到旧全退，逐字节回到搬之前", () => {
    const r = run("--rollback");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = snapshot();
    for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], k);
    for (const wt of [join(from, ".worktrees", "T1"), outside]) assert.equal(git(wt, "rev-parse", "--show-toplevel").trim(), wt);
    assert.equal(run("--rollback").stdout.trim(), "没有要退回的账本（~/.navi-relocate/*/journal.json）");
  });

  test("不留链接：--no-link；之后 --unlink 无事可做", () => {
    const r = run("--apply", "--no-link");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(from));
    assert.equal(run("--unlink").status, 0);
    assert.equal(run("--rollback").status, 0);
    assert.deepEqual(snapshot().db, before.db);
  });

  test("拿掉链接：核对干净时 --unlink 删掉它", () => {
    assert.equal(run("--apply").status, 0);
    assert.ok(lstatSync(from).isSymbolicLink());
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
