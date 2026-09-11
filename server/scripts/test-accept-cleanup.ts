import assert from "node:assert/strict";
import childProcess, { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { mock } from "node:test";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-accept-cleanup-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_DEPS_DIR = join(root, "deps");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { acceptTask } = await import("../src/task-accept.js");
const { cleanupAcceptedTask } = await import("../src/git-accept.js");
const { writeRecord, readAnyPreview, recordPath } = await import("../src/preview-store.js");
const { beginPreviewStart, endPreviewStart, previewStartCanceled, startPreview, stopPreview, stopPreviewOnRerun, sweepPreviews } = await import("../src/preview.js");
const { hasPendingPreviewStops, retryPreviewStops } = await import("../src/preview-process-stop.js");
const { previewState } = await import("../src/preview-public.js");
const { setTaskStatus } = await import("../src/status.js");
const { rerunGateClosed } = await import("../src/rerun-gate.js");
const { cancelDriving } = await import("../src/preview-start-state.js");
const { previewShell } = await import("../src/preview-shell.js");
const { inspectProcessSync, isPidAlive } = await import("../src/platform.js");
const { beginAccepting, endAccepting } = await import("../src/acceptance-lock.js");
const { restartTaskPreview } = await import("../src/workflow-steps.js");
const { killByPid } = await import("../src/executors/spawn.js");
await ensureSchema();
const children: ChildProcess[] = [];
const sidecarPids: number[] = [];
let sequence = 0;

async function setup() {
  const id = `cleanup-${++sequence}`;
  const repo = join(root, id);
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.name", "Cleanup Test");
  git(repo, "config", "user.email", "cleanup@example.test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  const at = new Date().toISOString();
  await db.insert(projects).values({ id, name: id, repoPath: repo, createdAt: at });
  const [task] = await createTasks([{
    id: `task-${id}`, projectId: id, title: id, body: "test", status: "done", mode: "single",
    useWorktree: true, worktreeBase: "main", workflowMode: "free", createdAt: at, updatedAt: at,
  }]);
  const workspace = await taskWorkspace(task, repo);
  writeFileSync(join(workspace.path, "feature.txt"), "committed feature\n");
  git(workspace.path, "add", ".");
  git(workspace.path, "commit", "-m", "feature");
  await db.insert(sessions).values({ id, taskId: task.id, role: "single", agentType: "codex", executor: "codex", startedAt: at, endedAt: at, exitCode: 0 });
  return { repo, task, ...workspace };
}

const timeline = (s: Awaited<ReturnType<typeof setup>>) => readFileSync(join(root, "runs", s.task.id, `${s.task.projectId}.md`), "utf8");
const accept = (id: string) => acceptTask(id, "human", { confirmUnverified: true });
const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(check(), "fixture did not become ready");
};

async function sidecar(s: Awaited<ReturnType<typeof setup>>) {
  const ready = join(root, `${s.task.id}-sidecar`);
  const code = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>{},100);`;
  const parent = spawn(process.execPath, ["-e", `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(code)}],{detached:true,stdio:'ignore'}); setInterval(()=>{},100);`],
    { cwd: s.path, detached: process.platform !== "win32", stdio: "ignore" });
  children.push(parent);
  await waitFor(() => existsSync(ready));
  const pid = Number(readFileSync(ready, "utf8"));
  sidecarPids.push(pid);
  return { parent, pid };
}

try {
  await (await import("./test-accept-finalize.js")).testAcceptanceFinalization(root);
  // 持续写入 ignored 缓存，并故意延迟退出；停止发生时工作区必须还在。
  for (const mode of ["task", "manual", "closed", "closing", "dirty"] as const) {
    const life = mode === "task" ? "task" : "manual";
    const s = await setup();
    const stopped = join(root, `${s.task.id}-stopped`);
    const ready = join(root, `${s.task.id}-ready`);
    const source = `
      const fs = require('fs'), path = require('path');
      const cwd = process.cwd();
      fs.mkdirSync('node_modules/.vite', { recursive: true });
      const timer = setInterval(() => {
        try { fs.mkdirSync('node_modules/.vite', { recursive: true }); fs.writeFileSync('node_modules/.vite/cache.json', '{}'); } catch {}
      }, 5);
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(stopped)}, String(fs.existsSync(path.join(cwd, '.git'))));
        setTimeout(() => { clearInterval(timer); process.exit(0); }, 3000);
      });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    `;
    const child = spawn(process.execPath, ["-e", source], { cwd: s.path, detached: process.platform !== "win32", stdio: "ignore" });
    children.push(child);
    await waitFor(() => existsSync(ready));
    mkdirSync(join(root, "runs", s.task.id), { recursive: true });
    writeRecord({ taskId: s.task.id, pid: child.pid!, cmd: "fixture writer", life, log: "", startedAt: new Date().toISOString(), port: null, url: null, state: "ready" });
    if (mode === "closed") {
      await stopPreview(s.task.id, "用户关闭预览");
      assert.equal(isPidAlive(child.pid!), false, "关闭返回时进程仍在退出，验收将失去等待线索");
    }
    const closing = mode === "closing" ? stopPreview(s.task.id, "用户关闭预览") : undefined;
    if (mode === "dirty") writeFileSync(join(s.path, "feature.txt"), "uncommitted changes");
    const result = await accept(s.task.id);
    await closing;
    if (mode === "dirty") {
      assert.equal(result.accepted, false);
      if (result.accepted) throw new Error("dirty workspace unexpectedly accepted");
      assert.match(result.error, /预览已在清理前关闭.*可重新启动/);
      assert.match(timeline(s), /预览已在清理前关闭.*可重新启动/);
      assert.equal(isPidAlive(child.pid!), false);
      assert.equal(readFileSync(join(s.path, "feature.txt"), "utf8"), "uncommitted changes");
      console.log("✓ failed cleanup preserves dirty files and explains how to restart the stopped preview");
      continue;
    }
    assert.equal(result.accepted, true, JSON.stringify(result));
    assert.ok(child.exitCode !== null || child.signalCode !== null, "验收返回前进程应确实退出");
    if (process.platform !== "win32") assert.equal(readFileSync(stopped, "utf8"), "true", "停止信号必须先于工作区删除");
    assert.equal(existsSync(s.path), false);
    assert.equal(readAnyPreview(s.task.id), null);
    assert.equal(git(s.repo, "show", "main:feature.txt"), "committed feature");
    assert.equal(existsSync(join(s.repo, ".git", "ash-worktree-backups")), false, "正常停止不能依靠半删除备份掩盖竞态");
    console.log(`✓ ${mode} preview stops before workspace deletion; late cache writes cannot recreate the directory`);
  }

  {
    const s = await setup();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { detached: process.platform !== "win32", stdio: "ignore" });
    children.push(child);
    mkdirSync(join(root, "runs", s.task.id), { recursive: true });
    const pending = join(root, "runs", s.task.id, "preview-stop-00000000-0000-0000-0000-000000000000.json");
    writeFileSync(pending, JSON.stringify([{ pid: child.pid!, startedAt: "previous process start time" }]));
    assert.equal((await retryPreviewStops(s.task.id)).stopped, true);
    assert.equal(isPidAlive(child.pid!), true, "复用 PID 的新进程不属于已关闭的预览，不能误杀");
    assert.equal(existsSync(pending), false);
    writeFileSync(pending, JSON.stringify([{ pid: child.pid!, startedAt: null, observedAt: Date.now() - 60_000 }]));
    assert.equal((await retryPreviewStops(s.task.id)).stopped, true);
    assert.equal(isPidAlive(child.pid!), true, "观测后新生的进程也应按复用 PID 放过");
    console.log("✓ persisted stop evidence discards a reused PID without signaling its new process");
  }

  {
    const s = await setup();
    const innocent = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { detached: process.platform !== "win32", stdio: "ignore" });
    const target = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { detached: process.platform !== "win32", stdio: "ignore" });
    children.push(innocent, target);
    const startedAt = inspectProcessSync(target.pid!)?.startedAt;
    assert.ok(startedAt, "fixture must have a verifiable process identity");
    const dir = join(root, "runs", s.task.id);
    mkdirSync(dir, { recursive: true });
    const invalid = { pid: innocent.pid!, startedAt: null };
    const records = [
      '[{"pid":', "", "{}", JSON.stringify([invalid]),
      JSON.stringify([{ pid: process.pid, startedAt }]),
      JSON.stringify([invalid, { pid: target.pid!, startedAt }]),
    ];
    records.forEach((body, index) => writeFileSync(join(dir, `preview-stop-${index}.json`), body));
    assert.equal((await retryPreviewStops(s.task.id)).stopped, true);
    assert.equal(hasPendingPreviewStops(s.task.id), false);
    assert.equal(isPidAlive(innocent.pid!), true, "缺少身份的 PID 不应收到停止信号");
    assert.equal(isPidAlive(target.pid!), false, "坏记录不能阻断整批，混合记录中的有效进程仍须退出");
    const before = timeline(s);
    assert.match(before, /内容损坏/);
    assert.match(before, /记录格式无效/);
    assert.match(before, /缺少有效进程身份或指向 ash 自身/);
    assert.match(before, /未向这些条目对应的 PID 发送停止信号/);
    assert.equal((await retryPreviewStops(s.task.id)).stopped, true);
    assert.equal(timeline(s), before, "失效记录只交代一次，不会无限重试或刷屏");
    assert.equal((await accept(s.task.id)).accepted, true, "历史坏记录不能永久拦住验收");
    console.log("✓ corrupt, unidentified and self-referencing stop records clear safely without skipping valid targets or blocking acceptance");
  }

  {
    const s = await setup();
    await db.delete(sessions).where(eq(sessions.taskId, s.task.id));
    const dir = join(root, "runs", s.task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "preview-stop-0.json"), "[");
    assert.equal((await retryPreviewStops(s.task.id)).stopped, true);
    assert.match(readFileSync(join(dir, "preview.log"), "utf8"), /内容损坏.*未向这些条目对应的 PID 发送停止信号/);
    assert.equal(previewState(s.task.id).hasLog, true, "无会话任务也能从预览日志看到失效记录的处理说明");
    console.log("✓ discarded legacy evidence leaves a visible preview log when no session timeline exists");
  }

  for (const location of ["file", "directory"] as const) {
    const s = await setup();
    const dir = join(root, "runs", s.task.id);
    mkdirSync(dir, { recursive: true });
    const pending = join(dir, "preview-stop-0.json");
    writeFileSync(pending, "[]");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { detached: process.platform !== "win32", stdio: "ignore" });
    children.push(child);
    const startedAt = inspectProcessSync(child.pid!)?.startedAt;
    assert.ok(startedAt);
    writeFileSync(join(dir, "preview-stop-1.json"), JSON.stringify([{ pid: child.pid!, startedAt }]));
    const blockedPath = location === "file" ? pending : dir;
    const method = location === "file" ? "readFileSync" : "readdirSync";
    const original = fs[method];
    const blocked = process.platform === "win32" ? mock.method(fs, method, (...args: any[]) => {
      if (args[0] === blockedPath) throw Object.assign(new Error("fixture read denied"), { code: "EACCES" });
      return (original as (...args: any[]) => any)(...args);
    }) : null;
    if (!blocked) chmodSync(blockedPath, 0);
    syncBuiltinESMExports();
    try {
      const result = await retryPreviewStops(s.task.id);
      assert.equal(result.stopped, false);
      if (result.stopped) throw new Error("unreadable stop evidence ignored");
      assert.match(result.message, /停止记录暂时无法读写.*EACCES/);
      assert.equal(isPidAlive(child.pid!), location === "directory", "单份记录不可读时其余有效目标仍应停止，目录不可读则保留线索");
      assert.equal(hasPendingPreviewStops(s.task.id), true);
      await setTaskStatus(s.task.id, "running");
      assert.equal((await db.select().from(tasks).where(eq(tasks.id, s.task.id)))[0].status, "running");
      assert.equal(rerunGateClosed(s.task.id), false);
      await setTaskStatus(s.task.id, "done");
      const denied = await accept(s.task.id);
      assert.equal(denied.accepted, false);
      if (denied.accepted) throw new Error("unreadable stop evidence accepted");
      assert.equal(denied.reason, "preview_cleanup_pending");
      assert.match(denied.error, /停止记录暂时无法读写.*目录权限或磁盘状态/);
      assert.doesNotMatch(denied.error, /进程尚未完全退出|permission denied, (open|scandir)/);
      assert.ok(existsSync(s.path));
    } finally {
      if (blocked) blocked.mock.restore();
      else chmodSync(blockedPath, location === "file" ? 0o600 : 0o700);
      syncBuiltinESMExports();
    }
    assert.equal((await accept(s.task.id)).accepted, true);
    console.log(`✓ unreadable stop ${location} preserves acceptance evidence without failing rerun; restored access resumes cleanup`);
  }

  {
    const s = await setup();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { detached: process.platform !== "win32", stdio: "ignore" });
    children.push(child);
    await waitFor(() => isPidAlive(child.pid!));
    mkdirSync(join(root, "runs", s.task.id), { recursive: true });
    writeRecord({ taskId: s.task.id, pid: child.pid!, cmd: "unidentified live preview", life: "manual", log: "", startedAt: new Date().toISOString(), port: null, url: null });
    let hideIdentity = true;
    let denyKill = true;
    const inspecting = (file: string, args: string[]) => file === "ps" || (/^(pwsh|powershell)\.exe$/i.test(file) && args.includes("-EncodedCommand"));
    const originalExec = childProcess.execFile;
    const originalSync = childProcess.execFileSync;
    const originalKill = process.kill.bind(process);
    const probes = [
      mock.method(childProcess, "execFileSync", (file: string, args: string[], ...rest: any[]) => {
        if (hideIdentity && inspecting(file, args)) throw new Error("fixture identity lookup unavailable");
        return (originalSync as (...args: any[]) => any)(file, args, ...rest);
      }),
      mock.method(childProcess, "execFile", (file: string, args: string[], ...rest: any[]) => {
        if ((hideIdentity && inspecting(file, args)) || (denyKill && file === "taskkill" && args.includes(String(child.pid)))) {
          queueMicrotask(() => rest.at(-1)(new Error("fixture process operation denied"), "", ""));
          return undefined as unknown as ChildProcess;
        }
        return (originalExec as (...args: any[]) => any)(file, args, ...rest);
      }),
      mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
        if (denyKill && Math.abs(pid) === child.pid && (signal === "SIGTERM" || signal === "SIGKILL")) throw Object.assign(new Error("fixture stop denied"), { code: "EPERM" });
        return originalKill(pid, signal);
      }),
    ];
    syncBuiltinESMExports();
    try {
      assert.equal(await stopPreview(s.task.id, "关闭身份暂时不可查的预览"), false);
      assert.equal(readAnyPreview(s.task.id), null);
      const fresh = await import(`../src/preview-process-stop.js?identity-restart=${Date.now()}`);
      const result = await fresh.retryPreviewStops(s.task.id);
      assert.equal(result.stopped, false, "模块重载后仍不能丢弃新捕获的无身份活进程");
      const denied = await accept(s.task.id);
      assert.equal(denied.accepted, false);
      if (denied.accepted) throw new Error("unidentified live preview accepted");
      assert.match(denied.error, /进程仍存活.*无法确认启动身份/);
      assert.equal(isPidAlive(child.pid!), true);
      assert.ok(existsSync(s.path));
      hideIdentity = false;
      denyKill = false;
      assert.equal((await accept(s.task.id)).accepted, true, "身份查询恢复后能识别原进程并完成停止和验收");
      assert.equal(isPidAlive(child.pid!), false);
      assert.equal(hasPendingPreviewStops(s.task.id), false);
    } finally {
      for (const probe of probes) probe.mock.restore();
      syncBuiltinESMExports();
      killByPid(child.pid!);
    }
    console.log("✓ newly captured live processes survive identity-query failure and module reload as pending evidence, then stop safely after recovery");
  }

  {
    const broken = await setup();
    const healthy = await setup();
    writeFileSync(join(root, "runs", ".DS_Store"), "ordinary Finder file");
    assert.equal(hasPendingPreviewStops(".DS_Store"), false);
    for (const s of [broken, healthy]) {
      mkdirSync(join(root, "runs", s.task.id), { recursive: true });
      writeRecord({ taskId: s.task.id, gen: "interrupted", pid: 0, cmd: "interrupted preview", life: "manual", log: "", startedAt: new Date().toISOString(), port: null, url: null, state: "starting" });
    }
    const obstruction = join(root, "runs", broken.task.id, "preview-last.json");
    mkdirSync(obstruction);
    const expired = join(root, "deps", "expired-cache");
    mkdirSync(expired, { recursive: true });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    utimesSync(expired, old, old);
    await sweepPreviews();
    assert.ok(readAnyPreview(broken.task.id), "归档失败的预览保留给后续重试");
    assert.match(timeline(broken), /预览清理暂缓/);
    assert.equal(readAnyPreview(healthy.task.id), null, "一个任务归档失败不能阻断其他任务的清扫");
    assert.ok(existsSync(join(root, "runs", healthy.task.id, "preview-last.json")));
    assert.equal(existsSync(expired), false, "普通文件和单任务异常不能阻断缓存清理");
    await setTaskStatus(broken.task.id, "running");
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, broken.task.id)))[0].status, "running", "归档抛异常也不能让任务重跑失败");
    assert.equal(rerunGateClosed(broken.task.id), false);
    assert.match(timeline(broken), /旧预览回收暂缓，任务继续运行/);
    rmSync(obstruction, { recursive: true });
    assert.equal(await stopPreview(broken.task.id, null), true);
    console.log("✓ sweep tolerates ordinary run-directory files and isolates task failures while still pruning expired caches");
  }

  for (const action of ["rerun", "close", "accept"] as const) {
    const s = await setup();
    const child = await sidecar(s);
    mkdirSync(join(root, "runs", s.task.id), { recursive: true });
    writeRecord({ taskId: s.task.id, pid: child.parent.pid!, cmd: "detached sidecar", life: "manual", log: "", startedAt: new Date().toISOString(), port: null, url: null });
    try {
      if (action === "rerun") {
        await setTaskStatus(s.task.id, "running");
        assert.equal((await db.select().from(tasks).where(eq(tasks.id, s.task.id)))[0].status, "running");
      } else if (action === "close") assert.equal(await stopPreview(s.task.id, "用户关闭预览"), true);
      else assert.equal((await accept(s.task.id)).accepted, true);
      assert.equal(isPidAlive(child.pid), false, "脱离父进程组的后代也应收到停止信号");
      assert.equal(readAnyPreview(s.task.id), null);
      assert.equal(hasPendingPreviewStops(s.task.id), false);
    } finally { killByPid(child.pid); killByPid(child.parent.pid!); }
    console.log(`✓ ${action} also terminates descendants that created their own process group`);
  }

  if (process.platform !== "win32") {
    const s = await setup();
    const child = await sidecar(s);
    const cache = join(root, "stop-cache");
    mkdirSync(cache);
    const link = join(s.path, "node_modules");
    symlinkSync(cache, link, "dir");
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    children.push(dead);
    await once(dead, "exit");
    mkdirSync(join(root, "runs", s.task.id), { recursive: true });
    writeRecord({ taskId: s.task.id, pid: child.parent.pid!, installPid: dead.pid!, cmd: "blocked sidecar", life: "manual", log: "", startedAt: new Date().toISOString(), port: null, url: null, links: [link] });
    const originalKill = process.kill.bind(process);
    const blocked = mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === child.pid && (signal === "SIGTERM" || signal === "SIGKILL")) throw Object.assign(new Error("fixture permission denied"), { code: "EPERM" });
      return originalKill(pid, signal);
    });
    try {
      assert.equal(await stopPreview(s.task.id, "用户关闭预览"), false);
      assert.equal(readAnyPreview(s.task.id), null);
      assert.equal(existsSync(link), false);
      assert.equal(previewState(s.task.id).running, false);
      assert.equal(hasPendingPreviewStops(s.task.id), true);
      assert.equal(isPidAlive(child.parent.pid!), false);
      assert.equal(isPidAlive(child.pid), true, "fixture must retain the reparented process");
      const dir = join(root, "runs", s.task.id);
      const saved = readdirSync(dir).filter(name => /^preview-stop-.*\.json$/.test(name))
        .flatMap(name => JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid: number }[]);
      assert.ok(saved.some(target => target.pid === child.pid));
      assert.ok(saved.every(target => target.pid !== dead.pid), "快照中已死亡的 root 不应变成无身份停止记录");
      const newer = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { detached: true, stdio: "ignore" });
      children.push(newer);
      writeRecord({ taskId: s.task.id, gen: "newer", pid: newer.pid!, cmd: "newer preview", life: "manual", log: "", startedAt: new Date().toISOString(), port: null, url: null });
      assert.equal(await stopPreview(s.task.id, "关闭新预览"), false, "旧的残留未退出时，不能仅凭当前代已退出就谎报全部回收");
      assert.equal(isPidAlive(newer.pid!), false);
      assert.doesNotMatch(timeline(s), /预览已回收/);
      const beforeRerun = timeline(s);
      await stopPreviewOnRerun(s.task.id);
      await stopPreviewOnRerun(s.task.id);
      assert.equal(timeline(s), beforeRerun, "没有新预览时重跑不应重复追加同一条未退出警告");
      const gen = beginPreviewStart(s.task.id);
      try {
        assert.equal(await stopPreview(s.task.id, "取消尚未落盘的新启动"), false, "取消新启动时旧进程仍存活，不能返回已全部停止");
        assert.equal(previewStartCanceled(gen), true);
        assert.match(timeline(s), /预览启动已取消.*仍有进程未退出/);
      } finally { endPreviewStart(s.task.id, gen); }
      await setTaskStatus(s.task.id, "running");
      assert.equal((await db.select().from(tasks).where(eq(tasks.id, s.task.id)))[0].status, "running");
      assert.doesNotMatch(timeline(s), /重试验收/);
      await setTaskStatus(s.task.id, "done");
      const denied = await accept(s.task.id);
      assert.equal(denied.accepted, false);
      if (denied.accepted) throw new Error("pending stop accepted");
      assert.equal(denied.reason, "preview_cleanup_pending");
      assert.ok(existsSync(s.path));
      const before = timeline(s);
      await sweepPreviews();
      assert.equal(timeline(s), before, "清扫不重复刷未退出进程的警告");
      const fresh = await import(`../src/preview-process-stop.js?restart=${Date.now()}`);
      assert.equal(fresh.hasPendingPreviewStops(s.task.id), true, "残留线索独立落盘，模块重载后仍存在");
    } finally { blocked.mock.restore(); }
    assert.equal((await accept(s.task.id)).accepted, true);
    assert.equal(isPidAlive(child.pid), false);
    assert.equal(hasPendingPreviewStops(s.task.id), false);
    console.log("✓ stop timeout preserves durable process evidence without failing rerun, showing a running preview, or spamming sweeps; acceptance remains strict");
  }

  if (process.platform !== "win32") for (const action of ["close", "accept"] as const) {
    const s = await setup();
    const ready = join(root, `${s.task.id}-replacement-ready`);
    const stopping = join(root, `${s.task.id}-replacement-stopping`);
    const child = spawn(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(ready)}, ''); process.on('SIGTERM',()=>require('fs').writeFileSync(${JSON.stringify(stopping)}, '')); setInterval(()=>{},100);`],
      { cwd: s.path, detached: process.platform !== "win32", stdio: "ignore" });
    children.push(child);
    await waitFor(() => existsSync(ready));
    mkdirSync(join(root, "runs", s.task.id), { recursive: true });
    const record = { taskId: s.task.id, gen: "old", pid: child.pid!, cmd: "old preview", life: "manual" as const, log: "", startedAt: new Date().toISOString(), port: null, url: null };
    writeRecord(record);
    const result = action === "close" ? stopPreview(s.task.id, "关闭旧预览") : accept(s.task.id);
    await waitFor(() => existsSync(stopping));
    writeRecord({ ...record, gen: "replacement", pid: 0 });
    const done = await result;
    if (typeof done === "boolean") assert.equal(done, false);
    else {
      assert.equal(done.accepted, false);
      if (done.accepted) throw new Error("replacement preview accepted");
      assert.equal(done.reason, "preview_cleanup_pending");
      assert.ok(existsSync(s.path));
    }
    assert.equal(readAnyPreview(s.task.id)?.gen, "replacement");
    const log = existsSync(join(root, "runs", s.task.id, `${s.task.projectId}.md`)) ? timeline(s) : "";
    assert.doesNotMatch(log, /预览已回收/);
    await stopPreview(s.task.id, null);
    console.log(`✓ ${action} retains a replacement generation and does not report the old request as successful`);
  }

  for (const denyStop of process.platform === "win32" ? [false] : [false, true]) {
    const s = await setup();
    const ready = join(root, `${s.task.id}-canceled-ready`);
    const script = join(root, "canceled-preview.cjs");
    writeFileSync(script, `
      const fs = require('fs');
      process.on('SIGTERM', () => {});
      setInterval(() => {
        try { fs.mkdirSync('node_modules/.vite', { recursive: true }); fs.writeFileSync('node_modules/.vite/cache.json', '{}'); } catch {}
      }, 5);
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    `);
    const command = `${previewShell().quote(process.execPath)} ${previewShell().quote(script)}`;
    const pending = startPreview(s.task.id, { id: "preview", kind: "preview", p: { cmd: command, mode: "frontend", life: "manual", ready: "port" } }, s.path);
    await waitFor(() => existsSync(ready));
    const record = readAnyPreview(s.task.id)!;
    const pid = Number(readFileSync(ready, "utf8"));
    const originalKill = process.kill.bind(process);
    const blocked = denyStop ? mock.method(process, "kill", (target: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(target) === pid && (signal === "SIGTERM" || signal === "SIGKILL")) throw Object.assign(new Error("fixture permission denied"), { code: "EPERM" });
      return originalKill(target, signal);
    }) : null;
    try {
      cancelDriving(s.task.id, null);
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(readAnyPreview(s.task.id), null);
      assert.equal(previewState(s.task.id).starting, false);
      assert.equal(previewState(s.task.id).running, false);
      if (denyStop) {
        if (result.ok) throw new Error("canceled preview unexpectedly started");
        assert.match(result.reason, /仍有进程未退出/);
        assert.doesNotMatch(result.reason, /重试验收/);
        assert.equal(hasPendingPreviewStops(s.task.id), true);
        blocked!.mock.restore();
      } else assert.equal(isPidAlive(pid), false, "启动已结束时取消的进程必须也已退出");
      assert.equal((await accept(s.task.id)).accepted, true);
      assert.equal(isPidAlive(pid), false);
      assert.equal(hasPendingPreviewStops(s.task.id), false);
      assert.equal(existsSync(s.path), false);
      assert.equal(existsSync(join(s.repo, ".git", "ash-worktree-backups")), false);
    } finally { blocked?.mock.restore(); killByPid(record.pid); killByPid(pid); }
    console.log(`✓ canceled startup ${denyStop ? "archives failed state and retains a timed-out stop" : "waits for TERM-resistant processes"} before acceptance cleanup`);
  }

  if (process.platform !== "win32") {
    const s = await setup();
    const ready = join(root, "orphan-ready");
    const childCode = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>{},100);`;
    const parent = spawn(process.execPath, ["-e", `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'}).unref()`], { cwd: s.path, detached: true, stdio: "ignore" });
    children.push(parent);
    const exited = once(parent, "exit");
    await waitFor(() => existsSync(ready));
    await exited;
    mkdirSync(join(root, "runs", s.task.id), { recursive: true });
    writeRecord({ taskId: s.task.id, pid: parent.pid!, cmd: "orphan fixture", life: "task", log: "", startedAt: new Date().toISOString(), port: null, url: null });
    try {
      const result = await accept(s.task.id);
      assert.equal(result.accepted, true, JSON.stringify(result));
      assert.throws(() => process.kill(-parent.pid!, 0), "忽略 TERM 的孤儿进程组必须退出后才能删目录");
      assert.equal(existsSync(s.path), false);
    } finally { killByPid(parent.pid!); }
    console.log("✓ dead preview leader does not bypass waiting for its TERM-resistant process group");
  }

  // 未落盘的启动正在等仓库锁时，取消后先让它退出，不能在锁内把目录删了。
  {
    const s = await setup();
    const gen = beginPreviewStart(s.task.id);
    const blocked = await accept(s.task.id);
    assert.equal(blocked.accepted, false);
    if (blocked.accepted) throw new Error("pending start unexpectedly accepted");
    assert.equal(blocked.reason, "preview_cleanup_pending");
    assert.ok(blocked.completedMerge);
    assert.equal(previewStartCanceled(gen), true);
    assert.ok(existsSync(join(s.path, ".git")));
    endPreviewStart(s.task.id, gen);
    assert.equal((await accept(s.task.id)).accepted, true);
    assert.equal(existsSync(s.path), false);
    assert.equal(beginAccepting(s.task.id), true);
    try { assert.deepEqual(await restartTaskPreview(s.task.id), { ok: false, code: "busy", reason: "任务正在验收，暂时不能重开预览" }); }
    finally { endAccepting(s.task.id); }
    console.log("✓ canceled starts retain the workspace until unwound; cleanup retries and concurrent preview gating work");
  }

  for (const mode of ["clean", "modified", "untracked", "foreign", "registered", "main-checkout", "other-checkout"] as const) {
    const s = await setup();
    git(s.repo, "merge", "--no-ff", "--no-edit", s.branch!);
    const main = git(s.repo, "rev-parse", "main");
    const pointer = readFileSync(join(s.path, ".git"), "utf8");
    const admin = pointer.trim().slice("gitdir: ".length);
    if (mode !== "registered") rmSync(admin, { recursive: true });
    if (mode === "main-checkout") {
      git(s.repo, "checkout", s.branch!);
      writeFileSync(join(s.repo, "feature.txt"), "main checkout edits");
    }
    if (mode === "other-checkout") git(s.repo, "worktree", "add", join(root, "other-checkout"), s.branch!);
    const index = readFileSync(join(s.repo, ".git", "index"));
    const head = git(s.repo, "rev-parse", "HEAD");
    const status = git(s.repo, "--no-optional-locks", "status", "--short");
    rmSync(join(s.path, "seed.txt"));
    mkdirSync(join(s.path, "node_modules", ".vite"), { recursive: true });
    writeFileSync(join(s.path, "node_modules", ".vite", "cache.json"), "preserved cache");
    if (mode === "modified") writeFileSync(join(s.path, "feature.txt"), "uncommitted work");
    if (mode === "untracked") writeFileSync(join(s.path, "WIP.txt"), "untracked work");
    if (mode === "foreign") {
      rmSync(join(s.path, ".git"));
      writeFileSync(join(s.path, ".git"), `gitdir: ${join(root, "other-repo", "worktrees", "entry")}\n`);
    }
    const result = await cleanupAcceptedTask(s.repo, s.task.id, "main");
    if (mode === "clean" || mode === "main-checkout") {
      if (mode === "clean") assert.equal(result.ok, true, JSON.stringify(result));
      else {
        assert.equal(result.ok, false);
        if (result.ok) throw new Error("checked-out branch unexpectedly deleted");
        assert.equal(result.reason, "branch_delete_failed", "主仓检出任务分支不应阻挡残骸备份，但该分支仍不能被删除");
        assert.equal(readFileSync(join(s.repo, "feature.txt"), "utf8"), "main checkout edits");
      }
      assert.ok(result.worktreeBackupPath);
      assert.equal(existsSync(s.path), false);
      assert.equal(readFileSync(join(result.worktreeBackupPath, "feature.txt"), "utf8"), "committed feature\n");
      assert.equal(readFileSync(join(result.worktreeBackupPath, "node_modules", ".vite", "cache.json"), "utf8"), "preserved cache");
      assert.equal(readFileSync(`${result.worktreeBackupPath}.git-pointer`, "utf8"), pointer);
      assert.equal(existsSync(join(result.worktreeBackupPath, ".git")), false);
      assert.equal((await cleanupAcceptedTask(s.repo, s.task.id, "main", { worktree: true, branch: false })).ok, true);
    } else {
      assert.equal(result.ok, false, `${mode} must be retained`);
      assert.ok(existsSync(s.path));
      assert.equal(result.worktreeBackupPath, undefined);
      if (mode === "modified") assert.equal(readFileSync(join(s.path, "feature.txt"), "utf8"), "uncommitted work");
      if (mode === "untracked") assert.equal(readFileSync(join(s.path, "WIP.txt"), "utf8"), "untracked work");
    }
    assert.equal(git(s.repo, "rev-parse", "main"), main);
    assert.equal(git(s.repo, "rev-parse", "HEAD"), head);
    assert.equal(git(s.repo, "--no-optional-locks", "status", "--short"), status);
    assert.deepEqual(readFileSync(join(s.repo, ".git", "index")), index, "恢复检查不能改主仓 index");
    console.log(`✓ dangling registration ${mode}: safe recovery and main checkout protection`);
  }
  {
    const s = await setup();
    git(s.repo, "merge", "--no-ff", "--no-edit", s.branch!);
    const admin = readFileSync(join(s.path, ".git"), "utf8").trim().slice("gitdir: ".length);
    rmSync(admin, { recursive: true });
    rmSync(join(s.path, "seed.txt"));
    assert.equal((await accept(s.task.id)).accepted, true);
    assert.match(timeline(s), /备份包含依赖缓存.*不会自动清理.*确认无误后可直接删除.*\.git-pointer/);
    console.log("✓ acceptance leaves persistent backup location, disk usage and manual deletion guidance");
  }
  assert.equal(existsSync(recordPath("not-a-task")), false);
  console.log("accept cleanup regression passed");
} finally {
  for (const pid of sidecarPids) killByPid(pid);
  await Promise.all(sidecarPids.map(pid => waitFor(() => !isPidAlive(pid))));
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    killByPid(child.pid!);
    await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 4000))]);
  }
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
