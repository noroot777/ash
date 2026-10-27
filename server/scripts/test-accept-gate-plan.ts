import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-gate-plan-"));
process.env.ASH_RUNS_DIR = join(root, "execution", "data", "runs");
const { createGateSnapshot, gateSnapshotPath, gateSourceMatches, readGateSource, verifyGateSnapshot } =
  await import("../src/accept-gate-source.js");
const { resolutionInputs } = await import("../src/accept-gate-resolution.js");
const save = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const npm = (cwd: string, ...args: string[]) => execFileSync(
  process.platform === "win32" ? "cmd.exe" : "npm",
  process.platform === "win32" ? ["/d", "/s", "/c", `npm ${args.map(arg => JSON.stringify(arg.replace(/\\/g, "/"))).join(" ")}`] : args,
  { cwd, encoding: "utf8", windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const install = (cwd: string, ...args: string[]) => npm(cwd, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...args);
const commit = (cwd: string) => { git(cwd, "add", "-A"); git(cwd, "commit", "-qm", "fixture"); };
const manifest = (cwd: string) => JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
const project = (name: string, fields: object = {}) => {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Gate Plan Test");
  git(cwd, "config", "user.email", "gate@example.test");
  git(cwd, "config", "core.autocrlf", "false");
  save(join(cwd, ".gitignore"), "node_modules/\ndata/\n.worktrees/\n");
  save(join(cwd, "package.json"), JSON.stringify({ name, version: "1.0.0", private: true, ...fields }));
  return cwd;
};
const ownPackage = (cwd: string, directory: string, value: string) => {
  save(join(cwd, directory, "package.json"), JSON.stringify({ name: "@demo/lib", version: "1.0.0", type: "module", main: "index.mjs" }));
  save(join(cwd, directory, "index.mjs"), `export const value = ${JSON.stringify(value)};\n`);
};
const pack = (name: string, version: string, body: string) => {
  const cwd = join(root, `pack-${name}-${version}`);
  save(join(cwd, "package.json"), JSON.stringify({ name, version, type: "module", main: "index.mjs" }));
  save(join(cwd, "index.mjs"), body);
  return join(cwd, npm(cwd, "pack", "--offline", "--ignore-scripts", "--silent").split(/\r?\n/).pop()!);
};
const probe = (cwd: string, spec: string) => {
  const script = `import(${JSON.stringify(spec)}).then(m=>console.log(m.value))`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd, encoding: "utf8" }).trim();
};

