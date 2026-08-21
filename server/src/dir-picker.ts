import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Hono } from "hono";
import { expandHome } from "./git.js";
import { encodePowerShellCommand } from "./platform.js";

// 「弹一个系统文件选择窗口，让用户点出项目目录」。三件事决定了这个模块的形状：
//
// ① 窗口弹在**跑 server 的那台机器**上 —— 项目目录也在那台机器上（跟 useHostInfo 同一个
//    道理：浏览器所在的系统不算数）。所以远程浏览器（Tailscale / 局域网 / 手机）调它只会
//    在另一台机器上弹出一个没人看得见的模态窗口，还把那台机器的桌面卡住。必须在源头就
//    把入口关掉：**只放行 loopback**，并且 `/host` 上如实报出「这台能不能用」，让前端
//    连按钮都不渲染，而不是让人点了没反应。
// ② 三个平台没有共同的命令：macOS 走 osascript 的 `choose folder`，Windows 走 PowerShell
//    + WinForms 的 FolderBrowserDialog，Linux 走 zenity / kdialog。
// ③ 这是**模态**窗口：HTTP 请求会一直挂到用户点完。所以要单飞（一次只准开一个，否则连点
//    几下就在服务端桌面上叠出一摞窗口）并且封顶时长。

/** 模态窗口最长挂多久。用户就站在那台机器前面点目录，四分钟远超实际需要。 */
const DIALOG_TIMEOUT_MS = 4 * 60_000;

/** 窗口标题 / 提示语。三个平台共用一句，改这里就够。 */
const PROMPT = "选择项目目录";

/** Windows 侧把起始目录经环境变量递进去，绕开 PowerShell 的引号规则（脚本本身是常量）。 */
const START_ENV = "ASH_DIR_PICKER_START";

/** 一次只准开一个窗口。模态窗口叠起来只会让服务端桌面没法用。 */
let inFlight = false;

export type PickResult = { path: string; cancelled: false } | { path: null; cancelled: true };

/** 带 HTTP 状态码的错误，路由层直接照着回。 */
function fail(message: string, status = 500): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * 只认本机。`::ffff:127.0.0.1` 是 IPv4-mapped 写法，整个 `127.0.0.0/8` 都是回环。
 * 导出是为了让回归测试钉住这道闸 —— 它是「窗口会不会弹到别人机器上」的唯一判据。
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = (address ?? "").replace(/^::ffff:/i, "").trim();
  if (normalized === "::1" || normalized === "localhost") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export interface PickerSupport {
  available: boolean;
  /** 不可用时给一句人话；可用时为 null。前端拿它决定要不要渲染按钮。 */
  reason: string | null;
}

/**
 * 这次请求能不能弹窗。两个独立条件：调用方在不在本机、服务端这台有没有图形界面。
 * 平台判断是同步的（只看 `process.platform` 和 `DISPLAY`），因为 `/host` 是同步端点，
 * 而且「装没装 zenity」这种事探测起来要 fork 进程，不值得为一句提示语付这个代价 ——
 * 真没装时点下去会拿到一条明确的报错。
 */
export function directoryPickerSupport(address: string | undefined): PickerSupport {
  if (!isLoopbackAddress(address)) {
    return { available: false, reason: "文件选择窗口会弹在跑 server 的那台机器上，只有本机打开的浏览器用得上" };
  }
  if (process.platform === "darwin" || process.platform === "win32") return { available: true, reason: null };
  if (process.platform === "linux") {
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return { available: true, reason: null };
    return { available: false, reason: "服务端没有图形界面（DISPLAY / WAYLAND_DISPLAY 都没设），弹不出文件选择窗口" };
  }
  return { available: false, reason: `${process.platform} 上没有可用的文件选择窗口` };
}

