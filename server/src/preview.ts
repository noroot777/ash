// 「打开预览」那一站的真身：起一个长驻服务、等它真的能连上、把地址留在时间线上。
//
// 为什么值得单独一个模块：预览进程跟 agent 进程是两回事——它**没有终点**，是我们主动
// 起、也得主动收的。所以这里的每一件事都围绕「别留孤儿」转：
//   ① POSIX 进程 detached 自成组；Windows 不放进 job object，父进程退出也不会连坐。
//      两边都把 pid 落盘（data/runs/<task>/preview.json），server 重启后照样杀得掉——
//      内存里的 map 随进程一起没了，文件不会。**记录从「开始启动」那一刻就写**，不是等
//      就绪才写：装依赖加等就绪最长八分钟，那段时间里的关闭/续跑/重启同样得抓得住它
//      （见 PreviewRecord.state）。
//   ② 每个任务同一时刻只有一个预览，起新的先收旧的。
//   ③ 定时清扫既收「进程早死了但记录还在」，也收 idle30 这一档。
//
// 就绪判定不做花活：地址优先从日志里认（dev server 都会打印一行 http://localhost:xxxx），
// 日志里没有就退回「借出去的那个端口连不连得上」——不是所有语言的服务都肯把地址印出来。
// 拿到之后再按用户选的那档确认——端口连得上 / 日志也说了 ready / HTTP 真返回 200。
// 等不到就是这一站失败，绝不写一句「预览已起」骗人。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreviewLife, WorkflowStep } from "@ash/shared/workflow";
import { bus } from "./bus.js";
import { augmentedEnv, killByPid, withoutForeignNodeBins } from "./executors/spawn.js";
import { RUNS_DIR } from "./paths.js";
import { userShellLaunch } from "./platform.js";
import { portConflict, pickPreviewUrl, portHint, missingDepsHint, missingNodeBin } from "./preview-log.js";
import { heldCacheOf, nodeDepsAdvice, prepareNodeDeps, pruneNodeDeps, removePreparedLinks } from "./preview-deps.js";
import { PORT_ENV_ALIASES, PORT_SLOT } from "./preview-command.js";
import { canConnect, ready } from "./preview-probe.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export type PreviewStep = Extract<WorkflowStep, { kind: "preview" }>;

export interface PreviewRecord {
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

/** 等它起来最多等多久 —— 前端构建冷启动一分钟很常见，再久就该报「起不来」了。 */
const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
/** idle30 那一档：满这么久就回收（见 PREVIEW_LIFE_LABELS 的口径说明）。 */
const IDLE_LIFE_MS = 30 * 60_000;
const SWEEP_MS = 5 * 60_000;
const UNSAFE_SCHEDULER_LOG = "[ash] scheduler started";

// 「端口撞车怎么认、日志里哪个地址才是预览本尊、认出来说什么」都在 preview-log.ts
//（纯函数，回归 test:preview-log）；「连不连得上、算不算起来了」在 preview-probe.ts
//（回归 test:preview-probe）。两个都不进 db，才测得动。

/**
 * 借一批空闲端口，以环境变量交给启动命令。
 *
 * 起因是一类**必然**发生的撞车：预览跑在任务自己的 worktree 里，命令却是从项目里抄来的
 * `npm run dev`，端口写死在脚本里。而同一个项目此刻多半已经有一份在跑（开发者自己那份、
 * 或者另一个任务的预览），于是这一站不是「有时候起不来」，是**一次都起不来**。
 *
 * 端口怎么进到命令里，**每种运行时的答案都不一样**（Node 认 `PORT`、Spring Boot 认
 * `SERVER_PORT`、vite 只认 `--port` 参数……），那张表在 preview-command.ts；这里只负责把
 * 借到的号码按那张表铺成环境变量。识别出来的命令天生就按自己那门语言的写法拿端口，用户
 * 自己填的命令也能从这一串名字里挑一个 —— 都不认的最差也不会更糟，那时我们至少还能在
 * 日志里当场认出撞车并说人话。
 * 端口是 listen(0) 拿的，关掉再交给子进程，中间有个理论上的竞态窗口，抢不到就还是撞车
 * 那条路，不额外补偿。
 *
 * **借不止一个**的理由见 PORT_POOL：前后端一起起时，前端要在启动那一刻就知道后端落在
 * 哪个端口上，而两个端口都是随机的 —— 只有 ash 同时借、同时告诉它们，这件事才成立。
 */
function freePort(): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(null));
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 一次借几个端口。1 个给「要看的那个」，其余给它的配角（后端、网关、mock 服务…）。
 *
 * 5 = 一个前端 + 四个后端，够覆盖「一个前端挂着一排微服务」的常见规模；借多了不花钱
 * （探完就关），少了就得让用户回去写死端口，而写死端口正是这一整套要解决的问题。
 */
