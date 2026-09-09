import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreviewLife, WorkflowStep } from "@ash/shared/workflow";
import type { PreviewServiceState } from "@ash/shared/preview";
import { RUNS_DIR } from "./paths.js";

export type PreviewStep = Extract<WorkflowStep, { kind: "preview" }>;

export interface PreviewRecord {
  services?: PreviewServiceRecord[];
  proxyToken?: string;
  primaryServiceId?: string;
  taskId: string;
  cmd: string;
  /** 还没 spawn 的时候是 0 —— 杀之前一律先判 `> 0`（`kill(0, …)` 打的是自己这一组）。 */
  pid: number;
  url: string | null;
  port: number | null;
  life: PreviewLife;
  startedAt: string;
  log: string;
  /** 起这次预览时 ash 自己挂上去的 node_modules 软链；收预览时按原样撤掉。 */
  links?: string[];
  /**
   * 这条记录是「还在启动」还是「已经起来了」。缺省（老记录）= 已经起来了。
   *
   * **启动那一段也必须有一条落盘的记录**，这不是为了给界面看，是为了让它可被杀掉：
   * 依赖最多装 6 分钟、服务就绪再等 2 分钟，这八分钟里用户点「关闭预览」、或者任务
   * 续跑触发 stopPreviewOnRerun，都得能把这一趟摁死。记录只在就绪时才写的话，那两条
   * 路径读不到东西、什么也不杀，原来那趟稍后照常上线 —— 用户「关掉了」的预览自己
   * 回来了，续跑的那次更糟：他会对着上一版代码验新改动。server 在这八分钟里重启也
   * 一样，detached 的子进程和挂好的软链没有任何线索可循。
   */
  state?: "starting" | "ready";
  /**
   * 装依赖那个进程的 pid（只在装的时候有）。理由同 `state`：那一段能跑满六分钟，
   * 停止时得连它一起收，否则「已停止」只是嘴上说说，包管理器和项目的生命周期脚本
   * 还在后台跑。
   */
  installPid?: number | null;
  /**
   * 这一趟启动的代号。取消 = **把记录删掉或者换成别人的代号**，在跑的那一趟每到一个
   * 检查点就核对一次，对不上就自己收摊。用代号而不是布尔标记，是因为「取消」和「立刻
   * 起了新的一趟」在时间上分不开：只看「记录还在不在」，新那趟的记录会被旧那趟当成
   * 自己的，于是旧的照样把自己写成 ready，把新的顶掉。
   */
  gen?: string;
}


export interface PreviewServiceRecord extends Omit<PreviewServiceState, "command"> {
  cmd: string;
  pid: number;
  log: string;
}

export type PreviewResult = { ok: true; record: PreviewRecord } | { ok: false; reason: string };

export function recordPath(taskId: string): string {
  return join(RUNS_DIR, taskId, "preview.json");
}

/**
 * 盘上这个任务的预览记录，**不管它是在启动还是已经起来了**。
 *
 * 只有「要收拾它」的那几条路径该用这个（停止、续跑、清扫）。给界面看的一律用
 * readPreview —— 一条还在启动的记录没有 url、没有 pid，被当成「预览在跑」就会变成
 * 一句更早的谎。
 */
export function readAnyPreview(taskId: string): PreviewRecord | null {
  try {
    const raw = readFileSync(recordPath(taskId), "utf8");
    const value = JSON.parse(raw) as PreviewRecord;
    return typeof value?.pid === "number" ? value : null;
  } catch {
    return null;
  }
}

/** 已经起来了的那条记录（还在启动的不算）。 */
export function readPreview(taskId: string): PreviewRecord | null {
  const record = readAnyPreview(taskId);
  return record && record.state !== "starting" ? record : null;
}

export function writeRecord(record: PreviewRecord): void {
  writeFileSync(recordPath(record.taskId), JSON.stringify(record, null, 2));
}

export function prunePreviewArtifacts(taskId: string, keepGen: string): void {
  const dir = join(RUNS_DIR, taskId);
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const match = /^preview-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})-[A-Za-z0-9_-]{1,64}\.(?:log|cmd)$/.exec(entry.name);
      if (!entry.isFile() || !match || match[1] === keepGen) continue;
      try { rmSync(join(dir, entry.name), { force: true }); } catch { /* 被占用的文件留到下次启动再清理。 */ }
    }
  } catch { /* 任务目录被回收时无需继续清理。 */ }
}

