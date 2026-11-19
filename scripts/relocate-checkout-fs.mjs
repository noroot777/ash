// 本地目录迁移的读盘小工具。共同的口径是**「读不到」要分清两种**：确实不存在（ENOENT/ENOTDIR，
// 正常形态）和读不动（权限、I/O、命令缺失或失败）。后一种记进 errors 而不是当成空 —— 清点的下游是
// 「可以开始搬了」，一份没读出来的进程表、会话目录或锁文件被当成「没有」，等于在不知情时放行。
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";

export const absent = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";

/** lstat；确实不存在返回 null，读不动（权限、I/O）直接抛 —— 调用方不许把它当成「没有」。 */
function lstatOrNull(p) {
  try { return lstatSync(p); }
  catch (error) {
    if (absent(error)) return null;
    throw new Error(`读不了 ${p} 的元数据（${error.code ?? error.message}）`);
  }
}
export const lexists = (p) => lstatOrNull(p) !== null;
export const isDirNoFollow = (p) => lstatOrNull(p)?.isDirectory() ?? false;
export const isLink = (p) => lstatOrNull(p)?.isSymbolicLink() ?? false;

/** 文件正文；不存在返回 null，读不动记一条错误再返回 null。 */
export function readTextOr(file, errors) {
  try { return readFileSync(file, "utf8"); }
  catch (error) {
    if (!absent(error)) errors.push(`读不了 ${file}（${error.code ?? error.message}）`);
    return null;
  }
}

/** 目录里的名字；不存在返回 []，读不动记一条错误再返回 []。 */
export function listDir(dir, errors, opts) {
  try { return readdirSync(dir, opts); }
  catch (error) {
    if (!absent(error)) errors.push(`列不了 ${dir}（${error.code ?? error.message}）`);
    return [];
  }
}

/**
 * 跑一条外部命令，退出码在 okCodes 里才算答上来了；命令不存在、被信号杀掉、退出码不对都记成错误
 * 并返回 null。`what` 是写进错误里的那半句（「列进程的工作目录」）。
 */
export function sh(cmd, args, errors, { what = cmd, okCodes = [0], ...opts } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
  if (r.error) { errors.push(`${what}失败：${cmd} ${r.error.code === "ENOENT" ? "不在 PATH 里" : r.error.message}`); return null; }
  if (!okCodes.includes(r.status)) {
    errors.push(`${what}失败：${cmd} 退出码 ${r.status ?? r.signal}${r.stderr?.trim() ? `（${r.stderr.trim().split("\n")[0].slice(0, 160)}）` : ""}`);
    return null;
  }
  return r;
}
