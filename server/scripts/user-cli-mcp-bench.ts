// 个人 CLI 配置目录那两条回归链(`test-user-cli-mcp.ts` 和 `codex-approve-cases.ts`)共用的
// 脚手架:**假 HOME** 加上「问 codex 本人」那一问的替身。
//
// 为什么单独一个文件:那两条链都要这副脚手架,而入口文件已经顶到单文件 700 行的上限
// (2026-10-31 审查 F3)。这里只有搭台子的东西,一条断言都不放。
//
// 全程用假 HOME:宿主机真实的 `~/.claude.json` / `~/.codex/config.toml` 是用户的配置,
// 一个字节都不许动;用真 HOME 跑的话,「补对了」和「它偷偷读写了宿主」看起来一模一样。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbeOutcome } from "../src/ash-mcp-probe.js";
import { ensureAshMcp, type CodexAsk } from "../src/auth/user-cli-mcp.js";
import { resolveLaunch } from "../src/executors/bin-resolve.js";
import { REPO_DIR } from "../src/paths.js";


export const stage = mkdtempSync(join(tmpdir(), "ash-user-cli-mcp-"));
process.on("exit", () => rmSync(stage, { recursive: true, force: true }));

/** 每一格都拿一副全新的「假 HOME + 个人目录」,免得前一格的写入影响后一格。 */
let seq = 0;
export function bench(hostFiles: { claude?: string; codex?: string } = {}) {
  const root = join(stage, `case-${++seq}`);
  const host = join(root, "home");
  const dir = join(root, "user-cli");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(host, ".codex"), { recursive: true });
  if (hostFiles.claude !== undefined) writeFileSync(join(host, ".claude.json"), hostFiles.claude, "utf8");
  if (hostFiles.codex !== undefined) writeFileSync(join(host, ".codex", "config.toml"), hostFiles.codex, "utf8");
  return { host, dir };
}

export const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

// ── 「问 codex 本人」那一问的替身 ──────────────────────────────────────────
//
// 产品代码把这一问交给探测执行层(`probeCli`:异步、起之前先拿到内核圈定的归属、每条结束
// 路径都收得回来)。**macOS 上那一层如实弃权**,于是产品在开发机上一律答「没问过 ⇒ 不补接」
// —— 这几格要钉的却是「问出不同答案时各自怎么收场」,所以这里换替身把那几条路逐个驱动起来
// (口子和理由同 `probeCli` 的 `openUnit`:生产代码里没有任何弱归属实现)。

/** codex 收下了。多数格子钉的是**写出来的内容**,不是 codex 的判决,用这个。 */
export const LISTS_ASH: ProbeOutcome = {
  kind: "answer", code: 0, stdout: JSON.stringify([{ name: "ash", enabled: true }]), stderr: "",
};

/** 按固定答案应付,并把「它拿什么去问的、问的时候用户那份文件长什么样」记下来。 */
export type Asked = { sandbox: string; candidate: string; userFile: string | null };
export function canned(outcome: ProbeOutcome, log?: Asked[], userFile?: string): CodexAsk {
  return async (sandbox) => {
    log?.push({
      sandbox,
      candidate: readFileSync(join(sandbox, "config.toml"), "utf8"),
      userFile: userFile && existsSync(userFile) ? readFileSync(userFile, "utf8") : null,
    });
    return outcome;
  };
}

/**
 * **真的去问 codex 本人**(拿沙盘里那份候选)。没装 codex 就如实答「没启动」。
 *
 * 测试进程里自己 spawn 是允许的:它堵不到 server 的事件循环,进程也随测试一起走 ——
 * 产品代码里不许这么写(本轮审查 F2),那条断言在最后一格。
 */
export const askRealCodex: CodexAsk = async (sandbox) => {
  const plan = resolveLaunch("codex", ["mcp", "list", "--json"]);
  if (!plan) return { kind: "not-started", why: "这台机器上没装 codex" };
  const res = spawnSync(plan.file, plan.args, {
    cwd: sandbox,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, CODEX_HOME: sandbox },
    ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
  });
  if (res.error || res.signal || res.status === null) return { kind: "unqueryable" };
  return { kind: "answer", code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

export const HAS_CODEX = !!resolveLaunch("codex", ["mcp", "list", "--json"]);

/** 默认替身 = 「codex 收下了」。只有明确要考 codex 判决的格子才自己传。 */
export const ensure = (dir: string, agent: string, host: string, ask: CodexAsk = canned(LISTS_ASH)) =>
  ensureAshMcp(dir, agent, host, ask);
/** 宿主真的没登记过、仓库也没 build 过 mcp 时,唯一诚实的答案是「补不上」。 */
export const HAS_BUILT_MCP = existsSync(join(REPO_DIR, "mcp", "dist", "index.js"));
