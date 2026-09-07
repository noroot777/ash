import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "@ash/shared";
import { resolveAshDbFile } from "../db/path.js";
import { RUNS_DIR } from "../paths.js";

export class ChatBoundaryError extends Error {
  constructor(reason: string) {
    super(`咨询已中止：${reason}。可能已有副作用，请检查项目；未自动撤销改动，也未创建或启动任务。需要执行工作时请明确委派。`);
    this.name = "ChatBoundaryError";
  }
}

function readCommand(command: string, depth = 0): boolean {
  if (depth > 1 || !command.trim() || /[\n\r;&|<>$`\\]/u.test(command)) return false;
  const tokens = command.match(/'[^']*'|"[^"]*"|[^\s'"\u0060]+/gu) ?? [];
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

async function stamp(path: string, shallow = false): Promise<string | null> {
  try {
    const stat = await lstat(path, { bigint: true });
    if (stat.isDirectory()) return shallow ? `directory:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}` : `directory:${stat.mode}`;
    const link = stat.isSymbolicLink() ? await readlink(path) : "";
    return `${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${link}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

export async function watchChatWorkspace(cwd: string, onViolation: (error: ChatBoundaryError) => void) {
  const root = await realpath(cwd);
  const dbFile = resolveAshDbFile();
  const db = join(await realpath(dirname(dbFile)), basename(dbFile));
  const runs = await canonicalPath(RUNS_DIR);
  const excludedFiles = new Set([db, `${db}-wal`, `${db}-shm`, `${db}-journal`]);
  const ignored = (path: string) => excludedFiles.has(path) || path === runs || path.startsWith(`${runs}${sep}`);
  const shallow = (path: string) => {
    const parts = relative(root, path).split(sep);
    return parts.some((part, index) => part === "node_modules" || part === ".worktrees" || (part === "worktrees" && parts[index - 1] === ".claude"));
  };
  const snapshot = async () => {
    const result = new Map<string, string>();
    const visit = async (path: string): Promise<void> => {
      if (ignored(path)) return;
      if (result.size >= 200000) throw new Error("项目条目过多，无法完整监测");
      const value = await stamp(path, shallow(path));
      if (value === null) return;
      result.set(relative(root, path), value);
      if (value.startsWith("directory:") && !shallow(path)) {
        for (const name of await readdir(path)) await visit(join(path, name));
      }
    };
    await visit(root);
    if (!result.has("")) throw new Error("项目目录不可读取");
    return result;
  };
  const before = await snapshot().catch(() => { throw new ChatBoundaryError("无法建立完整的目录基线，未启动智能体"); });
  const beganAt = BigInt(Math.trunc((performance.timeOrigin + performance.now()) * 1000000));
  const changedSinceStart = async (path: string): Promise<boolean> => {
    try { return (await lstat(path, { bigint: true })).ctimeNs >= beganAt; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return path === root || await changedSinceStart(dirname(path));
    }
  };
  let violation: ChatBoundaryError | undefined;
  let closed = false;
  const pending = new Set<Promise<void>>();
  const fail = (reason: string) => {
    if (violation) return;
    violation = new ChatBoundaryError(reason);
    onViolation(violation);
  };
  const changed = (path: string) => fail(`检测到咨询期间项目文件变化（${JSON.stringify(path.slice(0, 180) || ".")}）；变更来源可能是智能体或其他并发操作`);
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (event, filename) => {
      if (closed) return;
      if (!filename) { fail("目录监测未提供变更路径，无法确认本轮只读"); return; }
      const path = resolve(root, filename.toString());
      const local = relative(root, path);
      if (local.startsWith(`..${sep}`) || isAbsolute(local) || ignored(path)) return;
      const check = (async () => {
        if (shallow(path) || event === "rename") {
          if (await changedSinceStart(path)) changed(local);
        } else if (before.get(local) !== (await stamp(path) ?? undefined)) changed(local);
      })().catch(() => fail("目录监测失败，无法确认本轮只读"));
      pending.add(check);
      void check.finally(() => pending.delete(check));
    });
  } catch { throw new ChatBoundaryError("无法启动目录监测，未启动智能体"); }
  watcher.on("error", () => fail("目录监测中断，无法确认本轮只读"));
  return {
    async finish() {
      try {
        await delay(100);
        const after = await snapshot();
        for (const path of new Set([...before.keys(), ...after.keys()])) {
          if (before.get(path) !== after.get(path)) { changed(path); break; }
        }
        while (pending.size) await Promise.all([...pending]);
      } catch { fail("结束时无法核对项目目录，不能将本轮记为正常咨询"); }
      return violation;
    },
    close() { closed = true; watcher.close(); },
  };
}
