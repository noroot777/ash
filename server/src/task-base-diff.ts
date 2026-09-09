import { spawn } from "node:child_process";
import { cappedGitStdout } from "./git-exec.js";

const FILE_PREVIEW_LIMIT = 1000;

// 清单按 NUL 分隔流式计数，预览只保留前 1000 个路径；规模不再由 exec 的缓冲上限决定。
async function recoveryFiles(repo: string, base: string, current: string): Promise<{ files: string[]; fileCount: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, "diff", "--name-only", "-z", base, current], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const files: string[] = [];
    let fileCount = 0;
    let pending = "";
    let error = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const fields = (pending + chunk).split("\0");
      pending = fields.pop()!;
      for (const path of fields) {
        if (files.length < FILE_PREVIEW_LIMIT) files.push(path);
        fileCount++;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { error = (error + chunk).slice(0, 4096); });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0 || pending) reject(new Error(error || "恢复文件清单未完整读取"));
      else resolve({ files, fileCount });
    });
  });
}

export async function recoveryDiff(repo: string, base: string, current: string) {
  const [listing, patch] = await Promise.all([
    recoveryFiles(repo, base, current),
    cappedGitStdout(repo, ["diff", "--no-ext-diff", "--no-color", "--unified=3", base, current], 128 * 1024),
  ]);
  return { ...listing, diff: patch.text, truncated: patch.truncated };
}