const PORT_POOL = 5;

async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const port = await freePort();
    // 借不到就停：拿到几个是几个，第一个拿不到时 portEnv 会退化成「什么都不注入」，
    // 跟这套机制上线前的行为一致。
    if (port === null || ports.includes(port)) break;
    ports.push(port);
  }
  return ports;
}

/** 撞车时给的下一步在 preview-log.ts。 */

/**
 * 借来的端口怎么递给命令。两组名字，各有各的收件人：
 *
 *   · `PORT` / `SERVER_PORT` / `ASPNETCORE_URLS` / …：**要看的那个**服务的端口，同一个值
 *     换好几个名字。名单和理由在 preview-command.ts 的 PORT_ENV_ALIASES —— 从那儿导入而
 *     不是在这儿再抄一份：识别出来的命令按哪个名字拿端口，跟这里注入哪些名字，是同一件事
 *     的两头，抄成两份迟早对不上（那时症状是「某种语言的预览永远起在写死的端口上」）。
 *   · `PORT2…PORT5` / `URL2…URL5`：**配角**的端口和地址。一条命令里起前后端时，前端要在
 *     启动那一刻就知道后端在哪 —— 两边都是随机端口，谁也猜不到谁，只能由 ash 同时借下来
 *     一起告诉它们。`URLn` 是 `http://localhost:<PORTn>`，因为绝大多数前端的代理目标要的
 *     是整条地址而不是一个数字（vite 的 `server.proxy.target`、`VITE_*_URL` 之类）。
 *     配角要哪个名字由它自己在命令里写（`SERVER_PORT=$PORT2 …`），所以这里只给号码。
 *
 * 认不了环境变量的（vite / Django / Laravel / Rails……）由命令自己带 `$PORT` —— 那也是同一个
 * 值，因为这里注进去的就是 shell 展开时看到的 PORT。
 */
function portEnv(ports: number[]): Record<string, string> {
  const [primary, ...rest] = ports;
  if (!primary) return {};
  const env: Record<string, string> = {};
  for (const alias of PORT_ENV_ALIASES) env[alias.name] = alias.template.replaceAll(PORT_SLOT, String(primary));
  rest.forEach((port, index) => {
    env[`PORT${index + 2}`] = String(port);
    env[`URL${index + 2}`] = `http://localhost:${port}`;
  });
  return env;
}

/** 日志头那一行：把注入的环境变量照实写出来，顺序稳定，好让人一眼对上。 */
function bannerEnv(ports: number[]): string {
  return Object.entries(portEnv(ports)).map(([key, value]) => `${key}=${value}`).join(" ");
}

function recordPath(taskId: string): string {
  return join(RUNS_DIR, taskId, "preview.json");
}

/**
 * 盘上这个任务的预览记录，**不管它是在启动还是已经起来了**。
 *
 * 只有「要收拾它」的那几条路径该用这个（停止、续跑、清扫）。给界面看的一律用
 * readPreview —— 一条还在启动的记录没有 url、没有 pid，被当成「预览在跑」就会变成
 * 一句更早的谎。
 */