try {
  const consumer = pack("plain-consumer", "1.0.0", 'export { value } from "@demo/lib";\n');
  const host = project("shadowed", { workspaces: ["packages/*"], devDependencies: { "plain-consumer": `file:${consumer}` } });
  ownPackage(host, "packages/lib", "MAIN_OLD");
  install(host);
  commit(host);
  const task = join(host, ".worktrees", "task");
  git(host, "worktree", "add", "--detach", task, "HEAD");
  ownPackage(task, "packages/lib", "TASK_NEW");
  commit(task);
  npm(task, "ci", "--omit=dev", "--offline", "--ignore-scripts", "--no-audit", "--no-fund");
  assert.equal(existsSync(join(task, "node_modules", "plain-consumer")), false);
  assert.equal(probe(task, "@demo/lib"), "TASK_NEW");
  assert.equal(probe(task, "plain-consumer"), "MAIN_OLD");
  const hiddenTarget = join(host, "data", "runs", "hidden.source");
  const hiddenSource = await readGateSource(task, hiddenTarget);
  await assert.rejects(createGateSnapshot(task, hiddenTarget, hiddenSource), /无法证明隔离/);
  assert.equal(existsSync(hiddenTarget), false);
  assert.equal(probe(host, "plain-consumer"), "MAIN_OLD");

  const sourceParent = join(root, "source-parent");
  const executionParent = join(root, "execution");
  const versions = ["1.0.0", "2.0.0", "3.0.0"].map(version => pack("ambient-demo", version,
    `export const value = ${JSON.stringify(version)};\n`));
  for (const [cwd, tarball] of [[sourceParent, versions[0]], [executionParent, versions[1]]]) {
    save(join(cwd, "package.json"), JSON.stringify({ private: true, dependencies: { "ambient-demo": `file:${tarball}` } }));
    install(cwd);
  }
  const separated = project("source-parent/project");
  commit(separated);
  const actualTarget = gateSnapshotPath("different-ancestors", "first");
  const before = await readGateSource(separated, actualTarget);
  const receipt = { sourceCommit: before.commit, sourceFingerprint: before.fingerprint, sourceAmbient: before.ambient };
  assert.equal(probe(separated, "ambient-demo"), "1.0.0");
  await createGateSnapshot(separated, actualTarget, before);
  assert.equal(probe(actualTarget, "ambient-demo"), "2.0.0");
  assert.equal(await verifyGateSnapshot(actualTarget, before), true);
  install(executionParent, `ambient-demo@file:${versions[2]}`);
  const after = await readGateSource(separated, actualTarget);
  assert.equal(before.fingerprint, after.fingerprint);
  assert.notEqual(before.ambient, after.ambient);
  assert.equal(gateSourceMatches(receipt, after), false);
  assert.equal(await verifyGateSnapshot(actualTarget, before), false);
  const otherLocation = join(sourceParent, "data", "runs", "different.source");
  await assert.rejects(createGateSnapshot(separated, otherLocation, after), /实际依赖输入与登记计划不同/);
  assert.equal(existsSync(otherLocation), false);

  const foreign = project("foreign", { type: "module", main: "index.mjs", bin: { "external-cli": "cli.mjs" } });
  save(join(foreign, "index.mjs"), 'export const value = "EXTERNAL_OK";\n');
  save(join(foreign, "cli.mjs"), '#!/usr/bin/env node\nimport { value } from "./index.mjs"; console.log(value);\n');
  commit(foreign);
  for (const clone of [false, true]) {
    const external = project(`external-${clone}`, { dependencies: { "tool-alias": "file:../foreign" },
      ...(clone ? { workspaces: ["packages/*"] } : {}) });
    if (clone) ownPackage(external, "packages/lib", "CERTIFIED");
    install(external);
    commit(external);
    const target = join(external, "data", "runs", "external.source");
    const source = await readGateSource(external, target);
    await createGateSnapshot(external, target, source);
    assert.equal(probe(target, "tool-alias"), "EXTERNAL_OK");
    const command = join(target, "node_modules", ".bin", "external-cli");
    const output = process.platform === "win32"
      ? execFileSync("cmd.exe", ["/d", "/s", "/c", `""${command}.cmd""`], { encoding: "utf8", windowsVerbatimArguments: true })
      : execFileSync(process.execPath, [command], { encoding: "utf8" });
    assert.equal(output.trim(), "EXTERNAL_OK");
    assert.equal(await verifyGateSnapshot(target, source), true);
  }

  const deleted = project("alias-sample", { workspaces: ["packages/*"], dependencies: { "sample-alias": "file:examples/lib" } });
  ownPackage(deleted, "packages/lib", "ORIGINAL");
  ownPackage(deleted, "examples/lib", "UNRELATED_SAMPLE");
  install(deleted);
  commit(deleted);
  const deletedTask = join(deleted, ".worktrees", "task");
  git(deleted, "worktree", "add", "--detach", deletedTask, "HEAD");
  git(deletedTask, "rm", "-r", "packages/lib");
  commit(deletedTask);
  const deletedTarget = join(deleted, "data", "runs", "deleted.source");
  const deletedSource = await readGateSource(deletedTask, deletedTarget);
  await assert.rejects(createGateSnapshot(deletedTask, deletedTarget, deletedSource), /没有.*替代位置/);
  assert.equal(existsSync(deletedTarget), false);
  assert.equal(probe(deleted, "@demo/lib"), "ORIGINAL");

  const moved = project("same-entry-move", { dependencies: { "own-alias": "file:packages/lib" } });
  ownPackage(moved, "packages/lib", "ORIGINAL");
  install(moved);
  commit(moved);
  const movedTask = join(moved, ".worktrees", "task");
  git(moved, "worktree", "add", "--detach", movedTask, "HEAD");
  git(movedTask, "mv", "packages/lib", "packages/relocated");
  const movedManifest = manifest(movedTask);
  movedManifest.dependencies["own-alias"] = "file:packages/relocated";
  save(join(movedTask, "package.json"), JSON.stringify(movedManifest));
  ownPackage(movedTask, "packages/relocated", "MOVED_NEW");
  commit(movedTask);
  const movedTarget = join(moved, "data", "runs", "moved.source");
  await createGateSnapshot(movedTask, movedTarget, await readGateSource(movedTask, movedTarget));
  assert.equal(probe(movedTarget, "own-alias"), "MOVED_NEW");

  const deep = join(root, "deep");
  let directory = deep;
  for (let depth = 0; depth < 12; depth++) {
    directory = join(directory, "node_modules", `consumer-${depth}`);
    save(join(directory, "package.json"), JSON.stringify({ name: `consumer-${depth}`, version: "1.0.0" }));
  }
  const inputs = await resolutionInputs([deep]);
  assert.equal(inputs.flatMap(input => input.entries).filter(item => item.entry.startsWith("consumer-")).length, 12);
  assert.deepEqual(await resolutionInputs([deep]), inputs);
  console.log("accept-gate-plan: shadowed consumer closure, actual execution identity, external aliased CLI, entry-specific relocation and unbounded nested discovery passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  console.log("accept-gate-plan: cleanup=true");
}
