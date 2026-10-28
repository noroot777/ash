import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ash-gate-plan-")));
process.env.ASH_RUNS_DIR = join(root, "execution", "data", "runs");
const { createGateSnapshot, gateSnapshotPath, gateSourceMatches, readGateSource, verifyGateSnapshot } =
  await import("../src/accept-gate-source.js");
const { resolutionInputs } = await import("../src/accept-gate-resolution.js");
const { ambientDigest, recordedLinks, linksIntoSource, provideDependency, workspacePackages } = await import("../src/accept-gate-deps.js");
const { projectSources } = await import("../src/accept-gate-project.js");
const { stat, realpath, readdir } = await import("node:fs/promises");
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
const pack = (name: string, version: string, body: string, fields: object = {}) => {
  const cwd = join(root, `pack-${name}-${version}`);
  save(join(cwd, "package.json"), JSON.stringify({ name, version, type: "module", main: "index.mjs", ...fields }));
  save(join(cwd, "index.mjs"), body);
  return join(cwd, npm(cwd, "pack", "--offline", "--ignore-scripts", "--silent").split(/\r?\n/).pop()!);
};
const probe = (cwd: string, spec: string) => {
  const script = `import(${JSON.stringify(spec)}).then(m=>console.log(m.value))`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd, encoding: "utf8" }).trim();
};

