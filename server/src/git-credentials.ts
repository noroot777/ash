import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projectGitCredentials } from "./db/schema.js";
import { ScmOperationError } from "./scm-paths.js";

// 项目级的 HTTPS git 凭证：用户名 + 令牌/密码。「同一台机器上，A 项目推到公司 GitLab、
// B 项目推到个人 GitHub」是这个模块存在的全部理由。
//
// 三条决定：
//
// ① **不写进仓库的 .git/config。** 提交署名和 SSH key 走那条路（`git-identity.ts`），
//    因为它们本来就该被 agent 和用户的终端看见。令牌相反：`.git/config` 是明文，被所有
//    worktree 共享，`git config --list` 一打就出来，agent 读得到。所以它只存 ash 自己的库。
//
// ② **令牌只写不读。** 读侧只报用户名和「配没配」（`ProjectGitCredentialView`）。前端
//    没有任何路径能把它取回来 —— 一个存下去就再也拿不回来的密码框，比一个能被截图、被
//    复制走的明文框安全得多，而用户也从来不需要「看一眼我存的是什么」，只需要「换一个」。
//
// ③ **令牌绝不进 argv。** `git -c credential.helper=…` 里放的是一段引用环境变量的 shell
//    片段，值本身走 env 递进去（`ps` 看不到，也不会落进 sessions.command_line）。这跟
//    server/CLAUDE.md 那条「密钥绝不进 argv」是同一条规矩。
//
// 已知边界：`git` 用 `sh` 执行 `!` 开头的 helper。macOS/Linux 天然有；Windows 上由
// Git for Windows 自带的 sh 提供 —— 装了 git 就有，所以没有单独的降级分支。

/** 前端拿得到的全部：谁、什么时候配的。令牌本身永远不出现在这里。 */
export interface ProjectGitCredentialView {
  username: string;
  configured: true;
  updatedAt: string;
}

/** 注入到一次 git 网络命令上的东西。没配凭证时两个都是空的，调用方无需分支。 */
export interface GitNetInjection {
  args: string[];
  env: NodeJS.ProcessEnv;
}

const USERNAME_ENV = "ASH_GIT_USERNAME";
const SECRET_ENV = "ASH_GIT_PASSWORD";

/**
 * 喂给 `credential.helper` 的 shell 片段。
 *
 * · `printf` 而不是 `echo`：令牌里出现空格或反斜杠时，不加引号的 `echo $VAR` 会被 shell
 *   拆词，拆出来的东西悄悄地不等于用户存进去的那个。
 * · 只答 `get`：`store` / `erase` 什么都不做且照样退出 0，否则 git 会拿 helper 的非零
 *   退出码当成一次真失败报出来。
 */
export const CREDENTIAL_HELPER_SNIPPET =
  `!f() { if test "$1" = get; then printf 'username=%s\\npassword=%s\\n' `
  + `"$${USERNAME_ENV}" "$${SECRET_ENV}"; fi; }; f`;

export async function readProjectGitCredential(projectId: string): Promise<ProjectGitCredentialView | null> {
  const row = (await db.select().from(projectGitCredentials)
    .where(eq(projectGitCredentials.projectId, projectId))).at(0);
  return row ? { username: row.username, configured: true, updatedAt: row.updatedAt } : null;
}

/**
 * 存/改凭证。
 *
 * `secret` 留空 = **沿用已存的那个**。这不是省事，是补上「令牌只写不读」缺的那一半：
 * 用户名打错了想改回来时，界面上那个密码框是空的（它读不到旧值），要求重填令牌等于
 * 逼着用户回去翻一遍 GitHub。没存过的项目留空则是真的没东西可用，直接拒绝。
 */
export async function saveProjectGitCredential(
  projectId: string,
  username: string,
  secret: string,
): Promise<ProjectGitCredentialView> {
  const user = username.trim();
  if (!user) throw new ScmOperationError("用户名不能为空", 400);
  const existing = (await db.select().from(projectGitCredentials)
    .where(eq(projectGitCredentials.projectId, projectId))).at(0);
  const kept = secret ? secret : existing?.secret ?? "";
  if (!kept) throw new ScmOperationError("这个项目还没存过令牌，请把令牌一并填上", 400);
  const updatedAt = new Date().toISOString();
  const row = { projectId, username: user, secret: kept, updatedAt };
  if (existing) {
    await db.update(projectGitCredentials).set(row)
      .where(eq(projectGitCredentials.projectId, projectId));
  } else {
    await db.insert(projectGitCredentials).values(row);
  }
  return { username: user, configured: true, updatedAt };
}

export async function deleteProjectGitCredential(projectId: string): Promise<void> {
  await db.delete(projectGitCredentials).where(eq(projectGitCredentials.projectId, projectId));
}

const EMPTY_INJECTION: GitNetInjection = { args: [], env: {} };

/**
 * 把一对「用户名 + 令牌」配成一次 git 网络命令的注入。两者缺一就什么都不注入。
 *
 * 先那个**空的** `-c credential.helper=` 不是笔误：它清掉继承来的全局 helper
 * （macOS 钥匙串、Windows 的 manager-core）。不清的话，系统里那份旧凭证会抢在前面答，
 * 于是「我在项目里换了账号，推上去还是老账号」——而且报的错跟凭证毫无关系。
 *
 * 单独一个函数是因为有两个来源：**已登记的项目**从库里取（`gitNetInjection`），而
 * **克隆**那一刻项目行还不存在，只能由调用方把用户现填的那对直接递进来。
 */
export function credentialInjection(
  username: string | null | undefined,
  secret: string | null | undefined,
): GitNetInjection {
  const user = (username ?? "").trim();
  if (!user || !secret) return EMPTY_INJECTION;
  return {
    args: ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER_SNIPPET}`],
    env: { [USERNAME_ENV]: user, [SECRET_ENV]: secret },
  };
}

/**
 * 给一次 git 网络命令配上这个项目的凭证。没配就原样返回空的，调用方一律 `...spread`。
 */
export async function gitNetInjection(projectId: string | null | undefined): Promise<GitNetInjection> {
  if (!projectId) return EMPTY_INJECTION;
  const row = (await db.select().from(projectGitCredentials)
    .where(eq(projectGitCredentials.projectId, projectId))).at(0);
  return row ? credentialInjection(row.username, row.secret) : EMPTY_INJECTION;
}
