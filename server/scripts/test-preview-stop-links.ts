import assert from "node:assert/strict";
import childProcess, { spawn, type ChildProcess } from "node:child_process";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock } from "node:test";
import { db } from "../src/db/index.js";
import { projects, sessions } from "../src/db/schema.js";
import { createTasks } from "../src/task-store.js";
import { isPidAlive } from "../src/platform.js";
import { killByPid } from "../src/executors/spawn.js";
import { readAnyPreview, writeRecord } from "../src/preview-store.js";
import { hasPendingPreviewStops, retryPreviewStops, stopPreviewProcesses } from "../src/preview-process-stop.js";
import { stopPreview, sweepPreviews } from "../src/preview.js";

export async function testPreviewStopLinks(root: string): Promise<void> {
  for (const mode of ["replacement", "relinked", "unreadable"] as const) {
    const id = `stop-links-${mode}`;
    const workspace = join(root, id);
    const dir = join(root, "runs", id);
    const cache = join(root, "deps", id);
    const modules = join(cache, "node_modules");
    const link = join(workspace, "node_modules");
    for (const path of [workspace, dir, modules]) mkdirSync(path, { recursive: true });
    writeFileSync(join(modules, "fixture.txt"), "dependency");
    symlinkSync(modules, link, process.platform === "win32" ? "junction" : "dir");
    const at = new Date().toISOString();
    await db.insert(projects).values({ id, name: id, repoPath: workspace, createdAt: at });
    await createTasks([{ id, projectId: id, title: id, status: "done", mode: "single", useWorktree: false, createdAt: at, updatedAt: at }]);
    await db.insert(sessions).values({ id, taskId: id, role: "single", agentType: "codex", executor: "codex", startedAt: at, endedAt: at, exitCode: 0 });
    const children: ChildProcess[] = [];
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { detached: process.platform !== "win32", stdio: "ignore" });
    children.push(child);
    const record = { taskId: id, gen: "old", pid: child.pid!, cmd: "preview", life: "manual" as const, log: "", startedAt: at, port: null, url: null, links: [link] };
    writeRecord(record);
    const originalKill = process.kill.bind(process);
    const originalExec = childProcess.execFile;
    const originalRead = fs.readFileSync;
    let denyStop = true;
    let unreadable: string | undefined;
    const faults = [
      mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
        if (denyStop && Math.abs(pid) === child.pid && (signal === "SIGTERM" || signal === "SIGKILL")) throw Object.assign(new Error("fixture stop denied"), { code: "EPERM" });
        return originalKill(pid, signal);
      }),
      mock.method(childProcess, "execFile", (file: string, args: string[], ...rest: any[]) => {
        if (denyStop && file === "taskkill" && args.includes(String(child.pid))) {
          queueMicrotask(() => rest.at(-1)(new Error("fixture stop denied"), "", ""));
          return undefined as unknown as ChildProcess;
        }
        return (originalExec as (...args: any[]) => any)(file, args, ...rest);
      }),
      mock.method(fs, "readFileSync", (...args: any[]) => {
        if (unreadable && args[0] === unreadable) throw Object.assign(new Error("fixture stop record unreadable"), { code: "EACCES" });
        return (originalRead as (...args: any[]) => any)(...args);
      }),
    ];
    syncBuiltinESMExports();
    const expired = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    try {
      assert.equal(await stopPreview(id, null), false);
      assert.equal(readAnyPreview(id), null);
      assert.equal(readFileSync(join(link, "fixture.txt"), "utf8"), "dependency");
      if (mode === "replacement") {
        assert.equal((await stopPreviewProcesses(id, { ...record, pid: 0 })).stopped, false, "重叠回收不能用已退出的根进程覆盖另一份仍持有依赖的停止记录");
        assert.ok(existsSync(link));
        const newer = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { detached: process.platform !== "win32", stdio: "ignore" });
        children.push(newer);
        const url = "http://localhost:12345/";
        writeRecord({ ...record, gen: "new", pid: newer.pid!, url, links: [] });
        denyStop = false;
        assert.equal((await retryPreviewStops(id)).stopped, false);
        assert.equal(isPidAlive(child.pid!), false);
        assert.equal(isPidAlive(newer.pid!), true);
        utimesSync(cache, expired, expired);
        await sweepPreviews();
        assert.equal(readFileSync(join(link, "fixture.txt"), "utf8"), "dependency", "新一代复用旧软链时继续保管资源");
        assert.equal(readAnyPreview(id)?.gen, "new");
        assert.equal(await stopPreview(id, "用户关闭预览"), true, "当前代退出后重新核对历史依赖记录，本次关闭应直接成功");
        assert.equal(hasPendingPreviewStops(id), false, "关闭完成即释放已无人使用的历史资源，无需再点关闭或等清扫");
        assert.equal(readAnyPreview(id), null);
        const log = readFileSync(join(dir, `${id}.md`), "utf8");
        assert.ok(log.includes(`预览已回收（用户关闭预览）：${url}`), "成功时间线包含被关闭的预览地址");
        assert.doesNotMatch(log, /依赖仍被其他预览进程使用/);
        assert.equal(existsSync(link), false);
        assert.equal(isPidAlive(newer.pid!), false);
      } else {
        let replacement: string | undefined;
        if (mode === "relinked") {
          replacement = join(root, "deps", `${id}-new`, "node_modules");
          mkdirSync(replacement, { recursive: true });
          rmSync(link);
          symlinkSync(replacement, link, process.platform === "win32" ? "junction" : "dir");
        } else unreadable = join(dir, readdirSync(dir).find(name => /^preview-stop-.*\.json$/.test(name))!);
        utimesSync(cache, expired, expired);
        await sweepPreviews();
        assert.equal(existsSync(modules), true, "记录不可读或入口重挂时仍保留活进程所用的原缓存");
        assert.equal(isPidAlive(child.pid!), true);
        unreadable = undefined;
        denyStop = false;
        assert.equal((await retryPreviewStops(id)).stopped, true);
        if (replacement) assert.equal(realpathSync(link), realpathSync(replacement), "旧记录不得撤掉用户重挂的软链");
        else assert.equal(existsSync(link), false);
      }
      assert.equal(hasPendingPreviewStops(id), false);
      utimesSync(cache, expired, expired);
      await sweepPreviews();
      assert.equal(existsSync(cache), false);
      console.log(`✓ ${mode}: pending dependency ownership survives retries and releases only after its users exit`);
    } finally {
      faults.forEach(fault => fault.mock.restore());
      syncBuiltinESMExports();
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        killByPid(child.pid!);
        await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 4000))]);
      }
    }
  }
}
