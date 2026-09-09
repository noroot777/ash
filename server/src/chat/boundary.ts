import { watch, type FSWatcher } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "@ash/shared";
import { resolveAshDbFile } from "../db/path.js";
import { DATA_DIR, RUNS_DIR, UPLOADS_DIR } from "../paths.js";

export class ChatBoundaryError extends Error {
  constructor(reason: string) {
    super(`咨询已中止：${reason}。可能已有副作用，请检查项目；未自动撤销改动，也未创建或启动任务。需要执行工作时请明确委派。`);
    this.name = "ChatBoundaryError";
  }
}

function readCommand(command: string, depth = 0): boolean {
  if (depth > 1 || !command.trim() || /[\n\r;&|<>$`\\]/u.test(command)) return false;
  const tokens = command.match(/'[^']*'|"[^"]*"|[^\s'"`]+/gu) ?? [];
  if (tokens.join("") !== command.replace(/\s+(?=(?:[^'"]|'[^']*'|"[^"]*")*$)/gu, "")) return false;
  const args = tokens.map((token) => /^['"]/u.test(token) ? token.slice(1, -1) : token);
  const program = basename(args[0] ?? "");
  if (args[0] !== program && !["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].includes(dirname(args[0] ?? ""))) return false;
  if (["sh", "bash", "zsh"].includes(program)) {
    return args.length === 3 && ["-c", "-lc"].includes(args[1]!) && readCommand(args[2]!, depth + 1);
  }
  if (["cat", "head", "tail", "ls", "pwd", "wc", "stat", "grep"].includes(program)) return true;
  if (program === "rg") return args.slice(1).every((arg) => !arg.startsWith("-") || /^(?:-[nilwF]+|--files|--hidden|--line-number|--ignore-case|--glob|--fixed-strings|--)$/u.test(arg));
  return false;
}

export function readOnlyChatTool(event: Extract<AgentEvent, { kind: "tool" }>): boolean {
  const name = event.name.toLowerCase().replace(/[_-]/gu, "");
  if (["read", "readfile", "readfiles", "viewfile", "listfiles", "listdirectory", "glob", "grep", "searchfiles", "websearch", "webfetch"].includes(name)) return true;
  if (!["exec", "bash", "shell", "execcommand", "runcommand"].includes(name)) return false;
  let command = event.detail ?? "";
  try {
    const detail: unknown = JSON.parse(command);
    if (typeof detail === "string") command = detail;
    else if (detail && typeof detail === "object") command = String((detail as Record<string, unknown>).command ?? (detail as Record<string, unknown>).cmd ?? "");
  } catch {}
  return readCommand(command);
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

export interface ChatWorkspaceObserver {
  /** 等尾随事件落定后关闭监听，返回观察到的变更路径（相对项目根、去重）；more 表示还有没列出的；
   * degraded 表示观察本身不可用/中断过——此时「没有路径」不等于「没有变化」，必须如实披露。 */
  settle(): Promise<{ paths: string[]; more: boolean; degraded?: string }>;
  close(): void;
}

// 观察的时序参数。ARM：fs.watch 返回 ≠ FSEvents 流已启动——流在 libuv 的 CF 线程上异步
// 创建，且只投递「创建之后」的事件，返回后立刻发生的写入可能整个落在启动缝里；武装窗口把
// 这段竞态压到极小再放执行器开跑（彻底消除需要全树基线枚举，大仓库不可行，见
// test-chat-large-workspace 的零枚举闸）。QUIET/MAX：结算不能拿单个固定延时当「事件已收全」
// 的判据——4 路并发负载下 FSEvents 投递迟滞会超过固定 100ms（第 5 轮审查实测 3/12 漏报），
// 改为等事件流静默，封顶防止持续变更的项目把结算拖住不放。
const WATCH_ARM_MS = 75;
const SETTLE_QUIET_MS = 500;
const SETTLE_MAX_MS = 5000;

// 目录观察只做「记录并如实上报」，不做中止：文件系统事件说不出一次改动是谁做的。被咨询的
// 项目通常是一个活着的仓库——ash 自己的验收合并在写它的工作区（2026-09-08 一次 fast-forward
// 就把三个成员的咨询齐刷刷杀掉）、别的任务在 .worktrees/ 里持续写、用户的编辑器和构建也在写。
// 此前按「变化即越界、中止全员」运行的六轮补丁（排除依赖树、shallow 目录、linked worktree
// index、ash 的 data/、整棵 .git……）每轮都在给新冒出来的合法并发写豁免，排除清单永远追不上
// 真实世界。可归因、可中止的只读约束只有一层：工具事件闸门（readOnlyChatTool，默认拒绝）；
// 这里观察到的变化随回复附注展示，由用户自己判断来源。
export async function watchChatWorkspace(cwd: string): Promise<ChatWorkspaceObserver> {
  const root = await realpath(cwd);
  const dbFile = resolveAshDbFile();
  const db = join(await realpath(dirname(dbFile)), basename(dbFile));
  const contains = (tree: string, path: string) => path === tree || path.startsWith(`${tree}${sep}`);
  // ash 自己写进项目里的东西不值得附注：群聊的项目常常**就是 ash 仓库本身**，server.log 每个
  // 请求都动，还有 ash.db 的 -wal/-shm/.ash.lock、scratch/、task-artifacts/、uploads/、runs/。
  // 位置可由 env 改，所以逐个解析而不是只看 DATA_DIR；反过来把项目整个罩住的（比如 ASH_DB
  // 指到项目根）只能当它不存在，否则等于把观察关掉。
  const owned = [...new Set(await Promise.all([DATA_DIR, dirname(dbFile), RUNS_DIR, UPLOADS_DIR].map(canonicalPath)))]
    .filter((tree) => !contains(tree, root));
  const excludedFiles = new Set([db, `${db}-wal`, `${db}-shm`, `${db}-journal`]);
  const ignored = (path: string) => {
    if (excludedFiles.has(path) || owned.some((tree) => contains(tree, path))) return true;
    if (basename(path) === ".DS_Store") return true;
    const parts = relative(root, path).split(sep);
    // `.git` 里的东西不是项目文件，是 git 的记账：ash 轮询 `git status` 会刷新索引，别的任务在
    // 同一个仓库提交，用户自己的终端和编辑器也在跑 git。工作区里名叫 `.gitignore`、`index.lock`
    // 的普通文件不在此列，照常观察。
    if (parts[0] === ".git") return true;
    // 其他任务的工作树里持续有别的智能体在写，那是它们自己的工作区，不是这份检出的项目文件；
    // 逐条附注只会把真正有用的提示淹掉。项目本身就位于某个 .worktrees 里时不受影响——这里只看
    // 项目根以下的路径段。
    return parts.some((part, index) => part === ".worktrees" || (part === "worktrees" && parts[index - 1] === ".claude"));
  };
  const seen = new Set<string>();
  let more = false;
  let closed = false;
  let watcher: FSWatcher | undefined;
  // 观察器自身失效时不能把「没观察到」结算成「没有变化」：degraded 状态随 settle 返回，
  // 由调用方作为附注如实披露。仍不中止咨询——工具事件闸门不依赖这层。
  let degraded: string | undefined;
  const degrade = (reason: string, error?: unknown) => {
    if (!degraded) degraded = reason;
    console.warn(`[chat] ${reason}`, error ?? "");
  };
  // macOS 的 FSEvents 会把 watch 启动前一瞬的事件一并吐出来，只认事件会把咨询开始前的
  // 写入也记上；按 ctime 过滤，只报咨询期间真正发生的变化。路径已不存在（删除/改名）时
  // 逐级看父目录——删除一定会刷新父目录的 ctime。
  const beganAt = BigInt(Math.trunc((performance.timeOrigin + performance.now()) * 1000000));
  const changedSinceStart = async (path: string): Promise<boolean> => {
    try { return (await lstat(path, { bigint: true })).ctimeNs >= beganAt; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      return path === root || await changedSinceStart(dirname(path));
    }
  };
  const record = (local: string) => {
    if (seen.has(local)) return;
    if (seen.size >= 8) { more = true; return; }
    seen.add(local.slice(0, 180));
  };
  const pending = new Set<Promise<void>>();
  // 项目相关事件（滤掉 ash 自有/忽略树之后）每到一条就 +1：settle 的静默判据只看它。
  // 故意不数被忽略的事件——群聊的项目常常就是 ash 仓库本身，data/ 里的写入永不停歇，
  // 数上它们会让每次结算都拖到封顶并误报降级。
  let activity = 0;
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (closed) return;
      if (!filename) { activity++; degrade("目录观察收到缺少路径的变更事件"); return; }
      const path = resolve(root, filename.toString());
      const local = relative(root, path);
      if (!local || local.startsWith(`..${sep}`) || isAbsolute(local) || ignored(path)) return;
      activity++;
      if (seen.has(local)) return;
      const check = (async () => { if (await changedSinceStart(path)) record(local); })().catch(() => record(local));
      pending.add(check);
      void check.finally(() => pending.delete(check));
    });
    watcher.on("error", (error) => { degrade("目录观察中断", error); watcher?.close(); });
  } catch (error) {
    degrade("目录观察不可用", error);
  }
  if (watcher) await delay(WATCH_ARM_MS);
  const close = () => { closed = true; watcher?.close(); };
  return {
    async settle() {
      // 等事件流静默：每有项目相关事件就重置静默窗口，连续 SETTLE_QUIET_MS 无事件才收口；
      // 总时长封顶，封顶时事件仍在到达就如实降级——宁可披露「可能没记全」，不冒充「没有变化」。
      const deadline = Date.now() + SETTLE_MAX_MS;
      while (watcher && !closed) {
        const before = activity;
        await delay(SETTLE_QUIET_MS);
        while (pending.size) await Promise.all([...pending]);
        if (activity === before) break;
        if (Date.now() >= deadline) { degrade("目录观察结算超时（变更事件仍在持续到达）"); break; }
      }
      close();
      return { paths: [...seen], more, degraded };
    },
    close,
  };
}
