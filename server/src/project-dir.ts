import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { expandHome } from "./git.js";

// 「替用户在服务端这台机器上造一个目录」。项目那侧有两条路会用到它（POST /projects 的
// `createDir`、克隆那条的父目录），它们的共同点是：**动手改磁盘**，所以判定和措辞都得
// 在一处说死，别在两个路由里各写一遍各自的 mkdir。
//
// 造目录必须**由调用方显式要求**，不能因为「路径不存在」就顺手建：同一个 POST /projects
// 也服务 MCP 和手机端，那边路径写错或没填只意味着「还没填好」，替它建出来只会在磁盘上
// 攒下一堆打错字的空目录。所以 `createDir` 是个标志位，由知道用户看见过「这个目录不
// 存在」这句话的界面来带。

/** 带 HTTP 状态码的错误，路由层照着回。 */
export function fail(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * 确保 `repoPath` 是一个存在的目录，不存在就连同缺失的上级一起建出来。已经是目录时什么
 * 都不做（幂等），所以调用方不必先探一次存在性。
 *
 * 相对路径一律拒绝：这条路径落在**服务端**那台机器上，相对谁都说不清，而 mkdir 会照着
 * server 的工作目录建出一个谁也找不到的目录。
 */
export function ensureProjectDir(repoPath: string): void {
  const stored = (repoPath ?? "").trim();
  if (!stored) throw fail("工作目录不能为空");
  const dir = expandHome(stored);
  if (!isAbsolute(dir)) throw fail("工作目录要写绝对路径（服务端这台机器上的路径）");
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw fail("这条路径已经被一个文件占用了", 409);
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw fail(`建不出目录：${(error as Error).message}`);
  }
}