/** 窗口一打开就停在这个目录。给的路径不存在就退到它的父目录，再不行退到家目录。 */
export async function startDirectory(raw: string | undefined): Promise<string> {
  const home = homedir();
  const candidate = expandHome((raw ?? "").trim());
  if (!candidate) return home;
  const abs = resolve(candidate);
  for (const path of [abs, dirname(abs)]) {
    try {
      if ((await stat(path)).isDirectory()) return path;
    } catch {
      /* 试下一个 */
    }
  }
  return home;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 进程根本没起来（命令不存在）。要跟「起来了但退出码非 0」分开：前者可以换下一个候选。 */
  missing: boolean;
  timedOut: boolean;
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((done) => {
    execFile(
      file,
      args,
      {
        timeout: DIALOG_TIMEOUT_MS,
        windowsHide: true, // 藏的是 PowerShell 的控制台窗口，GUI 对话框是另一个顶层窗口，照常显示
        maxBuffer: 1 << 20,
        encoding: "utf8",
        env: env ? { ...process.env, ...env } : process.env,
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
        done({
          code: typeof err?.code === "number" ? err.code : err ? null : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          missing: err?.code === "ENOENT",
          timedOut: Boolean(err?.killed),
        });
      },
    );
  });
}

// ── macOS ────────────────────────────────────────────────────────────────────
//
// 起始目录经 `on run argv` 传进去，不拼进脚本文本：路径里带引号或反斜杠时，拼字符串
// 就是一条现成的注入面，而 argv 完全绕开 AppleScript 的引号规则。
//
// `tell application "System Events"` 包住 choose folder 是有意的：osascript 是个后台
// 进程，它自己弹的对话框经常出现在所有窗口**后面**，用户只会觉得「按了没反应」。让
// System Events 先 activate 再由它presenting，窗口才稳定在最前面。System Events 万一
// 不可用（被禁用、自动化权限没给），退回不带 tell 的裸写法再试一次。
export function macScript(useSystemEvents: boolean): string[] {
  const body = [
    "try",
    "  set startFolder to ((POSIX file startPath) as alias)",
    "on error",
    "  set startFolder to (path to home folder)",
    "end try",
    "try",
    `  set chosen to (choose folder with prompt "${PROMPT}" default location startFolder)`,
    "on error number -128",
    "  return \"CANCEL\"",
    "end try",
  ];
  return [
    "on run argv",
    "set startPath to item 1 of argv",
    ...(useSystemEvents
      ? ["tell application \"System Events\"", "activate", ...body, "end tell"]
      : body),
    "return \"OK\" & (POSIX path of chosen)",
    "end run",
  ];
}

async function pickOnMac(start: string): Promise<PickResult> {
  let last: RunResult | null = null;
  for (const useSystemEvents of [true, false]) {
    const args = [...macScript(useSystemEvents).flatMap((line) => ["-e", line]), start];
    const result = await run("osascript", args);
    if (result.timedOut) throw fail("文件选择窗口开了太久，已经关掉了；重新点一次「浏览…」", 504);
    const parsed = parseMarker(result.stdout);
    if (parsed) return parsed;
    last = result;
    // 用户取消在脚本里已经变成 CANCEL 了；走到这里说明是真出错，才值得换个写法重试。
  }
  throw fail(`打不开文件选择窗口：${(last?.stderr || last?.stdout || "osascript 没有任何输出").trim()}`);
}

