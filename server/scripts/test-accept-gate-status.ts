// 源码身份的工作区比对不执行项目程序（accept-gate-status.ts）：门禁准备、批量预判、只是打开验收台都不许
// 调起项目配的 clean / process 过滤器；靠过滤器的文件（LFS 这类：工作区是真文件、库里是指针）stat 失效
// 时不许误报「未提交」，真改了照样拦。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-gate-status-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 用户自己的全局配置（core.autocrlf、全局过滤器…）不许影响用例。
process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

try {
  const { readGateSource } = await import("../src/accept-gate-source.js");
  const repo = join(root, "repo");
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
  const stale = (path: string, content?: string) => {
    if (content !== undefined) writeFileSync(join(repo, path), content);
    utimesSync(join(repo, path), past, past);
  };
  const quiet = async (label: string, check: () => Promise<unknown>) => {
    rmSync(marker, { force: true });
    await check();
    assert.equal(existsSync(marker), false, `${label}：不许调起项目程序`);
  };

  // ① 原样重写 + 改时间戳：stat 全失效，git 要逐个比内容。不执行程序，也不把靠过滤器的文件误报成改了；
  // 换行转换（core.autocrlf）照项目配置算，工作区里的 CRLF 不算改动；只被 info/exclude 忽略的文件不算未跟踪。
  stale("asset.dat", "hello\n");
  stale("raw.bin", "raw\n");
  stale("plain.txt");
  stale("crlf.txt");
  writeFileSync(join(repo, "local.log"), "local\n");
  await quiet("原样重写", async () => assert.ok((await readGateSource(repo)).commit));

  // ② 靠过滤器的文件真改了（字节数和 git 核过的那份不同）：照样拦。
  stale("asset.dat", "hello world\n");
  await quiet("过滤文件改大小", () => assert.rejects(readGateSource(repo), /未提交/));
  stale("asset.dat", "hello\n");

  // ③ 不靠过滤器的文件按原口径严格比内容：同样大小的改写照样拦。
  stale("plain.txt", "PLAIN\n");
  await quiet("普通文件同大小改写", () => assert.rejects(readGateSource(repo), /未提交/));
  stale("plain.txt", "plain\n");

  // ④ 暂存区对提交有改动（只比对象名）：靠过滤器的文件也照样拦。
  const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--no-filters", "--stdin"], { input: "OTHER\n", encoding: "utf8" }).trim();
  git(repo, "update-index", "--cacheinfo", `100644,${blob},asset.dat`);
  await quiet("暂存改动", () => assert.rejects(readGateSource(repo), /未提交/));
  // 换回提交里那份之后，这一项在索引里没有 stat 记录（大小记成 0，git 自己也当「没核过」）：判不了就不误报。
  git(repo, "update-index", "--cacheinfo", `100644,${git(repo, "rev-parse", "HEAD:asset.dat")},asset.dat`);
  await quiet("索引无记录", async () => assert.ok((await readGateSource(repo)).commit));

  // ⑤ 没被忽略的未跟踪文件照样拦。
  writeFileSync(join(repo, "stray.txt"), "stray\n");
  await quiet("未跟踪文件", () => assert.rejects(readGateSource(repo), /未跟踪/));
  rmSync(join(repo, "stray.txt"));
  await quiet("复原", async () => assert.ok((await readGateSource(repo)).commit));

  // ⑥ 只是打开验收台（已有一次门禁记录、要算新鲜度）与批量预判：同样不调起过滤器。
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
    assert.equal(state.sourceError ?? null, null);
    assert.equal(state.latest?.status, "passed");
  });
  const [task] = await db.select().from(tasks);
  const [project] = await db.select().from(projects);
  await quiet("批量预判", () => acceptGateWouldRun(task!, project!));
  console.log("accept-gate-status: 源码身份比对不调起 clean/process 过滤器；过滤文件原样重写不误报、改了照拦；换行/排除照项目配置；验收台与预判同样不执行程序");
} finally {
  rmSync(root, { recursive: true, force: true });
}