/**
 * 更新「正在启动」那条记录，**前提是它还是我们这一趟的**。返回 null = 这一趟已经被取消
 * （或者被新的一趟顶掉了），调用方就该收摊，别再往盘上写。
 */
export function patchStart(taskId: string, gen: string, patch: Partial<PreviewRecord>): PreviewRecord | null {
  const current = readAnyPreview(taskId);
  if (!current || current.gen !== gen) return null;
  const next = { ...current, ...patch };
  writeRecord(next);
  return next;
}

/**
 * 预览的启动日志落在哪。**banner 在 spawn 之前就写了**，所以「起失败的那一次」同样
 * 留得下现场 —— 起不来的时候恰恰是最需要看日志的时候，而那时 preview.json 不存在。
 */
export function previewLogPath(taskId: string): string {
  return join(RUNS_DIR, taskId, "preview.log");
}

export function archivePreview(record: PreviewRecord, status: "failed" | "stopped"): void {
  writeFileSync(join(RUNS_DIR, record.taskId, "preview-last.json"), JSON.stringify({
    ...record, pid: 0, url: null, proxyToken: undefined, links: [], installPid: null,
    services: record.services?.map((s) => ({ ...s, pid: 0, url: null, status })),
  }));
}

export function lastPreview(taskId: string): PreviewRecord | null {
  try { return JSON.parse(readFileSync(join(RUNS_DIR, taskId, "preview-last.json"), "utf8")); }
  catch { return null; }
}

export function hasPreviewLog(taskId: string): boolean {
  return existsSync(previewLogPath(taskId));
}

/**
 * 给界面看的启动日志：太长就只给尾巴（前端要显示的是「刚才发生了什么」，不是归档）。
 * 没有这个文件返回 null —— 「从来没起过」和「起过但没输出」不是一回事。
 */
export function readPreviewLog(taskId: string, maxBytes = 200_000, serviceId?: string): {
  text: string;
  truncated: boolean;
  updatedAt: string | null;
} | null {
  const record = readAnyPreview(taskId) ?? lastPreview(taskId);
  const service = serviceId ? record?.services?.find((s) => s.id === serviceId) : null;
  if (serviceId && !service) return null;
  const path = service?.log ?? previewLogPath(taskId);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
    if (!serviceId && record?.services && record.services.length > 1) {
      text += record.services.map((s) => {
        try { return `\n── ${s.name} ──\n${readFileSync(s.log, "utf8").slice(-Math.floor(maxBytes / record.services!.length))}`; }
        catch { return `\n── ${s.name}：暂无日志 ──\n`; }
      }).join("");
    }
  } catch {
    return null;
  }
  const truncated = text.length > maxBytes;
  let updatedAt: string | null = null;
  try { updatedAt = statSync(path).mtime.toISOString(); } catch { /* 文件刚被清掉，不影响正文 */ }
  return { text: truncated ? text.slice(-maxBytes) : text, truncated, updatedAt };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 日志尾巴，**掐掉开头那行命令回显**。
 *
 * 掐它不是为了好看：那一行里有用户自己写的命令，而命令里很可能带着一个地址
 * （`VITE_APP_API_URL=http://localhost:8082 pnpm dev`），ash 一注入 `URL2=…` 更是必然
 * 带。地址扫描器不认得「这句是回显不是日志」，扫到就会把预览判成起在**别人**那个端口上
 * —— 用户点开预览看到的是后端，改动却在前端。所以分析用的文本一律先减去这一行。
 *
 * 先减再截尾，不是先截尾再减：日志一长，回显被截掉一半留下的残句照样能匹配出地址。
 */
export function tail(path: string, banner = "", max = 4000): string {
  try {
    const text = readFileSync(path, "utf8");
    const body = text.startsWith(banner) ? text.slice(banner.length) : text;
    return body.length > max ? body.slice(-max) : body;
  } catch {
    return "";
  }
}
