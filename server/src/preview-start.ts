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
import { missingDepsHint, missingNodeBin, pickPreviewUrl, portConflict, portHint, declaredHostApiPort } from "./preview-log.js";
import { canConnect, ready } from "./preview-probe.js";
import { freePorts, PORT_POOL, portEnv } from "./preview-ports.js";
import { boundListeningPort, currentListeningPort } from "./listening-port.js";
import { canceledGens } from "./preview-start-state.js";
import { alive, archivePreview, logFollower, patchStart, prunePreviewArtifacts, readAnyPreview, recordPath, tail, writeRecord, type PreviewStep, type PreviewResult, type PreviewServiceRecord } from "./preview-store.js";
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
  // 这台 ash 自己在哪。**只有 `boundListeningPort()` 算数**（确知绑上了才有值，不猜）：
  // 「只起前端」那一档的 `/api` 就是打回这里，而 `scripts/dev.mjs` 从前写死 4317 —— ash 一换
  // 端口，预览的 `/api` 就整个打到别处去（4317 上正坐着另一台 ash 的话，用户以为在验分支，
  // 实际在读写那一台；对方是单人模式还不用登录），而且它自述的端口跟我们绑着的对不上，
  // 登录态直连也就永远开不起来（第 5 轮审查 P1）。
  //
  // 单开一个变量、不复用通用的 `ASH_PROXY`：那个是留给人手动跑 `npm run dev` 的旋钮，
  // 项目脚本改得动；这个是 ash 对「我在哪」的陈述，必须由 ash 说了算。
  const hostApiUrl = boundListeningPort() === null ? null : `http://127.0.0.1:${boundListeningPort()}`;
  const envs = services.map((s, index) => {
    const env = portEnv([ports[index], ...ports.filter((_, i) => i !== index)].filter((p): p is number => !!p));
    if (selected?.length) ports.slice(0, configs.length).forEach((p, i) => {
      env[`PORT${i + 1}`] = String(p);
      env[`URL${i + 1}`] = `http://localhost:${p}`;
    });
    env.ASH_PREVIEW_BASE = proxyToken ? `/preview/${taskId}/${proxyToken}/${s.id}/` : "/";
    if (hostApiUrl) env.ASH_HOST_API = hostApiUrl;
    return env;
  });
  const banners = services.map((s, i) => `$ ${Object.entries(envs[i]).map(([k, v]) => `${k}=${v}`).join(" ")} BROWSER=none ASH_PREVIEW=1 ASH_PREVIEW_MODE=${step.p.mode} ${s.cmd}\n`);
  writeFileSync(log, configs.length > 1 ? `启动 ${configs.length} 个预览服务\n` : banners[0]);
  services.forEach((s, i) => { if (s.log !== log) writeFileSync(s.log, banners[i]); });
  writeRecord({
    taskId, cmd: step.p.cmd, pid: 0, url: null, port: null, life: step.p.life, startedAt: now(),
    log, links: [], state: "starting", gen, installPid: null, services, primaryServiceId: primaryId, proxyToken,
  });
  prunePreviewArtifacts(taskId, gen);
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
    // ash 自己绑的那个端口永远不是预览本尊（它就在上面跑着，别人绑不上）。日志里出现它
    // 只可能是命令在说「我的 /api 打到 ash 那边」——认了它，预览就指到 ash 自己身上。
    const self = currentListeningPort();
    // 启动期的两个一次性信号都顺着日志往下读，一个字节读一次（见 preview-store.ts 的
    // logFollower）。**不许用 `tail` 那 4000 字的尾巴**：这两句都打在启动最前面，装依赖回显和
    // 冷编译多打几行就把它们挤没了——一句被挤掉的自述让用户看回登录框（第 3 轮审查 P1），
    // 一句被挤掉的调度器警告让安全协议过旧的分支后端照常上线（第 4 轮审查 P1）。
    //
    // 「我的 /api 打到那台 ash 上」（判读见 preview-log.ts 的 declaredHostApiPort）记下来只为
    // 一件事：反代据此把 `/api` 那一跳接回本机 ash 并替用户带上会话。两道都不能少——说的端口
    // 得**正是我们此刻真绑着的那个**（`boundListeningPort` 确知才有值，不猜），而且这一趟
    // **只起了一个服务**：多服务里「谁在说」本来就分不清，而「前端 + 分支后端」那种组合的
    // `/api` 按定义就该是分支自己的。
    const bound = boundListeningPort();
    const follow = services.map((s, i) => logFollower(s.log, banners[i]));
    let hostApi: number | null = null;
    /** 收掉这个服务这一段新日志里的一次性信号；返回非 null = 这一趟必须当场收摊。 */
    const scanFresh = (i: number): string | null => {
      const fresh = follow[i]();
      if (!fresh) return null;
      if (fresh.includes("[ash] scheduler started")) {
        return "这个分支的预览后端启动了真调度器，安全协议过旧，已立即回收。请先同步新版预览隔离逻辑。";
      }
      if (services.length === 1 && hostApi === null && bound !== null && declaredHostApiPort(fresh) === bound) hostApi = bound;
      return null;
    };
    while (Date.now() < deadline) {
      await sleep(500);
      if (!ours()) return fail(CANCELED);
      for (const [i, s] of services.entries()) {
        const unsafe = scanFresh(i);
        if (unsafe) return fail(unsafe);
        const text = tail(s.log, banners[i]);
        if (errors.has(s.id) || !s.pid || !alive(s.pid)) {
          const deps = missingDepsHint(text, nodeDepsAdvice(cwd, s.cmd, missingNodeBin(text)), prepared.get(s.id) ?? []);
          return fail(`${s.name}：预览进程已退出。${errors.get(s.id) ?? ""}${deps ? `\n${deps}` : ""}\n最后几行日志：\n${text.slice(-800)}`);
        }
        if (s.status === "ready") continue;
        const lent = ports[i] ?? null;
        const found = pickPreviewUrl(text, lent, [...ports.filter((_, j) => i !== j), ...(self === null ? [] : [self])])
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
        // 上一次读日志到端口连通之间还有一道缝：那句自述可能刚好落在里面（更要紧的是调度器
        // 那句——落在缝里就等于让它带着真调度器上线）。上线前把两边都再收一次尾。
        for (const [i] of services.entries()) {
          const unsafe = scanFresh(i);
          if (unsafe) return fail(unsafe);
        }
        const primary = services.find((s) => s.id === primaryId)!;
        const record = patchStart(taskId, gen, { state: "ready", services, hostApi, pid: primary.pid, url: primary.url, port: primary.port, installPid: null, startedAt: now() });
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
