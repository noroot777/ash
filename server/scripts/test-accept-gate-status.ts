// 源码身份的工作区比对不执行项目程序（accept-gate-status.ts）：门禁准备、批量预判、只是打开验收台都不许
// 调起项目配的 clean / process 过滤器；靠过滤器的文件（LFS 这类：工作区是真文件、库里是指针）stat 失效
// 时不许误报「未提交」，真改了照样拦。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-gate-status-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 用户自己的全局配置（core.autocrlf、全局过滤器…）不许影响用例。
process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
// stderr 不收：core.autocrlf 下 `git add` 对上万个文件逐个打换行提醒，会撑爆缓冲区。
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();

try {
  const { readGateSource } = await import("../src/accept-gate-source.js");
  // 目录名以空格结尾（Windows 建不出这种目录）：路径一个字节都不许被裁掉。
  const repo = join(root, process.platform === "win32" ? "repo" : "repo ");
  const marker = join(root, "program-ran");
  const script = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\necho ${name} >> '${marker}'\n${body}\n`, { mode: 0o755 });
    return path;
  };
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Gate Status Test");
  git(repo, "config", "user.email", "status@example.test");
  // demo 像 LFS：库里存的（大写）和工作区里的（小写）不是同一份字节，只有跑过滤器才认得出是同一个文件。
  git(repo, "config", "filter.demo.clean", script("clean", "tr a-z A-Z"));
  git(repo, "config", "filter.demo.smudge", script("smudge", "tr A-Z a-z"));
  git(repo, "config", "core.autocrlf", "true");
  writeFileSync(join(repo, ".gitattributes"), "*.dat filter=demo\n*.bin filter=proc\n");
  writeFileSync(join(repo, "asset.dat"), "hello\n");
  writeFileSync(join(repo, "raw.bin"), "raw\n");
  writeFileSync(join(repo, "plain.txt"), "plain\n");
  writeFileSync(join(repo, "crlf.txt"), "x\r\ny\r\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  assert.equal(git(repo, "cat-file", "-p", "HEAD:asset.dat"), "HELLO", "夹具：库里是过滤后的那份");
  // process 过滤器在提交之后才配上：调起它就会留下记号（真 git 还会因为它不说协议而报错）。
  git(repo, "config", "filter.proc.process", script("process", "exit 1"));
  writeFileSync(join(repo, ".git", "info", "exclude"), "local.log\n");

  const past = new Date(Date.now() - 3_600_000);
  const stale = (path: string, content?: string, when = past) => {
    if (content !== undefined) writeFileSync(join(repo, path), content);
    utimesSync(join(repo, path), when, when);
  };
  const quiet = async (label: string, check: () => Promise<unknown>) => {
    rmSync(marker, { force: true });
    await check();
    assert.equal(existsSync(marker), false, `${label}：不许调起项目程序`);
  };

  // 用户自己在工作区跑一次 git status：按项目配置核对并刷新索引记录（process 过滤器是坏的，先摘掉）。
  const refresh = () => {
    git(repo, "config", "--unset", "filter.proc.process");
    git(repo, "status", "--porcelain");
    git(repo, "config", "filter.proc.process", script("process", "exit 1"));
  };
  const unverified = /过滤器（demo）才能确认/;

  // ① 原样重写 + 改时间戳：stat 全失效，git 要逐个比内容，一律不执行程序。不靠过滤器就比得出来的照常
  // 判（换行按项目的 core.autocrlf 算、只被 info/exclude 忽略的不算未跟踪），工作区就是那份提交。
  stale("raw.bin", "raw\n");
  stale("plain.txt");
  stale("crlf.txt");
  writeFileSync(join(repo, "local.log"), "local\n");
  await quiet("原样重写", async () => assert.ok((await readGateSource(repo)).commit));

  // ② 靠过滤器的文件原样重写：不跑过滤器证明不了没改，如实说判不了（不是「未提交」，也不当干净）；
  // 用户刷新过索引记录就落回「没改」。
  stale("asset.dat", "hello\n");
  await quiet("过滤文件原样重写", () => assert.rejects(readGateSource(repo), unverified));
  refresh();
  await quiet("刷新之后", async () => assert.ok((await readGateSource(repo)).commit));

  // ③ 靠过滤器的文件，不跑过滤器也证明得了的改动照样拦：大小变了、只加了执行位。同样大小的改写证明
  // 不了，按判不了拒，不放行。
  stale("asset.dat", "hello world\n");
  await quiet("过滤文件改大小", () => assert.rejects(readGateSource(repo), /未提交/));
  stale("asset.dat", "hello\n");
  refresh();
  if (process.platform !== "win32") {
    chmodSync(join(repo, "asset.dat"), 0o755);
    await quiet("过滤文件加执行位", () => assert.rejects(readGateSource(repo), /未提交/));
    chmodSync(join(repo, "asset.dat"), 0o644);
    refresh();
  }
  // 时间戳换一个：和索引记录同一秒的同大小改写，git 自己按秒比 stat 也看不出来，那不是这里要钉的。
  stale("asset.dat", "jello\n", new Date(past.getTime() + 60_000));
  await quiet("过滤文件同大小改写", () => assert.rejects(readGateSource(repo), unverified));
  stale("asset.dat", "hello\n");
  refresh();

  // ④ 不靠过滤器的文件按原口径严格比内容：同样大小的改写照样拦。
  stale("plain.txt", "PLAIN\n");
  await quiet("普通文件同大小改写", () => assert.rejects(readGateSource(repo), /未提交/));
  stale("plain.txt", "plain\n");

  // ⑤ 暂存区对提交有改动（只比对象名）：靠过滤器的文件也照样拦。换回提交里那份之后，这一项在索引里
  // 没有 stat 记录（大小记成 0，git 自己也当「没核过」）：没有记录不是没改，按判不了拒。
  const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--no-filters", "--stdin"], { input: "OTHER\n", encoding: "utf8" }).trim();
  git(repo, "update-index", "--cacheinfo", `100644,${blob},asset.dat`);
  await quiet("暂存改动", () => assert.rejects(readGateSource(repo), /未提交/));
  git(repo, "update-index", "--cacheinfo", `100644,${git(repo, "rev-parse", "HEAD:asset.dat")},asset.dat`);
  await quiet("索引无记录", () => assert.rejects(readGateSource(repo), unverified));
  refresh();

  // ⑥ 没被忽略的未跟踪文件照样拦。
  writeFileSync(join(repo, "stray.txt"), "stray\n");
  await quiet("未跟踪文件", () => assert.rejects(readGateSource(repo), /未跟踪/));
  rmSync(join(repo, "stray.txt"));
  await quiet("复原", async () => assert.ok((await readGateSource(repo)).commit));

  // ⑦ 嵌套仓库是另一个配置域：git 会进去按它自己的配置比内容。暂存进来的子模块直接拒，没暂存的只算
  // 未跟踪，两种都不许进去调起它的过滤器（审查 oGZEQlZvnW1N F1）。
  const nested = join(repo, "nested");
  execFileSync("git", ["init", "-q", "-b", "main", nested]);
  git(nested, "config", "user.name", "Nested");
  git(nested, "config", "user.email", "nested@example.test");
  writeFileSync(join(nested, ".gitattributes"), "*.txt filter=inner\n");
  writeFileSync(join(nested, "inner.txt"), "inner\n");
  git(nested, "add", "-A");
  git(nested, "commit", "-qm", "nested");
  git(nested, "config", "filter.inner.clean", script("inner", "cat"));
  stale("nested/inner.txt", "inner\n");
  await quiet("未暂存的嵌套仓库", () => assert.rejects(readGateSource(repo), /未跟踪/));
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${git(nested, "rev-parse", "HEAD")},nested`);
  stale("nested/inner.txt");
  await quiet("暂存的子模块", () => assert.rejects(readGateSource(repo), /子模块/));
  git(repo, "update-index", "--force-remove", "nested");
  rmSync(nested, { recursive: true, force: true });

  // ⑧ 大批判不了的过滤文件：路径加起来远超命令行上限，也得照常给出结论，不能报 E2BIG（同一审查 F3）。
  const bulk = join(repo, "b".repeat(60));
  mkdirSync(bulk);
  writeFileSync(join(repo, ".gitattributes"), "*.dat filter=demo\n*.bin filter=proc\n*.big filter=late\n");
  const names = Array.from({ length: 15_000 }, (_, i) => `${String(i).padStart(5, "0")}${"x".repeat(100)}.big`);
  for (const name of names) writeFileSync(join(bulk, name), "LATE\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "bulk");
  git(repo, "config", "filter.late.clean", script("late", "tr a-z A-Z"));
  for (const name of names) stale(join(bulk.slice(repo.length + 1), name), "late\n");
  await quiet("大批过滤文件", () => assert.rejects(readGateSource(repo), /有 15000 个文件（[^）]*…）要经过项目配置的过滤器（late）才能确认/));
  git(repo, "config", "--unset", "filter.late.clean");
  for (const name of names) writeFileSync(join(bulk, name), "LATE\n");
  refresh();
  await quiet("复原", async () => assert.ok((await readGateSource(repo)).commit));

  // ⑨ 只是打开验收台（已有一次门禁记录、要算新鲜度）与批量预判：同样不调起过滤器，判不了的如实
  // 显示在状态卡上。
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { acceptGateRuns, projects, tasks } = await import("../src/db/schema.js");
  const { acceptGateState } = await import("../src/accept-gate-state.js");
  const { acceptGateWouldRun } = await import("../src/accept-gate.js");
  await ensureSchema();
  const stamp = new Date().toISOString();
  const command = `"${process.execPath}" -e "process.exit(0)"`;
  await db.insert(projects).values({ id: "status-project", name: "status", repoPath: repo, acceptGateCommand: command, createdAt: stamp });
  await db.insert(tasks).values({ id: "status-task", projectId: "status-project", title: "status", body: "", status: "done",
    useWorktree: false, createdAt: stamp, updatedAt: stamp });
  await db.insert(acceptGateRuns).values({ id: "status-run", taskId: "status-task", projectId: "status-project", command,
    cwd: join(root, "old-snapshot"), status: "passed", logPath: join(root, "old.log"), startedAt: stamp });
  stale("asset.dat", "hello\n");
  await quiet("读验收台状态", async () => {
    const state = await acceptGateState("status-task");
    assert.equal(state.unavailable ?? null, null, "本机门禁能力可用，状态卡才会去读源码身份");
    assert.match(state.sourceError ?? "", unverified);
    assert.equal(state.latest?.status, "passed");
  });
  const [task] = await db.select().from(tasks);
  const [project] = await db.select().from(projects);
  await quiet("批量预判", () => acceptGateWouldRun(task!, project!));
  console.log("accept-gate-status: 源码身份比对不调起 clean/process 过滤器也不进嵌套仓库；过滤文件证明得了的改动照拦、证明不了的如实说判不了；大批路径不撞命令行上限；换行/排除照项目配置；目录名尾部空格不被裁；验收台与预判同样不执行程序");
} finally {
  rmSync(root, { recursive: true, force: true });
}
