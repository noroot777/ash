import assert from "node:assert/strict";
import childProcess, { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeStep } from "@ash/shared/workflow";
import { db } from "../src/db/index.js";
import { freeWorkflowStates, projects, sessions, tasks } from "../src/db/schema.js";
import { createTasks } from "../src/task-store.js";
import { taskWorkspace } from "../src/task-workspace.js";
import { acceptTask, mountTaskAcceptanceRoutes } from "../src/task-accept.js";
import { readAnyPreview, writeRecord } from "../src/preview-store.js";
import { previewShell } from "../src/preview-shell.js";
import { isPidAlive } from "../src/platform.js";
import { killByPid } from "../src/executors/spawn.js";
import { hasPendingPreviewStops } from "../src/preview-process-stop.js";
import { sweepPreviews } from "../src/preview.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export async function testAcceptanceFinalization(root: string): Promise<void> {
  const api = new Hono();
  mountTaskAcceptanceRoutes(api);
  for (const mode of ["gate", "task", "archive", "in-place", "manual"] as const) {
    const id = `finalize-${mode}`;
    const repo = join(root, id);
    git(root, "init", "-b", "main", repo);
    git(repo, "config", "user.name", "Finalization Test");
    git(repo, "config", "user.email", "finalization@example.test");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "seed");
    const at = new Date().toISOString();
    await db.insert(projects).values({ id, name: id, repoPath: repo, createdAt: at });
    const [task] = await createTasks([{ id, projectId: id, title: id, status: "done", mode: "team",
      useWorktree: mode !== "in-place", worktreeBase: "main", workflowMode: "free", createdAt: at, updatedAt: at }]);
    const workspace = await taskWorkspace(task, repo);
    writeFileSync(join(workspace.path, "feature.txt"), "feature\n");
    git(workspace.path, "add", ".");
    git(workspace.path, "commit", "-m", "feature");
    await createTasks([{ id: `${id}-worker`, projectId: id, parentId: id, title: "shared worker",
      status: "done", mode: "single", useWorktree: false, workflowMode: "free", createdAt: at, updatedAt: at }]);
    await db.insert(sessions).values({ id, taskId: id, role: "lead", agentType: "codex", executor: "codex", startedAt: at, endedAt: at, exitCode: 0 });
    await db.insert(freeWorkflowStates).values({ taskId: id, reviewArmed: true, updatedAt: at });
    const counter = join(root, `${id}-tail-count`);
    const script = join(root, `${id}-tail.cjs`);
    writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(counter)}, '1');`);
    const accept = makeStep("accept", "accept");
    if (accept.kind === "accept") accept.p = { strategy: "safe", clean: "none" };
    const command = makeStep("command", "after-accept");
    if (command.kind === "command") command.p = { cmd: `${previewShell().quote(process.execPath)} ${previewShell().quote(script)}`, where: "workspace" };
    const workflow = { workspace: mode === "in-place" ? "shared" : "isolated", steps: [
      makeStep("run", "run"), makeStep("human", "g1"), makeStep("human", "g2"), accept,
      ...(mode === "manual" ? [] : [command]),
    ] };
    await db.update(tasks).set({ workflow: JSON.stringify(workflow), workflowAt: "g2" }).where(eq(tasks.id, id));
    const dir = join(root, "runs", id);
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, `${id}.md`);
    writeFileSync(transcript, "");
    const children: ChildProcess[] = [];
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { cwd: workspace.path, detached: process.platform !== "win32", stdio: "ignore" });
    children.push(child);
    const life = mode === "task" ? "task" : mode === "manual" ? "manual" : "gate";
    const record = { taskId: id, gen: "before-accept", pid: child.pid!, cmd: "preview fixture", life,
      log: "", startedAt: at, port: null, url: null } as const;
    writeRecord(record);
    const obstruction = join(dir, "preview-last.json");
    const originalWrite = fs.writeFileSync;
    const blocked = mode !== "archive" && process.platform === "win32" ? mock.method(fs, "writeFileSync", (...args: any[]) => {
      if (String(args[0]).startsWith(join(dir, "preview-stop-"))) throw Object.assign(new Error("fixture write denied"), { code: "EACCES" });
      return (originalWrite as (...args: any[]) => any)(...args);
    }) : null;
    if (mode === "archive") mkdirSync(obstruction);
    else if (!blocked) chmodSync(dir, 0o500);
    syncBuiltinESMExports();
    const restore = () => {
      if (blocked) blocked.mock.restore();
      else if (mode !== "archive") chmodSync(dir, 0o700);
      if (mode === "archive") rmSync(obstruction, { recursive: true, force: true });
      syncBuiltinESMExports();
    };
    try {
      const first = await acceptTask(id, "human", { confirmUnverified: true });
      const merged = git(repo, "rev-parse", "main");
      if (mode === "manual") {
        assert.equal(first.accepted, true, JSON.stringify(first));
        assert.equal(isPidAlive(child.pid!), true, "clean:none 仍保留由用户手动关闭的预览");
        console.log("✓ final acceptance preserves manual previews when the cleanup plan keeps the workspace");
        continue;
      }
      assert.equal(first.accepted, false);
      if (first.accepted) throw new Error("preview finalization failure accepted");
      assert.equal(first.reason, "preview_cleanup_pending");
      assert.match(first.error, /停止记录暂时无法读写.*验收收尾暂缓/);
      assert.doesNotMatch(first.error, /permission denied|preview-stop-.*\.tmp/);
      const pending = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
      assert.notEqual(pending.stage, "accepted", "回收失败不能提前落 accepted，导致重试永久跳过收尾");
      if (mode !== "in-place") {
        assert.equal(pending.stage, "merged");
        assert.deepEqual(first.completedMerge, { targetBranch: "main", commit: merged });
        assert.equal(git(repo, "show", "main:feature.txt"), "feature");
      }
      assert.equal(pending.acceptedTailPending, false);
      assert.equal(existsSync(counter), false);
      assert.equal((await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, id)))[0].reviewArmed, true);
      assert.notEqual((await db.select().from(tasks).where(eq(tasks.id, `${id}-worker`)))[0].stage, "accepted");
      assert.equal(isPidAlive(child.pid!), mode !== "archive");
      assert.ok(readAnyPreview(id));
      const http = await api.request(`/tasks/${id}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmUnverified: true }) });
      assert.equal(http.status, 409, "HTTP 入口返回结构化拒绝，不泄漏为 500");
      assert.equal((await http.json()).reason, "preview_cleanup_pending");
      restore();
      const fresh = await import(`../src/task-accept.js?finalize-restart=${id}`);
      const resumed = await fresh.acceptTask(id, "human", { confirmUnverified: true });
      assert.equal(resumed.accepted, true, JSON.stringify(resumed));
      if (!resumed.accepted) throw new Error(resumed.error);
      assert.notEqual(resumed.kind, "already_accepted");
      assert.equal(resumed.sharedWorkersAccepted, 1);
      assert.equal(resumed.tail?.ok, true);
      assert.equal(isPidAlive(child.pid!), false);
      assert.equal(readAnyPreview(id), null);
      assert.equal((await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, id)))[0].reviewArmed, false);
      assert.equal((await db.select().from(tasks).where(eq(tasks.id, `${id}-worker`)))[0].stage, "accepted");
      assert.match(readFileSync(transcript, "utf8"), /未消费的复审预约已一并取消/);
      assert.match(readFileSync(transcript, "utf8"), mode === "in-place" ? /验收通过/ : /验收完成/);
      assert.equal(readFileSync(counter, "utf8"), "1");
      assert.equal(git(repo, "rev-parse", "main"), merged, "补收尾不重复合并");
      const later = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { cwd: workspace.path, detached: process.platform !== "win32", stdio: "ignore" });
      children.push(later);
      writeRecord({ ...record, pid: later.pid!, gen: "after-accept", startedAt: new Date().toISOString() });
      const repeated = await acceptTask(id, "human", { confirmUnverified: true });
      assert.equal(repeated.accepted && repeated.kind, "already_accepted");
      assert.equal(isPidAlive(later.pid!), true, "重复验收不能误收验收之后新开的预览");
      assert.equal(readFileSync(counter, "utf8"), "1", "验收尾段不能重跑");
      console.log(`✓ ${mode} finalization failures stay retryable; recovery completes preview stop, reservation, shared workers and tail exactly once`);
    } finally {
      restore();
      for (const process of children) {
        if (process.exitCode !== null || process.signalCode !== null) continue;
        killByPid(process.pid!);
        await Promise.race([once(process, "exit"), new Promise(resolve => setTimeout(resolve, 4000))]);
      }
    }
  }
  await testPendingAcceptance(root);
}

