// test-upgrade.mjs 的现场:一个裸远端、一份「开发者」检出(往远端推新版本)、一份「用户」检出(在它上面跑升级)。
// 代码是真脚本(scripts/ 原样拷一份,升级命令本身就在里面)加一个假 server 和假 npm:
//  - 假 server 真监听、真回 /api/health 与 /api/restart-impact,像真服务那样写单例锁(v1 只写改名之前那把
//    `.ash.lock`、也只认 ash.db;之后的版本两把都写、优先开 navi.db),对着改名路标和改名账本拒绝启动。
//  - 假 npm 只记被怎么调;`run build` 真跑仓库里的 build.mjs(仓库根有 BUILD_FAIL 就失败)。
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS } from "./platform.mjs";

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));

export function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=upgrade-test", "-c", "user.email=upgrade-test@localhost", "-c", "core.hooksPath=", "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/** 假 npm:记账,`install` 建个 node_modules,`run build` 真跑 build.mjs,`-v` 报一个够新的版本。 */
export function fakeNpm(bin, logFile) {
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "npm-shim.mjs");
  writeFileSync(shim, `import { appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "-v") { console.log("11.99.0"); process.exit(0); }
if (args[0] === "config") process.exit(0);
appendFileSync(${JSON.stringify(logFile)}, args.join(" ") + "\\n");
if (args[0] === "install") { mkdirSync("node_modules", { recursive: true }); process.exit(0); }
if (args[0] === "run" && args[1] === "build") process.exit(spawnSync(process.execPath, ["build.mjs"], { stdio: "inherit" }).status ?? 1);
process.exit(0);
`);
  if (IS_WINDOWS) {
    writeFileSync(join(bin, "npm.cmd"), `@echo off\r\nnode "${shim}" %*\r\n`);
  } else {
    writeFileSync(join(bin, "npm"), `#!/bin/sh\nexec node "${shim}" "$@"\n`);
    chmodSync(join(bin, "npm"), 0o755);
  }
}

const BUILD = `import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
if (existsSync("BUILD_FAIL")) { console.error("build: 这一版故意构建失败"); process.exit(1); }
mkdirSync("server/dist", { recursive: true });
copyFileSync("server/src/server.mjs", "server/dist/index.js");
mkdirSync("mcp/dist", { recursive: true });
writeFileSync("mcp/dist/index.js", "");
mkdirSync("web/dist", { recursive: true });
writeFileSync("web/dist/index.html", "");
`;

/** 假 server。version 是它报出来的版本号;legacy = 改名之前的那一代。 */
function serverSource(version, legacy) {
  return `import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const VERSION = ${JSON.stringify(version)};
const repo = fileURLToPath(new URL("../..", import.meta.url));
if (existsSync(join(repo, "START_FAIL"))) { console.error("start: 这一版故意起不来"); process.exit(1); }
const port = Number(process.env.PORT || 4317);
const dataDir = resolve(process.env.NAVI_DATA_DIR || process.env.ASH_DATA_DIR || join(repo, "data"));
const navi = join(dataDir, "navi.db");
const ash = join(dataDir, "ash.db");
const marker = (f) => { try { return readFileSync(f).subarray(0, 13).toString("latin1") === "NAVI-DB-MOVED"; } catch { return false; } };
if (existsSync(join(dataDir, "navi.db.renaming"))) { console.error("改名账本在,不起"); process.exit(1); }
const db = ${legacy} ? ash : existsSync(navi) ? navi : existsSync(ash) && !marker(ash) ? ash : navi;
if (marker(db)) { console.error("file is not a database: " + db); process.exit(1); }
const locks = (${legacy} ? [".ash.lock"] : [".navi.lock", ".ash.lock"]).map((s) => db + s);
for (const l of locks) writeFileSync(l, JSON.stringify({ pid: process.pid, port, token: "t" }));
const impact = join(dataDir, "impact.json");
createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url.startsWith("/api/restart-impact")) {
    return res.end(existsSync(impact) ? readFileSync(impact, "utf8") : '{"survives":[],"resumes":[],"interrupted":[],"mcpDisrupted":[]}');
  }
  res.end(JSON.stringify({ ok: true, pid: process.pid, version: VERSION, db, instance: { codeDir: repo, dataDir } }));
}).listen(port, "127.0.0.1", () => console.log("listening " + port + " " + VERSION));
process.on("SIGTERM", () => { for (const l of locks) rmSync(l, { force: true }); process.exit(0); });
`;
}

