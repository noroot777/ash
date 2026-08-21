import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Hono } from "hono";
import type { ProjectView } from "@ash/shared";
import { repoNameFromUrl } from "@ash/shared/repo-url";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { id, now } from "./util.js";
import { expandHome, gitError, isEmptyDir, projectHealthLight, repoKey, tidyRepoPath } from "./git.js";
import { fail } from "./project-dir.js";

// 「从 Git 检出一个新项目」。项目那侧只有两条路会替用户动磁盘：这一条，和 POST /projects
// 显式带 `createDir` 时那一条（它只是 mkdir，见 project-dir.ts）。剩下的入口
// （/projects/resolve、PATCH）都只往库里记一行路径字符串，目录不存在也照记不误。
// 这条路最重，四条决定：
//
// ① **绝不往非空目录里克隆。** git 自己也拒绝，但它的报错是英文的一行，而这里能在
//    动手前就分清「路径已被占」和「已经有项目登记在这」两种情况，给中文原因。
// ② **无人值守 = 不能有任何交互提示。** 私有仓库没配好凭据时，https 会问用户名密码、
//    ssh 会问 passphrase 或首次连接的 host key 确认 —— 服务端没有终端，这些提示会把
//    请求永久挂住（同 git-project-ops.ts 的 NET_OPTIONS）。两条通道都要按死。
// ③ **失败不留半个坑。** clone 中途断网/鉴权失败会在目标路径留下一个残缺的仓库；
//    只有「这次是我们建出来的」才删，用户原本就存在的空目录留着不动。
// ④ **克隆完才写库。** 项目行是成功的凭据，不是意图的记录 —— 先写库再克隆的话，一次
//    失败就在侧边栏留下一个指向空路径的项目，比没创建更难收拾。

const exec = promisify(execFile);

/** 克隆可能很慢（大仓库 + 慢网络），但也不能没有上限：请求挂着的是一个 HTTP 连接。 */
const CLONE_TIMEOUT_MS = 15 * 60_000;

/**
 * 联网 + 无终端的执行参数。`GIT_TERMINAL_PROMPT=0` 管 https 那条（凭据提示直接失败
 * 而不是等输入）；`GIT_SSH_COMMAND` 里的 `BatchMode=yes` 管 ssh 那条（passphrase 和
 * host key 确认一律不问，直接报错退出）。用户自己配了 GIT_SSH_COMMAND 就尊重他的。
 */
function cloneEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
  };
}

/**
 * git 的参数里，`-` 开头的东西一律当选项解析。仓库地址和分支名都是用户可控的自由文本，
 * 不挡的话 `--upload-pack=...` 这类写法就能让服务端执行任意命令。地址那侧另外还有 `--`
 * 分隔符兜底，分支名没有等价物，所以统一在这里挡。
 */
function assertNotFlag(value: string, what: string): void {
  if (value.startsWith("-")) throw fail(`${what}不能以 - 开头`);
}

export interface CloneProjectInput {
  url: string;
  /** 克隆到哪 —— 完整目标路径（父目录 + 目录名），不是父目录。 */
  targetPath: string;
  /** 只检出这一条分支（空 = 用远端默认分支）。 */
  branch?: string | null;
  /** 项目名（空则取目标目录名）。 */
  name?: string | null;
}

export async function cloneProject(input: CloneProjectInput): Promise<ProjectView> {
  const url = (input.url ?? "").trim();
  if (!url) throw fail("仓库地址不能为空");
  assertNotFlag(url, "仓库地址");

  const stored = tidyRepoPath(input.targetPath);
  if (!stored) throw fail("克隆目录不能为空");
  const target = expandHome(stored);
  if (!isAbsolute(target)) throw fail("克隆目录要写绝对路径（服务端这台机器上的路径）");

  const branch = (input.branch ?? "").trim();
  if (branch) assertNotFlag(branch, "分支名");

  // 已经有项目登记在这条路径上 —— 克隆下去要么撞非空目录、要么造出第二个同仓库项目，
  // 两种都不是用户想要的，在动手之前就说清楚。
  const key = repoKey(stored);
  const clash = (await db.select().from(projects)).find((p) => key && repoKey(p.repoPath) === key);
  if (clash) throw fail(`这个目录已经登记为项目「${clash.name}」了`, 409);

  const preExisted = existsSync(target);
  if (preExisted) {
    if (!statSync(target).isDirectory()) throw fail("目标路径已被一个文件占用", 409);
    if (!isEmptyDir(target)) throw fail("目标目录已存在且不是空的；请换一个目录名", 409);
  }

  // 父目录不存在就建出来 —— 「支持创建不存在的目录」正是这条路存在的理由。git clone 自己
  // 也会补建，但它失败时报的是路径错误，先建能把「盘符打错 / 没有写权限」这类问题的报错
  // 留在我们自己手里。
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (error) {
    throw fail(`建不出上级目录：${(error as Error).message}`);
  }

  const args = ["clone", ...(branch ? ["--branch", branch] : []), "--", url, target];
  try {
    await exec("git", args, { env: cloneEnv(), timeout: CLONE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    // ③ 只收拾自己造的：用户原本就有的空目录留在原地。
    if (!preExisted) rmSync(target, { recursive: true, force: true });
    const killed = (error as { killed?: boolean }).killed;
    throw fail(killed ? "克隆超时（超过 15 分钟）" : `克隆失败：${gitError(error)}`);
  }

  const name = (input.name ?? "").trim() || repoNameFromUrl(url) || "project";
  const row = { id: id(), name, repoPath: stored, apiKeys: null, workflowId: null, createdAt: now() };
  await db.insert(projects).values(row);
  return { ...row, health: projectHealthLight(row.repoPath) };
}

export function mountProjectCloneRoutes(api: Hono): void {
  api.post("/projects/clone", async (c) => {
    const body = await c.req.json<CloneProjectInput>();
    try {
      return c.json(await cloneProject(body), 201);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      return c.json({ error: (error as Error).message }, status as 400);
    }
  });
}