// ── Windows ──────────────────────────────────────────────────────────────────
//
// FolderBrowserDialog 必须跑在 STA 线程上。Windows PowerShell 5.1 一直是 STA，所以候选
// 顺序跟 platform.ts 里的**反过来**（那边优先 pwsh，只是取数据、无所谓单元模型）；pwsh 7
// 在 Windows 上默认也是 STA，作为退路。
//
// 那个 1×1 全透明的 owner 窗口不是装饰：后台进程弹的对话框会被 Windows 的前台窗口规则挡在
// 别人后面，先 Show + Activate 一个属于自己的窗口，再把它当 owner，对话框才浮到最前。
//
// 输出走 `[Console]::Out.WriteLine` 并把编码钉成 UTF-8：默认的控制台 OEM 代码页会把中文
// 目录名变成乱码（跟 openers/windows.ts 同一个坑）。
export function windowsPickerScript(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${PROMPT}'
$dialog.ShowNewFolderButton = $true
$start = $env:${START_ENV}
if ($start) {
  $dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer
  $dialog.SelectedPath = $start
}
$owner = New-Object System.Windows.Forms.Form
$owner.FormBorderStyle = 'None'
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Opacity = 0
$owner.Width = 1
$owner.Height = 1
$owner.TopMost = $true
$owner.Show()
$owner.Activate()
$result = $dialog.ShowDialog($owner)
$owner.Close()
$owner.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine('OK' + $dialog.SelectedPath)
} else {
  [Console]::Out.WriteLine('CANCEL')
}
`;
}

async function pickOnWindows(start: string): Promise<PickResult> {
  const encoded = encodePowerShellCommand(windowsPickerScript());
  let last: RunResult | null = null;
  for (const [exe, extra] of [["powershell.exe", ["-STA"]], ["pwsh.exe", []]] as const) {
    const result = await run(
      exe,
      ["-NoProfile", ...extra, "-EncodedCommand", encoded],
      { [START_ENV]: start },
    );
    if (result.timedOut) throw fail("文件选择窗口开了太久，已经关掉了；重新点一次「浏览…」", 504);
    const parsed = parseMarker(result.stdout);
    if (parsed) return parsed;
    last = result;
  }
  if (last?.missing) throw fail("服务端上找不到 PowerShell，弹不出文件选择窗口");
  throw fail(`打不开文件选择窗口：${(last?.stderr || last?.stdout || "PowerShell 没有任何输出").trim()}`);
}

// ── Linux ────────────────────────────────────────────────────────────────────
// zenity（GNOME 系）和 kdialog（KDE 系）都是「退出码 0 = 选了，1 = 取消」，路径走 stdout。
// 两个都没装就如实说，不要装作是别的错。
async function pickOnLinux(start: string): Promise<PickResult> {
  const candidates: { file: string; args: string[] }[] = [
    { file: "zenity", args: ["--file-selection", "--directory", `--title=${PROMPT}`, `--filename=${start}/`] },
    { file: "kdialog", args: ["--title", PROMPT, "--getexistingdirectory", start] },
  ];
  let last: RunResult | null = null;
  for (const candidate of candidates) {
    const result = await run(candidate.file, candidate.args);
    if (result.missing) continue;
    if (result.timedOut) throw fail("文件选择窗口开了太久，已经关掉了；重新点一次「浏览…」", 504);
    const picked = result.stdout.trim();
    if (result.code === 0 && picked) return { path: normalizePickedPath(picked), cancelled: false };
    if (result.code === 1) return { path: null, cancelled: true };
    last = result;
  }
  if (!last) throw fail("服务端没装 zenity 或 kdialog，弹不出文件选择窗口");
  throw fail(`打不开文件选择窗口：${(last.stderr || "对话框程序异常退出").trim()}`);
}

/**
 * 削掉路径末尾的分隔符。AppleScript 的 `POSIX path of` 给文件夹的路径**一律带尾斜杠**
 * （实测:选中 `server/src` 回来的是 `/Users/fjh/code/ash/server/src/`），原样填进
 * 输入框会让同一个目录在库里存出两种写法。根目录（`/`、`C:\`）本身就是分隔符,不能削。
 */
export function normalizePickedPath(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed.replace(/[\\/]+$/, "");
  return stripped && !/^[A-Za-z]:$/.test(stripped) ? stripped : trimmed;
}

/**
 * 解析 macOS / Windows 那两段脚本约定的输出：`OK<路径>` 或 `CANCEL`。
 * 认不出来就返回 null —— 调用方据此判断「这次是真出错」，而不是把半截 stderr 当成路径。
 */
export function parseMarker(stdout: string): PickResult | null {
  for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).reverse()) {
    if (line === "CANCEL") return { path: null, cancelled: true };
    if (line.startsWith("OK") && line.length > 2) return { path: normalizePickedPath(line.slice(2)), cancelled: false };
  }
  return null;
}

/** 弹窗，等用户点完。取消不是错误，会如实回 `cancelled`。 */
export async function pickDirectory(startIn: string | undefined): Promise<PickResult> {
  if (inFlight) throw fail("服务端已经开着一个文件选择窗口了，先把它点完", 409);
  inFlight = true;
  try {
    const start = await startDirectory(startIn);
    if (process.platform === "darwin") return await pickOnMac(start);
    if (process.platform === "win32") return await pickOnWindows(start);
    if (process.platform === "linux") return await pickOnLinux(start);
    throw fail(`${process.platform} 上没有可用的文件选择窗口`, 400);
  } finally {
    inFlight = false;
  }
}

/** 请求体读取结果：要么拿到 `startIn`，要么带着状态码原样回给调用方。 */
export type PickRequest =
  | { ok: true; startIn: string | undefined }
  | { ok: false; error: string; status: 400 | 403 | 415 };

/**
 * 这个端点的副作用不是写库，是**在服务端桌面上弹一个模态窗口**——弹出去就占住单飞闸，
 * 一直到有人去点或者四分钟封顶。所以请求本身也得先过一道闸，不能「解析不了就当 {} 继续」。
 *
 * 三道，从外往里：
 * ① `Sec-Fetch-Site`：浏览器自己盖的章，页面伪造不了。不是 `same-origin`/`none` 就是别的
 *    站点在指使这次请求，直接 403。非浏览器调用方（curl、手机端、测试）根本不带这个头，
 *    缺头放行，不影响它们。
 * ② `Content-Type` 必须是 JSON。这条挡的是浏览器的**简单请求**：`no-cors` 的 fetch / 表单
 *    提交只能带 `text/plain`、`multipart/form-data`、`application/x-www-form-urlencoded`
 *    三种类型，换成 `application/json` 就得先过预检，而预检这边不给放行。响应读不到没用，
 *    弹窗这个副作用是照样会发生的。
 * ③ body 必须真的是个 JSON 对象，`startIn` 要么没有要么是字符串。到这一步还错就是调用方
 *    写错了，回 400 让它改，别拿默认值把窗口弹出去。
 */
export function readPickRequest(
  headers: { contentType?: string | null; secFetchSite?: string | null },
  raw: string,
): PickRequest {
  const site = (headers.secFetchSite ?? "").trim().toLowerCase();
  if (site && site !== "same-origin" && site !== "none") {
    return { ok: false, error: "文件选择窗口只接受本页面自己发起的请求", status: 403 };
  }
  const type = (headers.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    return { ok: false, error: "请求体必须是 application/json", status: 415 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "请求体不是合法的 JSON", status: 400 };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "请求体必须是一个 JSON 对象", status: 400 };
  }
  const startIn = (parsed as { startIn?: unknown }).startIn;
  if (startIn !== undefined && typeof startIn !== "string") {
    return { ok: false, error: "startIn 必须是字符串", status: 400 };
  }
  return { ok: true, startIn };
}

export function mountDirectoryPickerRoutes(api: Hono): void {
  api.post("/host/pick-directory", async (c) => {
    const support = directoryPickerSupport(getConnInfo(c).remote.address);
    // 403 而不是 400：这是「你这个来源不该调它」，跟参数没关系。
    if (!support.available) return c.json({ error: support.reason }, 403);
    const parsed = readPickRequest(
      { contentType: c.req.header("content-type"), secFetchSite: c.req.header("sec-fetch-site") },
      await c.req.text(),
    );
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    try {
      return c.json(await pickDirectory(parsed.startIn));
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        status as 400 | 403 | 409 | 500 | 504,
      );
    }
  });
}