function readAnyPreview(taskId: string): PreviewRecord | null {
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

function writeRecord(record: PreviewRecord): void {
  writeFileSync(recordPath(record.taskId), JSON.stringify(record, null, 2));
}

/**
 * 更新「正在启动」那条记录，**前提是它还是我们这一趟的**。返回 null = 这一趟已经被取消
 * （或者被新的一趟顶掉了），调用方就该收摊，别再往盘上写。
 */
function patchStart(taskId: string, gen: string, patch: Partial<PreviewRecord>): PreviewRecord | null {
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

export function hasPreviewLog(taskId: string): boolean {
  return existsSync(previewLogPath(taskId));
}

/**
 * 给界面看的启动日志：太长就只给尾巴（前端要显示的是「刚才发生了什么」，不是归档）。
 * 没有这个文件返回 null —— 「从来没起过」和「起过但没输出」不是一回事。
 */
export function readPreviewLog(taskId: string, maxBytes = 200_000): {
  text: string;
  truncated: boolean;
  updatedAt: string | null;
} | null {
  const path = previewLogPath(taskId);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const truncated = text.length > maxBytes;
  let updatedAt: string | null = null;
  try { updatedAt = statSync(path).mtime.toISOString(); } catch { /* 文件刚被清掉，不影响正文 */ }
  return { text: truncated ? text.slice(-maxBytes) : text, truncated, updatedAt };
}

function alive(pid: number): boolean {
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
function tail(path: string, banner = "", max = 4000): string {
  try {
    const text = readFileSync(path, "utf8");
    const body = text.startsWith(banner) ? text.slice(banner.length) : text;
    return body.length > max ? body.slice(-max) : body;
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 正在启动、还没就绪的那几个任务 —— **本进程正在驱动的那几趟**。
 *
 * 「有没有在启动」和「起来了没有」是两件事，而启动那一段恰恰是最需要看日志的一段
 * —— Maven 在下依赖、前端在冷编译，一等就是一两分钟。只拿「起来了没有」当「在跑」的话，
 * 这整段时间对界面来说都是「没在跑」：日志接口报 `running: false`，弹窗因此不开轮询，
 * 用户守着一份不再更新的快照看「处理中」。
 *
 * 盘上另有一条 `state: "starting"` 的记录（见 PreviewRecord.state），那是给「怎么把它
 * 杀掉」用的，两者不重复：内存这张表回答的是「**谁在驱动**它」。清扫靠这个区分「正在
 * 启动」和「上一条命留下的孤儿」—— 没人驱动就是没人管了，收掉。
 *
 * **按代号记，不是按任务记。** 同一个任务的两趟启动完全可以重叠（自动推进那一站刚开始
 * 冷启动，用户在线路图上又点了一下「重启预览」）：新那趟写下自己的代号、把旧那趟顶掉，
 * 旧那趟随后发现代号变了就收摊 —— 可它退出时如果按 taskId 抹掉标记，抹掉的是**新那趟**
 * 的。接着清扫看见一条没人驱动的 `starting` 记录，按「重启遗留的孤儿」把正在冷启动的
 * 新预览杀了。一次五分钟一轮的清扫撞上一次八分钟的启动，这不是理论上的窗口。
 */
const starting = new Map<string, Set<string>>();

/** 这一趟（taskId + 代号）开始由本进程驱动。 */
function beginDriving(taskId: string, gen: string): void {
  const gens = starting.get(taskId) ?? new Set<string>();
  gens.add(gen);
  starting.set(taskId, gens);
}

/** 这一趟结束了。**只撤自己那一代** —— 见 starting 上面的说明。 */
function endDriving(taskId: string, gen: string): void {
  const gens = starting.get(taskId);
  if (!gens) return;
  gens.delete(gen);
  if (!gens.size) starting.delete(taskId);
}

/** 这一代此刻还有人驱动吗。清扫靠它区分「正在启动」和「上一条命留下的孤儿」。 */
function driving(taskId: string, gen: string | undefined): boolean {
  return gen !== undefined && (starting.get(taskId)?.has(gen) ?? false);
}

/**
 * 这个任务的预览是不是正在启动（还没就绪）。给日志接口判断要不要续读用。
 *
 * 内存那张表之外还认盘上那条 `state: "starting"`：server 刚重启、界面又开着日志弹窗时，
 * 内存里是空的，而那一趟的子进程可能还在（detached）。盘上那条最多活到下一次清扫
 * （启动时立刻扫一遍），不会留下一个永远「正在启动」的任务。
 */
export function isPreviewStarting(taskId: string): boolean {
  return starting.has(taskId) || readAnyPreview(taskId)?.state === "starting";
}

/** 盘上那条「正在启动」的记录（给路由/状态用：它是不是该显示成「可以关掉」）。 */
export function previewStartingRecord(taskId: string): PreviewRecord | null {
  const record = readAnyPreview(taskId);
  return record?.state === "starting" ? record : null;
}

export type PreviewResult =
  | { ok: true; record: PreviewRecord }
  | { ok: false; reason: string };

// 起一个预览。cwd 由调用方给（任务自己的工作区），因为「在哪儿跑」是工作区的事，
// 不该在这里第二次推导。
//
// 外面这一层只做一件事：把「这个任务正在启动」记上，等这次启动有了结论再抹掉。见
// starting 那儿的说明 —— 启动那一两分钟是日志最该被看见的一段。
export async function startPreview(
  taskId: string,
  step: PreviewStep,
  cwd: string,
): Promise<PreviewResult> {
  // 代号在这儿生成而不是在里面：进出内存表和写盘记录用的必须是同一个，否则「谁在驱动
  // 这一代」就对不上（见 starting）。
  const gen = randomUUID();
  beginDriving(taskId, gen);
  try {
    return await runPreview(taskId, step, cwd, gen);
  } finally {
    endDriving(taskId, gen);
  }
}

async function runPreview(
  taskId: string,
  step: PreviewStep,
  cwd: string,
  gen: string,
): Promise<PreviewResult> {
  await stopPreview(taskId, null);
  const dir = join(RUNS_DIR, taskId);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "preview.log");
  const lentAll = await freePorts(PORT_POOL);
  const lent = lentAll[0] ?? null;
  // 日志头把注入的环境变量照实写出来，不只写命令：用户翻预览日志时得能一眼看出
  // 「ash 到底把什么交给了这条命令」，而不是去猜端口是谁定的 —— 一条同时起前后端的
  // 命令里，配角落在哪个端口上只有这一行说得清。
  const injected = bannerEnv(lentAll);
  const banner = `$ ${injected ? `${injected} ` : ""}BROWSER=none ASH_PREVIEW=1 ASH_PREVIEW_MODE=${step.p.mode} ${step.p.cmd}\n`;
  writeFileSync(log, banner);
  // **落盘的第一件事**：一条「正在启动」的记录（理由见 PreviewRecord.state）。它先于
  // 装依赖和 spawn，因为要被杀掉的恰恰是这两段 —— 一趟启动最长可以是「装 6 分钟 + 等
  // 2 分钟」，这八分钟里点关闭、任务续跑、server 重启，都得抓得住它。
  writeRecord({
    taskId, cmd: step.p.cmd, pid: 0, url: null, port: null,
    life: step.p.life, startedAt: now(), log, links: [], state: "starting", gen, installPid: null,
  });
  // 发事件，界面才知道「这个任务此刻正在起预览」。不发的话，起预览这一路是**同步等**
  // 到就绪的（最长八分钟），期间任何一个客户端（包括发起的那个刷新之后）都只看得到
  // 「没在跑」，于是没有任何一处显示得出「关闭预览」——而这八分钟正是最该给一个取消入口
  // 的时候。收掉/起来了各自也会发，三处一致。
  bus.publish({ type: "task.review", taskId });
  // 起进程**之前**：这条命令要的 node 依赖不齐，就由 ash 自己在**项目之外**备一份挂进来
  // （怎么备、为什么必须在项目外，见 preview-deps.ts 顶部）。放在这儿有两个理由：banner
  // 已经落盘，所以 install 的输出直接进同一份预览日志，用户在弹窗里实时看得见（启动那一段
  // 是自动续读的）；而 READY_TIMEOUT 从下面才开始算，装依赖的几分钟不会被算成「起不来」。
  //
  // 备不成不拦路：照常去跑那条命令，它会以 `vite: not found` 失败，那时下面的诊断拿着
  // 这里的失败理由给人工的下一步。用户填的命令也可能压根不需要 node 依赖。
  // 装依赖的那个进程一起放进记录：它可以跑满六分钟，而这六分钟里的「关闭预览」必须
  // 真的把它杀掉 —— 只删记录的话，包管理器和项目自己的 preinstall/postinstall 还在后台
  // 跑，任务续跑的那一路更糟：新一轮已经在改同一个工作区了。
  let installing = 0; // 手上这一份：记录可能已经被取消的那一下删掉了，这里还得杀得到它
  const tried = await prepareNodeDeps(cwd, step.p.cmd, log, (installPid) => {
    installing = installPid;
    // 记录没了/换人了就说明这一趟已经被取消：那时它正等着我们自己收摊，别再往盘上写。
    patchStart(taskId, gen, { installPid: installPid > 0 ? installPid : null });
  });
  // 我们挂上去的那几条软链**只在预览活着的这段时间存在**：起不来就当场撤掉，挂上了就立刻
  // 记进 preview.json（那条「正在启动」的记录），由 stopPreview 撤（理由见 removePreparedLinks —— 用户敲 `git status`
  // 不该看见 ash 留下的东西）。依赖本体留在 data/deps，撤掉的只是入口，下次是秒挂。
  const links = tried.flatMap((one) => one.link === null ? [] : [one.link]);
  const failed = (reason: string): PreviewResult => {
    removePreparedLinks(links);
    // 这一趟结束了，「正在启动」那条记录也就该没了 —— 但只撤**我们自己那一代**：
    // 被取消之后可能已经有新的一趟在跑，删它的记录等于把活着的预览变成孤儿。
    if (readAnyPreview(taskId)?.gen === gen) rmSync(recordPath(taskId), { force: true });
    return { ok: false, reason };
  };
  /**
   * 这一趟还算不算数。不算了就自己收摊：杀掉已经起的进程，**只在没人接手时**才撤软链。
   *
   * 撤链要挑时候：取消我们的那一下已经按记录撤过一轮（那时记录里有几条就撤几条），
   * 而装依赖那几分钟里挂上的链它是不知道的，得由我们补撤。可如果此刻已经有新的一趟
   * 开始了，同一个路径就是**它的**入口了，我们再撤就等于把别人的预览拆了。
   */
  const abandoned = (pid: number | null): PreviewResult => {
    if (pid !== null && pid > 0) killByPid(pid);
    // 取消我们的那一下已经按记录杀过一轮装依赖的进程；这里再补一次是为了「记录里还没
    // 来得及写下 installPid」那半拍。killByPid 对已经死掉的 pid 是空操作。
    if (installing > 0) killByPid(installing);
    if (readAnyPreview(taskId) === null) removePreparedLinks(links);
    return { ok: false, reason: "预览启动被取消（关闭预览 / 任务重新开跑 / ash 重启）" };
  };
  // 装依赖可以走掉好几分钟，这中间被取消是常态，不是意外。
  if (patchStart(taskId, gen, { links }) === null) return abandoned(null);
  const fd = openSync(log, "a");
  let pid: number;
  try {
    // 用户那条命令行交给谁跑,由 platform 收口(POSIX 是 `sh -lc`,Windows 是
    // `cmd /d /s /c`)。POSIX 要 detached 才能靠进程组收完整棵树。Windows 反过来:
    // `detached + windowsHide` 会让底层忽略 CREATE_NO_WINDOW,外层 cmd 再拉起的
    // vite/node 就会拿到一扇可见控制台;而 taskkill /T 本来就按父子关系收树,不依赖
    // 进程组,所以 Windows 不 detached 反而既能隐藏,也不影响回收。
    const launch = userShellLaunch(step.p.cmd);
    const child = spawn(launch.file, launch.args, {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      stdio: ["ignore", fd, fd],
      // BROWSER=none：dev server 的 `--open` 会去拉一个真浏览器窗口，预览是后台起的，
      // 那扇窗户没人要。PORT 的来由见 freePort 的注释。
      // withoutForeignNodeBins：ash 是被 npm 起来的，PATH 头上挂着 ash 自己的
      // `node_modules/.bin`；不摘掉的话，一个依赖没装的项目会用 **ash 的** vite 起来，
      // 报一句「预览已起」把用户领到假现场（理由全文在那个函数头部）。
      env: {
        ...withoutForeignNodeBins(augmentedEnv(), cwd),
        ASH_PREVIEW: "1",
        ASH_PREVIEW_MODE: step.p.mode,
        ...portEnv(lentAll),
        BROWSER: "none",
      },
    });
    child.unref();
    if (!child.pid) return failed("预览进程没起来");
    pid = child.pid;
    // pid 一到手立刻落盘：从这一刻起「关闭预览」杀得到它。慢一步都不行 —— 中间这一段
    // 正是它还没监听端口、界面上什么都看不出来的时候。
    if (patchStart(taskId, gen, { pid }) === null) return abandoned(pid);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    closeSync(fd);
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    // 每一圈都问一句「这趟还算数吗」：等就绪最长两分钟，用户在这中间点关闭是常事。
    // 不问的话，被杀掉的只是当时那个 pid，而这个循环稍后照样会写一条 ready 记录出来。
    if (readAnyPreview(taskId)?.gen !== gen) return abandoned(pid);
    const text = tail(log, banner);
    if (text.includes(UNSAFE_SCHEDULER_LOG)) {
      killByPid(pid);
      // 走 failed()，不是裸 return：**每一条失败出口都得把我们挂的软链撤掉**。这条安全
      // 拒绝原来是裸的，于是「被拒绝」这一次会在用户工作区里永久留下一条 node_modules
      // 软链 —— 而且 preview.json 不会写，事后没有任何线索能找回来撤它。
      return failed("这个分支的预览后端启动了真调度器，安全协议过旧，已立即回收。请先把当前分支同步到新版预览隔离逻辑。");
    }
    // 日志里认不出地址时，还有最后一条不依赖日志的线索：**端口是我们借出去的**。
    // 借出去之前刚 listen(0) 探过它是空的，此刻连得上就只能是这条命令自己起的进程。
    //
    // 这一支不是锦上添花，是「非 Node 项目也能预览」的必要条件：从日志里认地址，前提是
    // 那条命令肯把地址印出来、而且是行缓冲的印。这两条只有 Node 的 dev server 一贯满足 ——
    // `python3 -m http.server` 那句 `Serving HTTP on …` 在非 tty 下是块缓冲的，压根不落盘；
    // 一个 `go run` 写的服务可以什么都不印。服务明明起在我们指定的端口上，却因为它没吭声
    // 被判「等了 120 秒还没起来」，这跟「只有 Node 项目的预览算数」是同一回事。
    const found = pickPreviewUrl(text, lent, lentAll.slice(1))
      ?? (lent !== null && await canConnect(lent) ? { url: `http://localhost:${lent}/`, port: lent, lent: true } : null);
    // 顺序要紧：撞车先判，再判进程死没死、再判起没起来。见 PORT_TAKEN_RE 那儿的 ②。
    //
    // 只有一个例外：日志里已经出现了**借给这条命令的那个端口**上的地址。那个端口是我们
    // 刚探出来的空闲端口，此刻占着它的只可能是这条命令自己起的进程，所以 ② 担心的
    // 「连到别人的服务上去」在这一支不成立。而它救的是一类常态 —— 一条 `npm run dev`
    // 并排起好几个服务（典型：concurrently 起前端 + 后端），后端撞上本机已在跑的那份，
    // 前端明明认了 $PORT 好好地起来了，却被后端那一行日志连坐判死。
    const conflict = found?.lent ? null : portConflict(text);
    if (conflict) {
      killByPid(pid);
      return failed(`${conflict}。\n\n${portHint(lent)}\n\n最后几行日志：\n${text.slice(-600)}`);
    }
    if (!alive(pid)) {
      // 组长（外层 shell / scripts/dev.mjs）先退出，不代表同组的 vite/tsx 也退出了。
      // pid 本身虽已不在，POSIX 的进程组 -pid 仍可存在；照样发组信号，别留下孤儿。
      killByPid(pid);
      // 退出原因里最常见的一种是「有个东西找不到」，日志尾巴本身看不出所以然。认出来就
      // 多说一句怎么办 —— 而且**分清找不到的是什么**：Node 依赖里的可执行文件（软链
      // node_modules）和一门运行时（mvn/dotnet/go…，那是 PATH 的事）下一步完全不同，
      // 详见 missingDepsHint。
      //
      // 前一种要**核对一遍事实再开口**，而且核对时把「这次缺的是哪个可执行文件」一起带上：
      // 只看「node_modules 在不在」会把 `--prod` 装出来的树、装了一半的树都判成「不缺」，
      // 于是日志明明写着 `vite: not found`，诊断却回一句「没发现缺依赖」、退回带占位符的
      // 通用模板。`tried` 是上面 ash 自己备依赖那一步的结果 —— 建议得先交代它为什么没成，
      // 用户才知道自己要补的是哪一段。
      const deps = missingDepsHint(text, nodeDepsAdvice(cwd, step.p.cmd, missingNodeBin(text)), tried);
      return failed(`预览进程已退出。${deps ? `\n\n${deps}\n` : ""}\n最后几行日志：\n${text.slice(-800)}`);
    }
    if (!found) continue;
    if (!(await ready(step.p.ready, found.url, found.port, text))) continue;
    // 起来了。**仍然要核对代号**：就绪判定本身要跑一趟 HTTP/连通性探测，那期间照样
    // 可能被取消，而这一步是把「正在启动」翻成「在跑」——写早了就是死灰复燃。
    const record = patchStart(taskId, gen, {
      pid, url: found.url, port: found.port, links, state: "ready", startedAt: now(), installPid: null,
    });
    if (record === null) return abandoned(pid);
    return { ok: true, record };
  }
  killByPid(pid);
  return failed(`等了 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒还没起来。最后几行日志：\n${tail(log, banner).slice(-800)}`);
}

// 收掉一个任务的预览。reason 非空才往时间线写一行——刷新后仍能看出「预览被收了、
// 为什么收的」，这是停止/暂停那条规矩的同一条判据。
export async function stopPreview(taskId: string, reason: string | null): Promise<boolean> {
  // readAnyPreview：**还在启动的那一趟也得收得掉**。记录一删，那一趟自己下一个检查点
  // 就会发现代号没了，杀掉自己起的进程、把链撤干净（见 runPreview 里的 abandoned）。
  const record = readAnyPreview(taskId);
  if (!record) return false;
  // 不先看组长是否还活着：组长死、vite 仍留在同一进程组，正是必须回收的现场。
  // pid 为 0 = 还没 spawn，`kill(0, …)` 打的是**自己这一组**，绝不能放过去。
  if (record.pid > 0) killByPid(record.pid);
  // 还在装依赖的话，要收的是**它**：这时候还没有 dev server，pid 是 0。
  if (record.installPid && record.installPid > 0) killByPid(record.installPid);
  removePreparedLinks(record.links ?? []);
  rmSync(recordPath(taskId), { force: true });
  if (reason) await appendTaskTimeline(taskId, `预览已回收（${reason}）：${record.url ?? record.cmd}`);
  // 自由工作流状态里的 preview.running 变了就必须发事件：那份快照的版本号只由
  // task.review / task.status 递增，不发的话前端拿到的新快照版本相等，会被当成
  // 「不比现值新」丢掉——按钮就一直停在「关闭预览」上。
  bus.publish({ type: "task.review", taskId });
  return true;
}

/**
 * 验收通过时的回收：`gate`（下一个人工关口结束时回收）和 `task`（任务结束时回收）两档
 * 一起收。
 *
 * 「任务结束时回收」得真有个结束点，否则那一档就是永不回收——一个 dev server 一直占着
 * 端口，用户还以为选了「任务结束时回收」它自己会走。这条线的终点就是验收：走到这儿
 * 这个任务不会再动了。（打回重做那条路上关口也结束了，但那时预览由「任务重新开跑」
 * 那一下收掉，见 stopPreviewOnRerun。）
 *
 * 调用点在**「点头之后」那一段开跑之前**，所以那一段又起的预览（用户特意编排的「验收完
 * 把线上环境开起来」）不受影响 —— 它是验收之后才有的东西。
 */
export async function stopPreviewAtAccept(taskId: string): Promise<void> {
  const record = readAnyPreview(taskId);
  if (!record) return;
  if (record.life === "gate") await stopPreview(taskId, "人工关口已结束");
  else if (record.life === "task") await stopPreview(taskId, "任务已验收完成，按线上写的「任务结束时回收」收掉");
}

/** 任务又开跑了：预览指向的是上一版代码，一律收掉，免得对着旧页面验新改动。 */
export async function stopPreviewOnRerun(taskId: string): Promise<void> {
  // readAnyPreview：正在启动的那一趟更得收 —— 它上线的时候任务已经在改下一版代码了，
  // 留着它就是让用户对着上一版验新改动，而这正是这个函数唯一要防的事。
  if (readAnyPreview(taskId)) await stopPreview(taskId, "任务重新开跑，旧预览指向的是上一版代码");
}

// 清扫：进程早死了的记录、以及 idle30 那一档到点的。启动时先扫一遍，之后每 5 分钟一次
// —— 重启后内存 map 没了也不影响，判据全在盘上。
//
// 还兜一类：**任务本身已经没了或者被归档**。验收那条路径收得掉正常走完的，收不掉「任务
// 直接被删/归档，预览还在那儿开着」的——那种情况下没有任何一个界面还会提到它，端口却
// 一直占着。db 走动态 import：这个模块本来只碰进程和文件，不想为一条兜底把它绑到表上。
export async function sweepPreviews(): Promise<void> {
  let dirs: string[];
  try {
    dirs = readdirSync(RUNS_DIR);
  } catch {
    return;
  }
  for (const taskId of dirs) {
    if (!existsSync(recordPath(taskId))) continue;
    const record = readAnyPreview(taskId);
    if (!record) {
      rmSync(recordPath(taskId), { force: true });
      continue;
    }
    if (record.state === "starting") {
      // 「正在启动」只有本进程的 startPreview 在驱动，而它一定同时记着自己的代号。
      // **按代号问**，不是按任务问：两趟启动重叠时按任务问会把新那趟错判成孤儿杀掉
      // （见 starting）。这一代没人驱动 = 驱动它的那个 server 已经不在了（重启/被杀），
      // 这条记录再也不会有人收尾：它的子进程可能还活着（detached 的），软链也还挂着。
      if (driving(taskId, record.gen)) continue;
      if (record.pid > 0) killByPid(record.pid);
      if (record.installPid && record.installPid > 0) killByPid(record.installPid);
      removePreparedLinks(record.links ?? []);
      rmSync(recordPath(taskId), { force: true });
      await appendTaskTimeline(taskId, `预览没能起完就中断了（ash 重启），已经清理：${record.cmd}`);
      continue;
    }
    if (!alive(record.pid)) {
      // 记录的组长死了也要向原进程组补发信号；直接删记录会永久失去唯一的 pgid 线索。
      killByPid(record.pid);
      // 软链同理，而且**更没有第二次机会**：记录一删，`record.links` 就是最后一份线索，
      // 此后 stopPreview 再也找不到该撤什么，那条链会永久留在用户的工作区里。
      removePreparedLinks(record.links ?? []);
      rmSync(recordPath(taskId), { force: true });
      await appendTaskTimeline(taskId, `预览进程已自行退出：${record.url ?? record.cmd}`);
      continue;
    }
    if (record.life === "idle30" && Date.now() - Date.parse(record.startedAt) > IDLE_LIFE_MS) {
      await stopPreview(taskId, "起来满 30 分钟，按线上写的回收");
      continue;
    }
    const gone = await taskGone(taskId);
    if (gone) await stopPreview(taskId, gone);
  }
  // 收尾再清备用依赖：这套东西按内容一份一份地装，一份前端依赖几百兆，不清就会在**用户的
  // 磁盘**上无声地涨（见 pruneNodeDeps）。
  //
  // 顺序是有讲究的，**必须排在上面那一圈之后**：清理只认 mtime，而缓存只在挂链那一刻
  // touch 过一次。自由预览是 `life: "task"`，一个任务等人验收等上三十天完全合法，那份
  // 缓存却会在预览还跑着的时候「过期」。删掉的后果不是下次慢一点——工作区那条软链还在、
  // 只是断了，dev server 按需加载下一个模块时才炸，记录上它还好端端地跑着。所以先把死掉的
  // 记录和它们的软链收干净，再拿**剩下这些还活着的**记录告诉清理器哪几份动不得。
  pruneNodeDeps(heldCaches());
}

/** 还活着的预览记录正占着哪几份依赖缓存（顺着它们挂出去的软链倒推）。 */
function heldCaches(): string[] {
  const held = new Set<string>();
  let dirs: string[];
  try { dirs = readdirSync(RUNS_DIR); } catch { return []; }
  for (const taskId of dirs) {
    // readAnyPreview：正在启动那一趟挂的链同样占着缓存，别在它装到一半时把树删了。
    for (const link of readAnyPreview(taskId)?.links ?? []) {
      const cache = heldCacheOf(link);
      if (cache) held.add(cache);
    }
  }
  return [...held];
}

/** 任务已经不在了（删了/归档了）就给个理由，否则 null。查不动库时一律当「还在」。 */
async function taskGone(taskId: string): Promise<string | null> {
  try {
    const [{ db }, { tasks }, { eq }] = await Promise.all([
      import("./db/index.js"),
      import("./db/schema.js"),
      import("drizzle-orm"),
    ]);
    const row = (await db
      .select({ archived: tasks.archived })
      .from(tasks)
      .where(eq(tasks.id, taskId))).at(0);
    if (!row) return "任务已被删除";
    return row.archived ? "任务已归档" : null;
  } catch {
    return null;
  }
}

export function startPreviewSweeper(): NodeJS.Timeout {
  void sweepPreviews();
  const timer = setInterval(() => void sweepPreviews(), SWEEP_MS);
  timer.unref();
  return timer;
}
