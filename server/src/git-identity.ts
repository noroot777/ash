import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expandHome, isGitRepo } from "./git.js";
import { ScmOperationError } from "./scm-paths.js";

// 项目的 git **身份**：提交署名（user.name / user.email）和走 SSH 时用哪把私钥
// （core.sshCommand）。
//
// 贯穿这个文件的一条决定：**这三样存在仓库自己的 `.git/config` 里，ash 不另存一份。**
// 理由不是省事，是「只能有一份真相」——
//   · agent 在 worktree 里跑 `git commit` 用的是仓库 config，ash 存在自己库里的值它读不到；
//   · 用户在终端里 `git config user.email` 看到的必须和界面上写的是同一个值；
//   · worktree 共享主仓的 `.git/config`，所以在项目上配一次，所有任务工作区都跟着生效。
// 反过来说，这里的写操作是**真的在改用户的仓库**，所以只认白名单里这三个键，值也由这边
// 拼（见 `sshCommandFor`），不给「往 config 里写任意键值」的通道。
//
// HTTPS 的用户名 / 令牌**不在**这里 —— 那个不能进仓库 config（明文、被所有 worktree 和
// agent 读得到、`git config --list` 一打就出来），见 `git-credentials.ts`。

const exec = promisify(execFile);
const CONFIG_TIMEOUT_MS = 15_000;

/** 一个配置项的现值，外加「这个值是这个仓库自己设的，还是从全局/系统继承来的」。 */
export interface GitConfigValue {
  value: string | null;
  /** `local` = 写在这个仓库的 .git/config 里；`inherited` = 来自 --global/--system。 */
  scope: "local" | "inherited" | null;
}

export interface GitRemoteInfo {
  name: string;
  /** 已脱敏：URL 里内嵌的密码换成 `***`（见 `redactRemoteUrl`）。 */
  url: string;
  /** 走 HTTPS 的远端才用得上用户名/令牌那套凭证；SSH 远端配了也不会被用到。 */
  https: boolean;
}

export interface ProjectGitIdentity {
  isRepo: boolean;
  userName: GitConfigValue;
  userEmail: GitConfigValue;
  /** 私钥路径。仓库里的 core.sshCommand 不是 ash 拼的那种形状时为 null，见 `sshKeyPath`。 */
  sshKeyPath: string | null;
  /** core.sshCommand 的原文；认不出形状时前端照原样只读展示，不假装能编辑它。 */
  sshCommand: GitConfigValue;
  remotes: GitRemoteInfo[];
}

/** 能改的就这三个键。白名单是硬闸：写侧只接受这里出现过的键。 */
const WRITABLE_KEYS = ["user.name", "user.email", "core.sshCommand"] as const;
export type WritableGitConfigKey = (typeof WRITABLE_KEYS)[number];

async function readConfig(root: string, key: string, local: boolean): Promise<string | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", root, "config", ...(local ? ["--local"] : []), "--get", key],
      { timeout: CONFIG_TIMEOUT_MS },
    );
    return stdout.replace(/\r?\n$/, "") || null;
  } catch {
    // `--get` 在「这个键没设」时退出码就是 1，跟真出错分不开，也不需要分开：
    // 两种情况下这个键都给不出值。
    return null;
  }
}

async function readValue(root: string, key: string): Promise<GitConfigValue> {
  const [local, effective] = await Promise.all([
    readConfig(root, key, true),
    readConfig(root, key, false),
  ]);
  if (local !== null) return { value: local, scope: "local" };
  if (effective !== null) return { value: effective, scope: "inherited" };
  return { value: null, scope: null };
}

/**
 * 把 URL 里内嵌的密码抹掉再往外送。`https://user:ghp_xxx@github.com/o/r.git` 这种写法在
 * 存量仓库里并不罕见（`git clone https://token@...` 会留下它），而项目设置页是会被截图、
 * 会被投屏的地方。用户名留着 —— 它是「这个远端现在用谁的身份」的关键信息。
 */
export function redactRemoteUrl(raw: string): string {
  return raw.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@]*)@/, (_all, scheme: string, auth: string) => {
    const user = auth.split(":")[0] ?? "";
    return auth.includes(":") ? `${scheme}${user}:***@` : `${scheme}${user}@`;
  });
}

