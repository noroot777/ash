import { existsSync, mkdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Hono } from "hono";
import type { ProjectView } from "@ash/shared";
import { repoNameFromUrl } from "@ash/shared/repo-url";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { execFileText } from "./exec.js";
import { id, now } from "./util.js";
import { expandHome, gitError, isEmptyDir, projectHealthLight, repoKey, tidyRepoPath } from "./git.js";
import { credentialInjection, saveProjectGitCredential } from "./git-credentials.js";
import { fail } from "./project-dir.js";

// 「从 Git 检出一个新项目」。项目那侧只有两条路会替用户动磁盘：这一条，和 POST /projects
// 显式带 `createDir` 时那一条（它只是 mkdir，见 project-dir.ts）。剩下的入口
// （/projects/resolve、PATCH）都只往库里记一行路径字符串，目录不存在也照记不误。
// 这条路最重，五条决定：
//
// ① **绝不往非空目录里克隆。** git 自己也拒绝，但它的报错是英文的一行，而这里能在
//    动手前就分清「路径已被占」和「已经有项目登记在这」两种情况，给中文原因。
// ② **无人值守 = 不能有任何交互提示。** 私有仓库没配好凭据时，https 会问用户名密码、
//    ssh 会问 passphrase 或首次连接的 host key 确认 —— 服务端没有终端，这些提示会把
//    请求永久挂住（同 git-project-ops.ts 的 NET_OPTIONS）。两条通道都要按死。
// ③ **失败不留半个坑。** clone 中途断网/鉴权失败会在目标路径留下一个残缺的仓库；
//    只有「这次是我们建出来的」才删，用户原本就存在的空目录留着不动。这条对**上级目录**
//    同样成立：`mkdir -p` 可能一口气造出好几层，失败后它们全是空壳，得原路退回去。
// ④ **克隆完才写库。** 项目行是成功的凭据，不是意图的记录 —— 先写库再克隆的话，一次
//    失败就在侧边栏留下一个指向空路径的项目，比没创建更难收拾。
// ⑤ **凭证得能在克隆这一刻用上。** 私有仓库正是最需要它的地方，而项目级凭证存在项目行
//    上、项目行又要等克隆成功才写 —— 先有鸡还是先有蛋。解法是让调用方把用户现填的那对
//    直接递进来：克隆时当场注入，成功之后再存到刚建出来的项目上（见 `saveCredential`）。

const exec = execFileText;

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
  /** 私有 HTTPS 仓库的用户名 + 令牌。两者都填才生效，克隆成功后会存到新项目上。 */
  username?: string | null;
  secret?: string | null;
}

/**
 * 从 `dir` 一路往上，收集这一刻**还不存在**的祖先，最深的排在前面 —— 也就是待会儿
 * `mkdir -p` 会替我们造出来的那几层。失败时照这个顺序退回去。
 */
function missingAncestors(dir: string): string[] {
  const missing: string[] = [];
  let cursor = dir;
  while (cursor && !existsSync(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break; // 到根了
    cursor = parent;
  }
  return missing;
}

/**
 * 退回 `missingAncestors` 记下的那几层。用 `rmdirSync` 而不是 `rmSync(recursive)`：
 * 非空就让它失败 —— 万一在这中间有别的东西落进去（并发的另一次创建、用户手动放的文件），
 * 宁可留着空壳也不能递归删掉别人的东西。一层删不掉，它上面几层必然也非空，直接收手。
 */
function undoAncestors(created: string[]): void {
  for (const dir of created) {
    try { rmdirSync(dir); } catch { return; }
  }
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
  // 留在我们自己手里。造之前先记下这次会造出哪几层，失败时照着退（决定 ③）。
  const createdDirs = missingAncestors(dirname(target));
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (error) {
    undoAncestors(createdDirs);
    throw fail(`建不出上级目录：${(error as Error).message}`);
  }

  // 凭证走 env，令牌不进 argv（同 git-credentials.ts）。`-c` 只有排在子命令前面才算数。
  const injection = credentialInjection(input.username, input.secret);
  const args = [
    ...injection.args,
    "clone",
    ...(branch ? ["--branch", branch] : []),
    "--", url, target,
  ];
  try {
    await exec("git", args, {
      env: { ...cloneEnv(), ...injection.env },
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    // ③ 只收拾自己造的：用户原本就有的空目录留在原地。
    if (!preExisted) rmSync(target, { recursive: true, force: true });
    undoAncestors(createdDirs);
    const killed = (error as { killed?: boolean }).killed;
    throw fail(killed ? "克隆超时（超过 15 分钟）" : `克隆失败：${gitError(error)}`);
  }

  const name = (input.name ?? "").trim() || repoNameFromUrl(url) || "project";
  const row = { id: id(), name, repoPath: stored, apiKeys: null, workflowId: null, createdAt: now() };
  await db.insert(projects).values(row);
  // 刚才那对凭证存到新项目上：克隆能连上，后面的 fetch/pull/push 就也该能连上，不该让
  // 用户在项目设置里把同一个令牌再填一遍。存不下去不回滚克隆 —— 仓库已经在磁盘上了，
  // 少一条凭证是「去设置里补一次」，回滚掉整个克隆才是真的损失。
  if (injection.args.length) {
    try { await saveProjectGitCredential(row.id, input.username ?? "", input.secret ?? ""); }
    catch { /* 项目照常返回；设置页里还能再配 */ }
  }
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
