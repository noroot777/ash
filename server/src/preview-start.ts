import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PreviewServiceConfig } from "@ash/shared/preview";
import { bus } from "./bus.js";
import { RUNS_DIR } from "./paths.js";
import { userShellLaunch } from "./platform.js";
import { augmentedEnv, killByPid, withoutForeignNodeBins } from "./executors/spawn.js";
import { prepareNodeDeps, removePreparedLinks, nodeDepsAdvice } from "./preview-deps.js";
import { missingDepsHint, missingNodeBin, pickPreviewUrl, portConflict, portHint } from "./preview-log.js";
import { canConnect, ready } from "./preview-probe.js";
import { freePorts, PORT_POOL, portEnv } from "./preview-ports.js";
import { canceledGens } from "./preview-start-state.js";
import { alive, archivePreview, patchStart, readAnyPreview, recordPath, tail, writeRecord, type PreviewStep, type PreviewResult, type PreviewServiceRecord } from "./preview-store.js";
import { previewShell } from "./preview-shell.js";
import { now } from "./util.js";
import { appendTaskTimeline } from "./task-timeline.js";

export interface PreviewStartOptions {
  services?: PreviewServiceConfig[];
  primaryServiceId?: string | null;
  proxy?: boolean;
}

const CANCELED = "预览启动被取消（关闭预览 / 任务重新开跑 / ash 重启）";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runPreview(
  taskId: string, step: PreviewStep, cwd: string, gen: string,
  options: PreviewStartOptions | undefined, stopOld: () => Promise<boolean>,
): Promise<PreviewResult> {
  await stopOld();
  const selected = options?.services?.filter((s) => s.enabled);
  const configs = selected?.length ? selected : [{ id: "main", name: "预览脚本", command: step.p.cmd, enabled: true, kind: "web" as const }];
  const primaryId = configs.find((s) => s.id === options?.primaryServiceId)?.id ?? configs.find((s) => s.kind === "web")?.id ?? configs[0].id;
  const ports = await freePorts(Math.max(PORT_POOL, configs.length));
  if (canceledGens.has(gen)) return { ok: false, reason: CANCELED };
  if (configs.length > 1 && ports.length < configs.length) return { ok: false, reason: "无法为所选服务分配足够的空闲端口" };
  const dir = join(RUNS_DIR, taskId);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "preview.log");
  const proxyToken = options?.proxy ? randomBytes(24).toString("hex") : undefined;
  const services: PreviewServiceRecord[] = configs.map((s) => ({
    id: s.id, name: s.name, cmd: s.command, status: "starting", pid: 0, url: null, port: null,
    log: configs.length === 1 ? log : join(dir, `preview-${gen}-${s.id}.log`),
  }));
  const envs = services.map((s, index) => {
    const env = portEnv([ports[index], ...ports.filter((_, i) => i !== index)].filter((p): p is number => !!p));
    if (selected?.length) ports.slice(0, configs.length).forEach((p, i) => {
      env[`PORT${i + 1}`] = String(p);
      env[`URL${i + 1}`] = `http://localhost:${p}`;
    });
    env.ASH_PREVIEW_BASE = proxyToken ? `/preview/${taskId}/${proxyToken}/${s.id}/` : "/";
    return env;
  });
  const banners = services.map((s, i) => `$ ${Object.entries(envs[i]).map(([k, v]) => `${k}=${v}`).join(" ")} BROWSER=none ASH_PREVIEW=1 ASH_PREVIEW_MODE=${step.p.mode} ${s.cmd}\n`);
  writeFileSync(log, configs.length > 1 ? `启动 ${configs.length} 个预览服务\n` : banners[0]);
  services.forEach((s, i) => { if (s.log !== log) writeFileSync(s.log, banners[i]); });
  writeRecord({
    taskId, cmd: step.p.cmd, pid: 0, url: null, port: null, life: step.p.life, startedAt: now(),
    log, links: [], state: "starting", gen, installPid: null, services, primaryServiceId: primaryId, proxyToken,
  });
  bus.publish({ type: "task.review", taskId });
  const links = new Set<string>();
  let installing = 0;
  const ours = () => !canceledGens.has(gen) && readAnyPreview(taskId)?.gen === gen;
  const patch = () => patchStart(taskId, gen, { services: [...services], links: [...links], pid: services.find((s) => s.id === primaryId)?.pid ?? 0 });
  const kill = () => {
    for (const s of services) if (s.pid > 0) killByPid(s.pid);
    if (installing > 0) killByPid(installing);
  };
  const fail = (reason: string): PreviewResult => {
    kill();
    const current = readAnyPreview(taskId);
    if (current?.gen === gen) {
      archivePreview({ ...current, services }, "failed");
      rmSync(recordPath(taskId), { force: true });
    }
    if (!current || current.gen === gen) removePreparedLinks([...links]);
    bus.publish({ type: "task.review", taskId });
    return { ok: false, reason };
  };
  const prepared = new Map<string, Awaited<ReturnType<typeof prepareNodeDeps>>>();
  const errors = new Map<string, string>();
  try {
    for (const s of services) {
      if (!ours()) return fail(CANCELED);
      const tried = await prepareNodeDeps(cwd, s.cmd, s.log, (pid) => {
        installing = pid;
        patchStart(taskId, gen, { installPid: pid > 0 ? pid : null });
      });
      tried.forEach((one) => { if (one.link) links.add(one.link); });
      prepared.set(s.id, tried);
      if (!ours()) return fail(CANCELED);
      patch();
    }
    for (const [i, s] of services.entries()) {
      if (!ours()) return fail(CANCELED);
      const launch = previewScriptLaunch(s.cmd, dir, `${gen}-${s.id}`);
      const fd = openSync(s.log, "a");
      try {
        const child = spawn(launch.file, launch.args, {
          cwd, detached: process.platform !== "win32", windowsHide: true,
          windowsVerbatimArguments: launch.windowsVerbatimArguments, stdio: ["ignore", fd, fd],
          env: { ...withoutForeignNodeBins(augmentedEnv(), cwd), ...envs[i], ASH_PREVIEW: "1", ASH_PREVIEW_MODE: step.p.mode, BROWSER: "none" },
        });
        child.on("error", (error) => errors.set(s.id, error.message));
        child.on("exit", () => {
          if (ours() && readAnyPreview(taskId)?.state === "ready") {
            fail(`${s.name}：预览进程已自行退出`);
            void appendTaskTimeline(taskId, `预览已回收：${s.name} 的进程已自行退出，其它服务一并关闭`).catch(() => {});
          }
        });
        child.unref();
        s.pid = child.pid ?? 0;
        patch();
      } finally { closeSync(fd); }
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(500);
      if (!ours()) return fail(CANCELED);
      for (const [i, s] of services.entries()) {
        const text = tail(s.log, banners[i]);
        if (text.includes("[ash] scheduler started")) return fail("这个分支的预览后端启动了真调度器，安全协议过旧，已立即回收。请先同步新版预览隔离逻辑。");
        if (errors.has(s.id) || !s.pid || !alive(s.pid)) {
          const deps = missingDepsHint(text, nodeDepsAdvice(cwd, s.cmd, missingNodeBin(text)), prepared.get(s.id) ?? []);
          return fail(`${s.name}：预览进程已退出。${errors.get(s.id) ?? ""}${deps ? `\n${deps}` : ""}\n最后几行日志：\n${text.slice(-800)}`);
        }
        if (s.status === "ready") continue;
        const lent = ports[i] ?? null;
        const found = pickPreviewUrl(text, lent, ports.filter((_, j) => i !== j))
          ?? (lent !== null && await canConnect(lent) ? { url: `http://localhost:${lent}/`, port: lent, lent: true } : null);
        if (!ours()) return fail(CANCELED);
        const conflict = found?.lent ? null : portConflict(text);
        if (conflict) return fail(`${s.name}：${conflict}。\n${portHint(lent)}\n${text.slice(-600)}`);
        if (!found || !(await ready(step.p.ready, found.url, found.port, text))) continue;
        if (!ours()) return fail(CANCELED);
        Object.assign(s, { status: "ready", url: found.url, port: found.port });
        patch();
        bus.publish({ type: "task.review", taskId });
      }
      if (services.every((s) => s.status === "ready")) {
        const primary = services.find((s) => s.id === primaryId)!;
        const record = patchStart(taskId, gen, { state: "ready", services, pid: primary.pid, url: primary.url, port: primary.port, installPid: null, startedAt: now() });
        if (!record || !ours()) return fail(CANCELED);
        return { ok: true, record };
      }
    }
    const waiting = services.filter((s) => s.status !== "ready");
    return fail(`等了 120 秒还没起来：${waiting.map((s) => s.name).join("、")}\n${waiting.map((s) => tail(s.log).slice(-800)).join("\n")}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function previewScriptLaunch(command: string, dir: string, key: string) {
  if (process.platform !== "win32" || !/[\r\n]/.test(command)) return userShellLaunch(command);
  const path = join(dir, `preview-${key}.cmd`);
  writeFileSync(path, `@echo off\r\n@chcp 65001 >nul\r\n${command.replace(/\r\n?|\n/g, "\r\n")}\r\n`);
  return userShellLaunch(`call ${previewShell().quote(path)}`);
}