/** `git remote -v` 会把同一个远端报两遍（fetch/push），按名字去重，取第一条。 */
export async function readRemotes(root: string): Promise<GitRemoteInfo[]> {
  let stdout = "";
  try {
    ({ stdout } = await exec("git", ["-C", root, "remote", "-v"], { timeout: CONFIG_TIMEOUT_MS }));
  } catch {
    return [];
  }
  const seen = new Map<string, GitRemoteInfo>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)/.exec(line.trim());
    if (!match) continue;
    const [, name, url] = match as unknown as [string, string, string];
    if (seen.has(name)) continue;
    seen.set(name, { name, url: redactRemoteUrl(url), https: /^https?:\/\//i.test(url) });
  }
  return [...seen.values()];
}

/**
 * ash 拼出来的 sshCommand 长这样，反过来也只认这一种形状。
 * `IdentitiesOnly=yes` 不是可选项：不加它，ssh 会先把 agent 里已加载的所有身份挨个试一遍，
 * 「配了这把 key 却仍然用着另一个账号推上去」就是这么来的。
 */
export function sshCommandFor(keyPath: string): string {
  return `ssh -i "${keyPath}" -o IdentitiesOnly=yes`;
}

/** 从 core.sshCommand 里认出私钥路径；不是 ash 拼的那种形状就返回 null（原样保留，不动它）。 */
export function sshKeyPath(command: string | null): string | null {
  if (!command) return null;
  const match = /^ssh -i "([^"]+)" -o IdentitiesOnly=yes$/.exec(command.trim());
  return match ? match[1]! : null;
}

/**
 * 私钥路径要拼进 core.sshCommand（git 按 shell 规则拆它），所以带引号或换行的路径一律
 * 拒绝，而不是想办法转义 —— 那条路上一个疏漏就等于让配置项变成一条可执行命令。
 */
export function checkSshKeyPath(raw: string): string {
  const path = raw.trim();
  if (!path) return path;
  if (/["\n\r]/.test(path)) throw new ScmOperationError("私钥路径里不能有引号或换行", 400);
  return path;
}

export async function readGitIdentity(repoPath: string | null | undefined): Promise<ProjectGitIdentity> {
  const root = expandHome(repoPath ?? "");
  const empty: ProjectGitIdentity = {
    isRepo: false,
    userName: { value: null, scope: null },
    userEmail: { value: null, scope: null },
    sshKeyPath: null,
    sshCommand: { value: null, scope: null },
    remotes: [],
  };
  if (!root || !(await isGitRepo(root))) return empty;
  const [userName, userEmail, sshCommand, remotes] = await Promise.all([
    readValue(root, "user.name"),
    readValue(root, "user.email"),
    readValue(root, "core.sshCommand"),
    readRemotes(root),
  ]);
  return { isRepo: true, userName, userEmail, sshKeyPath: sshKeyPath(sshCommand.value), sshCommand, remotes };
}

/**
 * 写这三个键。**空字符串 = `--unset`**，也就是「把这个仓库自己的设置删掉，回去跟着全局
 * 走」—— 界面上清空一个输入框，用户想的就是这件事，写一个空值进去只会让 git 拿空署名去
 * 提交。`undefined` 则是「这次没动它」，两者不能混。
 */
export async function writeGitIdentity(
  repoPath: string | null | undefined,
  patch: Partial<Record<WritableGitConfigKey, string>>,
): Promise<ProjectGitIdentity> {
  const root = expandHome(repoPath ?? "");
  if (!root || !(await isGitRepo(root))) {
    throw new ScmOperationError("这个项目目录不是 Git 仓库，没法设置提交身份。", 409);
  }
  for (const [key, next] of Object.entries(patch) as [WritableGitConfigKey, string][]) {
    if (next === undefined) continue;
    if (!WRITABLE_KEYS.includes(key)) throw new ScmOperationError(`不允许设置 ${key}`, 400);
    const value = next.trim();
    try {
      await exec(
        "git",
        value
          ? ["-C", root, "config", "--local", key, value]
          : ["-C", root, "config", "--local", "--unset-all", key],
        { timeout: CONFIG_TIMEOUT_MS },
      );
    } catch (error) {
      // `--unset-all` 在「本来就没设」时退出码 5。那正是调用方想要的终态，不是失败。
      const code = (error as { code?: number }).code;
      if (!value && code === 5) continue;
      throw new ScmOperationError(`写入 ${key} 失败：${(error as Error).message.split("\n")[0]}`, 409);
    }
  }
  return readGitIdentity(repoPath);
}