async function testPendingAcceptance(root: string): Promise<void> {
  for (const mode of ["in-place", "marked-only", "keep", "keep-unreadable", "worktree", "all"] as const) {
    const id = `pending-finalize-${mode}`;
    const repo = join(root, id);
    git(root, "init", "-b", "main", repo);
    git(repo, "config", "user.name", "Pending Acceptance Test");
    git(repo, "config", "user.email", "pending@example.test");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "seed");
    const at = new Date().toISOString();
    await db.insert(projects).values({ id, name: id, repoPath: repo, createdAt: at });
    const [task] = await createTasks([{ id, projectId: id, title: id, status: "done", mode: "team",
      useWorktree: mode !== "in-place", worktreeBase: "main", workflowMode: "free", createdAt: at, updatedAt: at }]);
    const workspace = await taskWorkspace(task, repo);
    writeFileSync(join(workspace.path, "feature.txt"), "feature\n");
    git(workspace.path, "add", ".");
    git(workspace.path, "commit", "-m", "feature");
    await createTasks([{ id: `${id}-worker`, projectId: id, parentId: id, title: "shared worker", status: "done",
      mode: "single", useWorktree: false, workflowMode: "free", createdAt: at, updatedAt: at }]);
    await db.insert(sessions).values({ id, taskId: id, role: "lead", agentType: "codex", executor: "codex", startedAt: at, endedAt: at, exitCode: 0 });
    await db.insert(freeWorkflowStates).values({ taskId: id, reviewArmed: true, updatedAt: at });
    const removesWorktree = mode === "worktree" || mode === "all";
    const accept = makeStep("accept", "accept");
    if (accept.kind === "accept") accept.p = { strategy: "safe", clean: removesWorktree ? mode : "none" };
    const counter = join(root, `${id}-tail-count`);
    const script = join(root, `${id}-tail.cjs`);
    writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(counter)}, '1');`);
    const command = makeStep("command", "after-accept");
    if (command.kind === "command") command.p = { cmd: `${previewShell().quote(process.execPath)} ${previewShell().quote(script)}`, where: "repo" };
    await db.update(tasks).set({ workflowAt: "gate", workflow: JSON.stringify({ workspace: task.useWorktree ? "isolated" : "shared",
      steps: [makeStep("run", "run"), makeStep("human", "gate"), ...(mode === "marked-only" ? [] : [accept]), command] }),
    }).where(eq(tasks.id, id));
    const dir = join(root, "runs", id);
    mkdirSync(dir, { recursive: true });
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { cwd: workspace.path, detached: process.platform !== "win32", stdio: "ignore" });
    writeRecord({ taskId: id, gen: "pending", pid: child.pid!, cmd: "pending preview", life: "task", log: "", startedAt: at, port: null, url: null });
    const unreadable = join(dir, "preview-stop-0.json");
    if (mode === "keep-unreadable") writeFileSync(unreadable, "[]");
    let denyRead = mode === "keep-unreadable";
    const originalRead = fs.readFileSync;
    const originalKill = process.kill.bind(process);
    const originalExec = childProcess.execFile;
    const faults = [
      mock.method(fs, "readFileSync", (...args: any[]) => {
        if (denyRead && args[0] === unreadable) throw Object.assign(new Error("fixture unreadable stop record"), { code: "EACCES" });
        return (originalRead as (...args: any[]) => any)(...args);
      }),
      mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
        if (Math.abs(pid) === child.pid && (signal === "SIGTERM" || signal === "SIGKILL")) throw Object.assign(new Error("fixture stop denied"), { code: "EPERM" });
        return originalKill(pid, signal);
      }),
      mock.method(childProcess, "execFile", (file: string, args: string[], ...rest: any[]) => {
        if (file === "taskkill" && args.includes(String(child.pid))) {
          queueMicrotask(() => rest.at(-1)(new Error("fixture stop denied"), "", ""));
          return undefined as unknown as ChildProcess;
        }
        return (originalExec as (...args: any[]) => any)(file, args, ...rest);
      }),
    ];
    syncBuiltinESMExports();
    const restore = () => { faults.forEach(fault => fault.mock.restore()); syncBuiltinESMExports(); };
    const acceptNow = () => acceptTask(id, mode === "marked-only" ? "workflow" : "human", { confirmUnverified: true });
    try {
      let result = await acceptNow();
      if (mode === "keep-unreadable") {
        assert.equal(result.accepted, false, "进程未退出不能掩盖另一份记录的读写错误");
        if (result.accepted) throw new Error("unreadable evidence accepted");
        assert.match(result.error, /停止记录暂时无法读写.*EACCES/);
        denyRead = false;
        result = await acceptNow();
      }
      assert.equal(hasPendingPreviewStops(id), true);
      assert.equal(isPidAlive(child.pid!), true);
      assert.ok(existsSync(workspace.path));
      if (removesWorktree) {
        assert.equal(result.accepted, false, "删除工作区前仍需等进程退出");
        if (result.accepted) throw new Error("live process workspace deleted");
        assert.equal(result.reason, "preview_cleanup_pending");
        assert.notEqual((await db.select().from(tasks).where(eq(tasks.id, id)))[0].stage, "accepted");
        assert.equal(existsSync(counter), false);
        restore();
        assert.equal((await acceptNow()).accepted, true);
        assert.equal(existsSync(workspace.path), false);
      } else {
        assert.equal(result.accepted, true, JSON.stringify(result));
        if (!result.accepted) throw new Error(result.error);
        assert.equal(result.kind, mode === "in-place" ? "in_place" : mode === "marked-only" ? "marked_only" : "isolated_worktree");
        assert.equal(result.tail?.ok, true);
        assert.equal(result.sharedWorkersAccepted, 1);
        assert.equal(readAnyPreview(id), null);
        assert.equal((await db.select().from(tasks).where(eq(tasks.id, id)))[0].stage, "accepted");
        assert.equal((await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, id)))[0].reviewArmed, false);
        assert.equal((await db.select().from(tasks).where(eq(tasks.id, `${id}-worker`)))[0].stage, "accepted");
        const log = readFileSync(join(dir, `${id}.md`), "utf8");
        assert.match(log, /本次验收保留工作区，继续完成验收/);
        assert.match(log, /仍有进程未退出.*后台会继续检查/);
        const again = await acceptNow();
        assert.equal(again.accepted && again.kind, "already_accepted");
        assert.equal(hasPendingPreviewStops(id), true, "验收完成后后台重试证据仍然存在");
        restore();
        await sweepPreviews();
        assert.ok(existsSync(workspace.path));
      }
      assert.equal(readFileSync(counter, "utf8"), "1", "尾段完成且重复验收不重跑");
      assert.equal(isPidAlive(child.pid!), false);
      assert.equal(hasPendingPreviewStops(id), false);
      console.log(`✓ ${mode}: pending stops ${removesWorktree ? "block workspace deletion" : "allow acceptance and all finalization"}, then background/retry cleanup recovers`);
    } finally {
      restore();
      if (child.exitCode === null && child.signalCode === null) {
        killByPid(child.pid!);
        await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 4000))]);
      }
    }
  }
}
