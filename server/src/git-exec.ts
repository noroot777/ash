import { spawn } from "node:child_process";

// 带上限的 git stdout 读取。原本长在 git-diff.ts 里只服务分支 diff，工作区 SCM 面板
// 要读的单文件 diff 有同样的诉求（一个 minified 产物就能顶出几十 MB），所以抽出来共用。
//
// `allowExitCodes` 是为 `git diff --no-index` 加的：它拿「有没有差异」当退出码用，
// **有差异就是 1**，按 0 判成功会把每一个未跟踪文件的预览都判成失败。

const STDERR_LIMIT = 64 * 1024;

export interface CappedStdout {
  text: string;
  truncated: boolean;
}

export function cappedGitStdout(
  repo: string,
  args: string[],
  limitBytes: number,
  allowExitCodes: readonly number[] = [0],
): Promise<CappedStdout> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (size >= limitBytes) {
        truncated = true;
        return;
      }
      const remaining = limitBytes - size;
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      size += kept.length;
      if (kept.length < chunk.length) truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorSize >= STDERR_LIMIT) return;
      const kept = chunk.subarray(0, STDERR_LIMIT - errorSize);
      errors.push(kept);
      errorSize += kept.length;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      // 截断时进程多半是被下游背压顶住后自己结束的，退出码不足为凭：已经决定只要
      // 前 N 字节，就别再让退出码把这段内容判掉。
      if (truncated || allowExitCodes.includes(code ?? -1)) {
        resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated });
        return;
      }
      reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `git exited ${code}`));
    });
  });
}
