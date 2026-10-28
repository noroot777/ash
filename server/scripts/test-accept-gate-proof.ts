import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { available, optionalRead, readResult, requiredRead } from "../src/accept-gate-fs.js";
import { confineOwnPackages } from "../src/accept-gate-confine.js";
import { linksIntoSource, provideDependency, recordedLinks, workspacePackages } from "../src/accept-gate-deps.js";
import { projectSources } from "../src/accept-gate-project.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ash-gate-proof-")));
const promises = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
type Operation = "stat" | "lstat" | "realpath" | "readdir" | "readFile";
const save = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const failure = (operation: Operation, path: string, code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${operation} ${code} ${path}`), { code, errno: -1, syscall: operation, path });
async function injecting(operation: Operation, path: string, code: string, action: () => Promise<void>): Promise<void> {
  const original = promises[operation];
  let calls = 0;
  Object.defineProperty(promises, operation, { value: async (...args: unknown[]) => {
    if (String(args[0]) === path) {
      calls++;
      throw failure(operation, path, code);
    }
    return Reflect.apply(original, promises, args);
  } });
  syncBuiltinESMExports();
  try {
    await action();
    assert.ok(calls > 0, `${operation} ${path} was not exercised`);
  } finally {
    Object.defineProperty(promises, operation, { value: original });
    syncBuiltinESMExports();
  }
}
const refusedRead = (code: string, path: string) => (error: unknown) => {
  const message = String(error);
  assert.ok(message.includes(code), message);
  assert.doesNotMatch(message, /修复该元数据|重新安装依赖|没有这个位置|替代位置/);
  if (code === "EMFILE" || code === "ENFILE") assert.match(message, /文件句柄耗尽.*释放.*提高系统限额/);
  else {
    assert.ok(message.includes(path), message);
    assert.match(message, /不能据此认定路径不存在.*恢复可读取后重试/);
  }
  assert.equal(((error as Error).cause as NodeJS.ErrnoException).code, code);
  return true;
};

try {
  const source = join(root, "project");
  const own = join(source, "packages", "lib");
  save(join(source, "package.json"), JSON.stringify({ name: "proof-host", private: true, workspaces: ["packages/*"] }));
  save(join(source, ".gitignore"), "node_modules/\ndata/\n.worktrees/\n");
  save(join(own, "package.json"), JSON.stringify({ name: "@demo/lib", version: "1.0.0", main: "index.js" }));
  save(join(own, "index.js"), 'module.exports = "LIVE_SOURCE";\n');
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Gate Proof Test");
  git(source, "config", "user.email", "gate@example.test");
  const npmArgs = ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"];
  execFileSync(process.platform === "win32" ? "cmd.exe" : "npm",
    process.platform === "win32" ? ["/d", "/s", "/c", `npm ${npmArgs.join(" ")}`] : npmArgs,
    { cwd: source, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] });
  git(source, "add", "-A");
  git(source, "commit", "-qm", "fixture");
  const tree = join(source, "node_modules");
  const entry = join(tree, "@demo", "lib");
  const context = await projectSources(source);
  const workspace = await workspacePackages(source);
  const lock = join(tree, ".package-lock.json");
  const sourceBefore = readFileSync(join(own, "index.js"), "utf8");
  const lockBefore = readFileSync(lock, "utf8");
  const snapshot = join(source, "data", "runs", "proof.source");
  save(join(snapshot, "package.json"), readFileSync(join(source, "package.json"), "utf8"));
  save(join(snapshot, "packages/lib/package.json"), readFileSync(join(own, "package.json"), "utf8"));
  save(join(snapshot, "packages/lib/index.js"), 'module.exports = "CERTIFIED";\n');
  const codes = ["EACCES", "EIO", "EMFILE", "ENFILE"];
  const reads: { operation: Operation; path: string; action: () => Promise<unknown> }[] = [
    { operation: "realpath", path: source, action: () => projectSources(source) },
    { operation: "realpath", path: snapshot, action: () => confineOwnPackages(snapshot, source) },
    { operation: "realpath", path: source, action: () => recordedLinks(tree, "node_modules", context) },
    { operation: "readdir", path: tree, action: () => linksIntoSource(tree, source) },
    { operation: "realpath", path: entry, action: () => linksIntoSource(tree, source) },
    { operation: "realpath", path: own, action: () => recordedLinks(tree, "node_modules", context) },
    { operation: "readFile", path: lock, action: () => recordedLinks(tree, "node_modules", context) },
    { operation: "readFile", path: join(source, "package.json"), action: () => workspacePackages(source) },
    { operation: "lstat", path: join(snapshot, "node_modules"), action: () => confineOwnPackages(snapshot, source) },
    { operation: "stat", path: join(snapshot, "packages/lib"), action: () => confineOwnPackages(snapshot, source) },
    { operation: "realpath", path: join(snapshot, "packages"), action: () => confineOwnPackages(snapshot, source) },
    { operation: "readFile", path: join(snapshot, "packages/lib/package.json"), action: () => confineOwnPackages(snapshot, source) },
    { operation: "readdir", path: join(snapshot, "packages"), action: () => confineOwnPackages(snapshot, source) },
  ];
  for (const { operation, path, action } of reads) {
    for (const code of codes) await injecting(operation, path, code, async () => {
      await assert.rejects(action, refusedRead(code, path));
      assert.equal(existsSync(join(snapshot, "node_modules")), false);
      assert.equal(readFileSync(join(own, "index.js"), "utf8"), sourceBefore);
      assert.equal(readFileSync(lock, "utf8"), lockBefore);
    });
  }
  for (const code of codes) {
    const destination = join(root, `no-borrow-${code}`);
    await injecting("realpath", own, code, async () => {
      await assert.rejects(() => provideDependency(source, destination, "node_modules", workspace), refusedRead(code, own));
      assert.equal(existsSync(join(destination, "node_modules")), false);
    });
  }
  for (const code of ["EMFILE", "ENFILE"]) {
    for (const [operation, path] of [
      ["stat", join(source, ".git")],
      ["readFile", join(source, ".git", "commondir")],
      ["realpath", join(source, ".git")],
    ] as const) await injecting(operation, path, code, async () => {
      await assert.rejects(() => projectSources(source), refusedRead(code, path));
    });
  }
  for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EIO", "UNKNOWN"]) {
    const error = failure("stat", "/test-input", code);
    const read = async () => { throw error; };
    const result = await readResult(read);
    assert.equal(result.kind, code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable");
    assert.equal(await available(read), null);
    await assert.rejects(() => requiredRead("/test-input", read), refusedRead(code, "/test-input"));
    if (result.kind === "missing") assert.equal(await optionalRead("/test-input", read), null);
    else await assert.rejects(() => optionalRead("/test-input", read), refusedRead(code, "/test-input"));
  }
  const programmingError = new TypeError("proof-programming-error");
  for (const read of [readResult, available, (action: () => Promise<never>) => optionalRead("/test-input", action)]) {
    await assert.rejects(() => read(async () => { throw programmingError; }), error => error === programmingError);
  }
  assert.notEqual(await linksIntoSource(tree, source), null);
  assert.equal((await recordedLinks(tree, "node_modules", context)).owned.length, 1);
  assert.equal(await confineOwnPackages(snapshot, source), null);
  assert.equal(realpathSync(join(snapshot, "node_modules", "@demo", "lib")), join(snapshot, "packages", "lib"));
  console.log(`accept-gate-proof: ${reads.length * codes.length} proof-read faults, clone decision, metadata resource exhaustion, distinct missing/unreadable states, no writes on refusal and healthy recovery passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
  console.log("accept-gate-proof: cleanup=true");
}