/**
 * 在开发者检出里写出某一版并推上去。legacy = 改名之前那一代(服务只认 ash.db,选库代码里没有 navi.db 这个名字)。
 * flags 里列的文件(BUILD_FAIL / START_FAIL)放进仓库根,没列的删掉;upgradeMarker 给这一版的升级脚本加一行自报家门;
 * node / workspaces 改这一版 package.json 里要的 Node 版本、声明的 workspace。
 */
export function publish(dev, version, { legacy = false, flags = [], upgradeMarker = false, node = ">=22.16.0", workspaces = ["shared"] } = {}) {
  const scripts = join(dev, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of readdirSync(SCRIPTS)) {
    if (/^test-/.test(name) || !/\.mjs$/.test(name)) continue;
    cpSync(join(SCRIPTS, name), join(scripts, name));
  }
  if (upgradeMarker) {
    const file = join(scripts, "upgrade.mjs");
    const src = readFileSync(file, "utf8");
    writeFileSync(file, src.replace("\nimport ", `\nif (process.argv.includes("--continue")) process.stdout.write("[${version} 的升级逻辑]\\n");\nimport `));
  }
  writeFileSync(join(dev, "package.json"), `${JSON.stringify({
    name: legacy ? "ash" : "navi", private: true, type: "module", workspaces,
    engines: { node }, devEngines: { packageManager: { name: "npm", version: ">=11.9.0" } },
    scripts: { build: "node build.mjs", upgrade: "node scripts/upgrade.mjs" },
  }, null, 2)}\n`);
  mkdirSync(join(dev, "shared"), { recursive: true });
  writeFileSync(join(dev, "shared", "package.json"), `${JSON.stringify({ name: legacy ? "@ash/shared" : "@navi/shared", version: "0.0.0" })}\n`);
  writeFileSync(join(dev, ".gitignore"), "node_modules\ndist/\ndata/\n*.log\n");
  writeFileSync(join(dev, "build.mjs"), BUILD);
  mkdirSync(join(dev, "server", "src", "db"), { recursive: true });
  writeFileSync(join(dev, "server", "src", "server.mjs"), serverSource(version, legacy));
  writeFileSync(join(dev, "server", "src", "db", "path.ts"), `export const DB_FILE_NAME = ${JSON.stringify(legacy ? "ash.db" : "navi.db")};\n`);
  for (const flag of ["BUILD_FAIL", "START_FAIL"]) {
    if (flags.includes(flag)) writeFileSync(join(dev, flag), "1\n");
    else rmSync(join(dev, flag), { force: true });
  }
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", version);
  git(dev, "push", "-q", "origin", "HEAD:main");
  return git(dev, "rev-parse", "HEAD");
}

/** 一份带几个项目、任务、会话的库(建在改名之前的名字上),外加一份跟着库名走的身份文件。 */
export function seedDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(join(dataDir, "ash.db"));
  db.exec(`pragma journal_mode = wal;
    create table projects (id text primary key, name text);
    create table tasks (id text primary key, project_id text, title text);
    create table sessions (id text primary key, task_id text);
    insert into projects values ('p1', 'alpha'), ('p2', 'beta');
    insert into tasks values ('t1', 'p1', 'one'), ('t2', 'p1', 'two'), ('t3', 'p2', 'three');
    insert into sessions values ('s1', 't1'), ('s2', 't1'), ('s3', 't2'), ('s4', 't3');`);
  db.close();
  writeFileSync(join(dataDir, "ash.db.identity.json"), `${JSON.stringify({ id: "machine-1" })}\n`);
}