try {
  const consumer = pack("plain-consumer", "1.0.0", 'export { value } from "@demo/lib";\n',
    { bin: { "normal-tool": "index.mjs" } });
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
  const normalCommand = join(host, "node_modules", ".bin", "normal-tool" + (process.platform === "win32" ? ".cmd" : ""));
  const commandBefore = readFileSync(normalCommand, "utf8");
  const hiddenTarget = join(host, "data", "runs", "hidden.source");
  const hiddenSource = await readGateSource(task, hiddenTarget);
  await assert.rejects(createGateSnapshot(task, hiddenTarget, hiddenSource), error => {
    assert.match(String(error), /无法证明隔离/);
    assert.ok(String(error).includes(join(host, "node_modules")));
    assert.match(String(error), /安装提供 plain-consumer 的依赖/);
    assert.match(String(error), /ASH_RUNS_DIR/);
    assert.doesNotMatch(String(error), /删除|遗留|损坏项/);
    return true;
  });
  assert.equal(existsSync(hiddenTarget), false);
  assert.equal(probe(host, "plain-consumer"), "MAIN_OLD");
  assert.equal(readFileSync(normalCommand, "utf8"), commandBefore);
  const isolatedTarget = join(root, "isolated-runs", "isolated.source");
  await createGateSnapshot(task, isolatedTarget, await readGateSource(task, isolatedTarget));
  assert.equal(probe(isolatedTarget, "@demo/lib"), "TASK_NEW");
  npm(task, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund");
  const alignedTarget = join(host, "data", "runs", "aligned.source");
  await createGateSnapshot(task, alignedTarget, await readGateSource(task, alignedTarget));
  assert.equal(probe(alignedTarget, "plain-consumer"), "TASK_NEW");
  const leaf = project("external-leaf", { type: "module", main: "index.mjs" });
  save(join(leaf, "index.mjs"), 'export const value = "LEAF";\n');
  commit(leaf);
  install(host, `external-only@file:${leaf}`);
  const selectedTarget = join(host, "data", "runs", "selected.source");
  await createGateSnapshot(task, selectedTarget, await readGateSource(task, selectedTarget));
  const ancestor = (await resolutionInputs([selectedTarget])).find(input => input.path === join(host, "node_modules"))!;
  assert.deepEqual(ancestor.selected.map(item => item.entry), ["external-only"]);
  assert.ok(ancestor.entries.length > ancestor.selected.length);
  assert.equal(probe(selectedTarget, "plain-consumer"), "TASK_NEW");
  assert.equal(probe(selectedTarget, "external-only"), "LEAF");

  const removedTask = join(host, ".worktrees", "removed-consumer");
  git(host, "worktree", "add", "--detach", removedTask, git(task, "rev-parse", "HEAD"));
  const removedManifest = manifest(removedTask);
  delete removedManifest.devDependencies;
  save(join(removedTask, "package.json"), JSON.stringify(removedManifest));
  install(removedTask);
  commit(removedTask);
  assert.equal(existsSync(join(removedTask, "node_modules", "plain-consumer")), false);
  const rawLayout = join(host, "data", "runs", "direct-only-layout.source");
  save(join(rawLayout, "package.json"), JSON.stringify(removedManifest));
  ownPackage(rawLayout, "packages/lib", "TASK_NEW");
  assert.equal(await provideDependency(removedTask, rawLayout, "node_modules", await workspacePackages(removedTask)), "clone");
  const rawAncestor = (await resolutionInputs([rawLayout])).find(input => input.path === join(host, "node_modules"))!;
  assert.equal(rawAncestor.direct.some(item => item.entry === join("@demo", "lib")), false);
  assert.equal(rawAncestor.direct.some(item => item.entry === "plain-consumer"), true);
  assert.equal(rawAncestor.selected.some(item => item.entry === join("@demo", "lib")), true);
  assert.equal(probe(rawLayout, "@demo/lib"), "TASK_NEW");
  assert.equal(probe(rawLayout, "plain-consumer"), "MAIN_OLD");
  save(join(host, "packages/lib/index.mjs"), 'export const value = "MAIN_LIVE";\n');
  assert.equal(probe(rawLayout, "plain-consumer"), "MAIN_LIVE");
  assert.equal(probe(rawLayout, "@demo/lib"), "TASK_NEW");
  save(join(host, "packages/lib/index.mjs"), 'export const value = "MAIN_OLD";\n');
  const removedTarget = join(host, "data", "runs", "removed-consumer.source");
  await assert.rejects(createGateSnapshot(removedTask, removedTarget, await readGateSource(removedTask, removedTarget)), /无法证明隔离/);
  assert.equal(existsSync(removedTarget), false);
  console.log("accept-gate-plan: deleted dependency counterexample: direct own entry hidden; indirect MAIN_OLD -> MAIN_LIVE; production refuses without residue");

  for (const relocate of [false, true]) {
    const built = project(`built-cli-${relocate}`, { workspaces: ["packages/*"],
      dependencies: { "plain-consumer": `file:${consumer}` } });
    save(join(built, ".gitignore"), "node_modules/\ndata/\n.worktrees/\ndist/\n");
    ownPackage(built, "packages/lib", "MAIN_OLD");
    const builtManifest = manifest(join(built, "packages/lib"));
    builtManifest.bin = { "build-cli": "dist/cli.mjs" };
    builtManifest.main = "dist/index.mjs";
    save(join(built, "packages/lib/package.json"), JSON.stringify(builtManifest));
    save(join(built, "packages/lib/build.mjs"), 'import { mkdirSync, writeFileSync } from "node:fs";\n'
      + 'const dist = new URL("./dist/", import.meta.url); mkdirSync(dist, { recursive: true });\n'
      + 'writeFileSync(new URL("cli.mjs", dist), \'import { value } from "../index.mjs"; console.log(value);\\n\');\n'
      + 'writeFileSync(new URL("index.mjs", dist), \'export { value } from "../index.mjs";\\n\');\n');
    execFileSync(process.execPath, [join(built, "packages/lib/build.mjs")]);
    install(built);
    const installedCli = join(built, "node_modules", ".bin", "build-cli");
    for (const suffix of ["", ".cmd", ".ps1"]) rmSync(installedCli + suffix, { force: true });
    symlinkSync(join("..", "@demo", "lib", "dist", "cli.mjs"), installedCli, "file");
    commit(built);
    const builtTask = join(built, ".worktrees", "task");
    git(built, "worktree", "add", "--detach", builtTask, "HEAD");
    npm(builtTask, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund");
    const packageDirectory = relocate ? "packages/relocated" : "packages/lib";
    if (relocate) git(builtTask, "mv", "packages/lib", packageDirectory);
    save(join(builtTask, packageDirectory, "index.mjs"), 'export const value = "TASK_BUILT";\n');
    commit(builtTask);
    const taskCli = join(builtTask, "node_modules", ".bin", "build-cli");
    for (const suffix of ["", ".cmd", ".ps1"]) rmSync(taskCli + suffix, { force: true });
    symlinkSync(join("..", "@demo", "lib", "dist", "cli.mjs"), taskCli, "file");
    const builtTarget = join(built, "data", "runs", "build.source");
    const builtSource = await readGateSource(builtTask, builtTarget);
    await createGateSnapshot(builtTask, builtTarget, builtSource);
    const snapshotCli = join(builtTarget, "node_modules", ".bin", "build-cli");
    assert.equal(lstatSync(snapshotCli).isSymbolicLink(), true);
    assert.equal(existsSync(snapshotCli), false);
    assert.equal(await verifyGateSnapshot(builtTarget, builtSource), true);
    execFileSync(process.execPath, [join(builtTarget, packageDirectory, "build.mjs")]);
    assert.equal(execFileSync(process.execPath, [snapshotCli], { encoding: "utf8" }).trim(), "TASK_BUILT");
    assert.equal(probe(builtTarget, "@demo/lib"), "TASK_BUILT");
    assert.equal(probe(builtTarget, "plain-consumer"), "TASK_BUILT");
    assert.equal(readFileSync(join(built, "node_modules", ".bin", "normal-tool" + (process.platform === "win32" ? ".cmd" : "")), "utf8"), commandBefore);
    save(join(built, "packages/lib/dist/cli.mjs"), 'console.log("MAIN_LIVE");\n');
    assert.equal(execFileSync(process.execPath, [snapshotCli], { encoding: "utf8" }).trim(), "TASK_BUILT");
    assert.equal(await verifyGateSnapshot(builtTarget, builtSource), true);
  }

  for (const workspace of [false, true]) {
    const nested = project(`nested-source-${workspace}`, workspace
      ? { workspaces: ["vendor/*"] } : { dependencies: { "@demo/lib": "file:vendor/lib" } });
    save(join(nested, ".gitignore"), "node_modules/\ndata/\n.worktrees/\nvendor/\n");
    ownPackage(nested, "vendor/lib", "NESTED_LIVE");
    const nestedRepository = join(nested, "vendor", "lib");
    git(nestedRepository, "init", "-b", "main");
    git(nestedRepository, "config", "user.name", "Nested Fixture");
    git(nestedRepository, "config", "user.email", "nested@example.test");
    commit(nestedRepository);
    install(nested);
    commit(nested);
    assert.equal(git(nested, "ls-tree", "HEAD", "vendor/lib"), "");
    const nestedTask = join(nested, ".worktrees", "task");
    git(nested, "worktree", "add", "--detach", nestedTask, "HEAD");
    for (const sourceRoot of [nested, nestedTask]) {
      const context = await projectSources(sourceRoot);
      assert.deepEqual(await context.locate(nestedRepository), { kind: "owned", inside: join("vendor", "lib") });
      const installed = await recordedLinks(join(nested, "node_modules"), "node_modules", context);
      assert.equal(installed.owned.find(item => item.entry === "@demo/lib")?.inside, join("vendor", "lib"));
      assert.notEqual(await linksIntoSource(join(nested, "node_modules"), sourceRoot), null);
      const target = join(nested, "data", "runs", `nested-${sourceRoot === nested}.source`);
      await assert.rejects(createGateSnapshot(sourceRoot, target, await readGateSource(sourceRoot, target)), error => {
        const message = String(error);
        if (sourceRoot === nested) {
          assert.match(message, /无法证明在快照内/);
          assert.ok(message.includes(join(target, "vendor")));
          assert.ok(message.includes(join(nested, "vendor")));
          assert.match(message, /快照之外.*链/);
        } else assert.match(message, /没有这个位置.*替代位置/);
        assert.match(message, /纳入 Git 并提交/);
        assert.match(message, /停止将该目录作为本项目自有包的安装来源/);
        return true;
      });
      assert.equal(existsSync(target), false);
      assert.equal(probe(nested, "@demo/lib"), "NESTED_LIVE");
    }
  }

  for (const clone of [false, true]) {
    const stale = join(root, `stale-external-${clone}`);
    ownPackage(stale, ".", "EXTERNAL_VALID");
    save(join(stale, ".git"), "gitdir: ../removed-git-metadata\n");
    const registered = project(`unknown-host-${clone}`, { dependencies: { "external-only": `file:../stale-external-${clone}` },
      ...(clone ? { workspaces: ["packages/*"] } : {}) });
    if (clone) ownPackage(registered, "packages/lib", "CERTIFIED");
    install(registered);
    commit(registered);
    const context = await projectSources(registered);
    const location = await context.locate(stale);
    assert.equal(location.kind, "unknown");
    const links = await recordedLinks(join(registered, "node_modules"), "node_modules", context);
    assert.equal(links.owned.length, clone ? 1 : 0);
    assert.equal(links.external.length, 0);
    assert.equal(links.unknown[0].entry, "external-only");
    assert.deepEqual(links.unknown[0].location, location);
    const target = join(registered, "data", "runs", "unknown.source");
    const refuseIdentity = async () => {
      await assert.rejects(createGateSnapshot(registered, target, await readGateSource(registered, target)), error => {
        assert.match(String(error), /版本库身份无法读取/);
        assert.ok(String(error).includes(stale));
        assert.ok(String(error).includes(join(stale, ".git")));
        assert.match(String(error), /修复该元数据/);
        assert.doesNotMatch(String(error), /安装记录里没有这个入口|装出来的依赖和安装记录不一致|请重新安装依赖/);
        return true;
      });
      assert.equal(existsSync(target), false);
      assert.equal(probe(registered, "external-only"), "EXTERNAL_VALID");
    };
    await refuseIdentity();
    const hiddenLock = join(registered, "node_modules", ".package-lock.json");
    const lockBefore = readFileSync(hiddenLock, "utf8");
    rmSync(hiddenLock);
    await refuseIdentity();
    save(hiddenLock, lockBefore);
    rmSync(join(stale, ".git"));
    const source = await readGateSource(registered, target);
    await createGateSnapshot(registered, target, source);
    assert.equal(probe(target, "external-only"), "EXTERNAL_VALID");
    assert.equal(await verifyGateSnapshot(target, source), true);
  }

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

  const identityHost = project("identity-A", { workspaces: ["packages/*"] });
  ownPackage(identityHost, "packages/mcp", "ASH_EXTERNAL");
  const hostPackage = manifest(join(identityHost, "packages/mcp"));
  hostPackage.name = "@ash/mcp";
  save(join(identityHost, "packages/mcp/package.json"), JSON.stringify(hostPackage));
  save(join(identityHost, "loose/cli.mjs"), 'console.log("ORPHAN_SOURCE");\n');
  install(identityHost);
  const commandDirectory = join(identityHost, "node_modules", ".bin");
  mkdirSync(commandDirectory, { recursive: true });
  symlinkSync(commandDirectory, join(commandDirectory, ".bin"), process.platform === "win32" ? "junction" : "dir");
  symlinkSync("cycle", join(commandDirectory, "cycle"), "file");
  const orphanCommand = join(commandDirectory, "orphan");
  symlinkSync(join(identityHost, "loose", "cli.mjs"), orphanCommand, "file");
  commit(identityHost);
  const hostEntries = (await resolutionInputs([identityHost])).flatMap(input => input.entries);
  assert.equal(hostEntries.some(item => item.entry === join(".bin", ".bin")), false);
  assert.equal(hostEntries.some(item => item.entry === join(".bin", "cycle")), false);
  assert.equal(hostEntries.find(item => item.entry === join(".bin", "orphan"))?.kind, "command");
  for (const installed of [false, true]) {
    const independent = project(`identity-B-${installed}`, installed ? { workspaces: ["packages/*"] } : {});
    if (installed) {
      ownPackage(independent, "packages/mcp", "B_CERTIFIED");
      const independentPackage = manifest(join(independent, "packages/mcp"));
      independentPackage.name = "@ash/mcp";
      save(join(independent, "packages/mcp/package.json"), JSON.stringify(independentPackage));
      install(independent);
    }
    commit(independent);
    const identitySource = await projectSources(independent);
    assert.equal((await identitySource.locate(join(identityHost, "packages/mcp"))).kind, "external");
    const independentTarget = join(identityHost, "data", "runs", `foreign-${installed}.source`);
    const independentSource = await readGateSource(independent, independentTarget);
    await createGateSnapshot(independent, independentTarget, independentSource);
    assert.equal(probe(independentTarget, "@ash/mcp"), installed ? "B_CERTIFIED" : "ASH_EXTERNAL");
    assert.equal(await verifyGateSnapshot(independentTarget, independentSource), true);
    assert.equal(lstatSync(orphanCommand).isSymbolicLink(), true);
  }
  const identityTask = join(identityHost, ".worktrees", "task");
  git(identityHost, "worktree", "add", "--detach", identityTask, "HEAD");
  save(join(identityTask, "packages/mcp/index.mjs"), 'export const value = "TASK_CERTIFIED";\n');
  commit(identityTask);
  const ownIdentity = await projectSources(identityTask);
  assert.deepEqual(await ownIdentity.locate(join(identityHost, "packages/mcp")), { kind: "owned", inside: join("packages", "mcp") });
  const orphanTarget = join(identityHost, "data", "runs", "orphan.source");
  await assert.rejects(createGateSnapshot(identityTask, orphanTarget, await readGateSource(identityTask, orphanTarget)), error => {
    assert.match(String(error), /命令入口.*不是包名/);
    assert.match(String(error), /无法证明安装来源/);
    assert.match(String(error), /删除该入口/);
    assert.ok(String(error).includes(orphanCommand));
    return true;
  });
  assert.equal(existsSync(orphanTarget), false);
  assert.equal(lstatSync(orphanCommand).isSymbolicLink(), true);
  rmSync(orphanCommand);
  const garbageTarget = join(identityHost, "data", "runs", "garbage.source");
  await createGateSnapshot(identityTask, garbageTarget, await readGateSource(identityTask, garbageTarget));
  assert.equal(probe(garbageTarget, "@ash/mcp"), "TASK_CERTIFIED");
  assert.equal(realpathSync(join(garbageTarget, "node_modules", "@ash", "mcp")), join(garbageTarget, "packages", "mcp"));
  save(join(identityHost, "packages/mcp/index.mjs"), 'export const value = "MAIN_MUTATED";\n');
  assert.equal(probe(garbageTarget, "@ash/mcp"), "TASK_CERTIFIED");

  const memoRoot = join(root, "memo");
  for (let index = 0; index < 48; index++) {
    save(join(memoRoot, "node_modules", `pkg-${index}`, "package.json"), JSON.stringify({ name: `pkg-${index}`, version: "1.0.0" }));
  }
  const reads = { stat: new Map<string, number>(), realpath: new Map<string, number>(), readdir: new Map<string, number>() };
  const count = <Value>(counts: Map<string, number>, path: string, read: () => Promise<Value>) => {
    counts.set(path, (counts.get(path) ?? 0) + 1);
    return read();
  };
  const memoInputs = await resolutionInputs([memoRoot], {
    stat: path => count(reads.stat, path, () => stat(path)),
    realpath: path => count(reads.realpath, path, () => realpath(path)),
    readdir: path => count(reads.readdir, path, () => readdir(path)),
  });
  assert.equal(memoInputs.find(input => input.path === join(memoRoot, "node_modules"))!.selected.length, 48);
  for (const counts of Object.values(reads)) assert.ok([...counts.values()].every(calls => calls === 1));
  for (let index = 0; index < 48; index++) assert.equal(reads.stat.get(join(memoRoot, "node_modules", `pkg-${index}`)), 1);
  assert.deepEqual(await resolutionInputs([memoRoot]), memoInputs);

  const failedRoot = join(memoRoot, "project");
  save(join(failedRoot, "node_modules", "pkg-0", "package.json"), '{"name":"pkg-0","version":"2.0.0"}');
  const failedPath = join(failedRoot, "node_modules", "pkg-0");
  for (const code of ["ENAMETOOLONG", "EIO", "UNKNOWN"]) {
    const injectedReads = new Map<string, number>();
    const faultInputs = await resolutionInputs([failedRoot], { realpath, readdir, stat: path => {
      injectedReads.set(path, (injectedReads.get(path) ?? 0) + 1);
      if (path === failedPath) throw Object.assign(new Error(code), { code, errno: -1, syscall: "stat", path });
      return stat(path);
    } });
    assert.equal(injectedReads.get(failedPath), 1);
    assert.equal(faultInputs.find(input => input.path === join(failedRoot, "node_modules"))!.entries.length, 0);
    assert.ok(faultInputs.find(input => input.path === join(memoRoot, "node_modules"))!.selected.some(item => item.entry === "pkg-0"));
  }
  const recovered = await resolutionInputs([failedRoot]);
  assert.equal(recovered.find(input => input.path === join(failedRoot, "node_modules"))!.entries.length, 1);
  for (const error of [new TypeError("invalid argument"), Object.assign(new Error("bug"), { code: "ERR_INVALID_ARG_TYPE" })]) {
    await assert.rejects(resolutionInputs([failedRoot], { realpath, readdir, stat: async () => { throw error; } }), actual => actual === error);
  }
  for (const code of ["EMFILE", "ENFILE"]) {
    for (const operation of ["stat", "realpath", "readdir"] as const) {
      const exhausted = Object.assign(new Error(code), { code, errno: -1, syscall: operation });
      await assert.rejects(resolutionInputs([failedRoot], { stat, realpath, readdir,
        [operation]: async () => { throw exhausted; } }), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, exhausted);
        assert.match(error.message, /文件句柄耗尽.*无法确认隔离/);
        assert.match(error.message, /释放占用的文件句柄或提高系统限额/);
        return true;
      });
    }
  }
  await resolutionInputs([join(root, "long-" + "x".repeat(1024))]);

  const deep = join(root, "deep");
  let directory = deep;
  for (let depth = 0; depth < 12; depth++) {
    directory = join(directory, "node_modules", `consumer-${depth}`);
    save(join(directory, "package.json"), JSON.stringify({ name: `consumer-${depth}`, version: "1.0.0" }));
  }
  const inputs = await resolutionInputs([deep]);
  assert.equal(inputs.flatMap(input => input.entries).filter(item => item.entry.startsWith("consumer-")).length, 12);
  assert.deepEqual(await resolutionInputs([deep]), inputs);
  const malformed = join(root, "malformed");
  const malformedProject = join(malformed, "project");
  save(join(malformed, "node_modules", "@stray"), "not a scope directory");
  save(join(malformed, "ordinary-file"), "not a bin directory");
  symlinkSync(join(malformed, "ordinary-file"), join(malformed, "node_modules", ".bin"), "file");
  symlinkSync(join(malformed, "missing"), join(malformed, "node_modules", "dangling"), "dir");
  save(join(malformed, "node_modules", "valid", "package.json"), '{"name":"valid","version":"1.0.0"}');
  save(join(malformedProject, "node_modules"), "not a dependency directory");
  const malformedInputs = await resolutionInputs([malformedProject]);
  assert.deepEqual(malformedInputs.find(input => input.path === join(malformed, "node_modules"))!.selected.map(item => item.entry), ["valid"]);
  assert.equal(malformedInputs.some(input => input.path === join(malformedProject, "node_modules")), false);
  assert.deepEqual(await resolutionInputs([malformedProject]), malformedInputs);
  assert.equal(await ambientDigest(malformedProject, malformedProject), await ambientDigest(malformedProject, malformedProject));
  if (process.platform !== "win32") {
    for (const denied of [join(malformed, "node_modules", "@denied"), join(malformed, "node_modules", ".bin"),
      join(malformed, "node_modules")]) {
      if (denied.endsWith(".bin")) rmSync(denied);
      mkdirSync(denied, { recursive: true });
      chmodSync(denied, 0);
      try {
        assert.throws(() => readdirSync(denied), { code: "EACCES" });
        await resolutionInputs([malformedProject]);
        await ambientDigest(malformedProject, malformedProject);
      } finally { chmodSync(denied, 0o755); }
    }
  } else console.log("accept-gate-plan: POSIX unreadable-directory fixture skipped on Windows (no ACL changes)");
  console.log("accept-gate-plan: post-binding consumers, non-destructive remedies, nested repositories, unknown metadata, project identity, per-path read counts and prior provenance cases passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  console.log("accept-gate-plan: cleanup=true");
}
