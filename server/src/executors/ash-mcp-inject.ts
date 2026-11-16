// ash 自己的 MCP 服务**起跑时由 ash 注入给 CLI**，连没连上以 CLI 启动后自己报出来的为准
// （确认那一半在 `ash-mcp-confirm.ts`）。
//
// 从前的做法是起跑前去探测用户全局配置里有没有登记 ash、能不能连上（六个文件近两千行），而
// macOS 上探测根本不执行、退回读配置文件 —— 在日常那台机器上并不提供它声称的保证。现在
// claude 走 `--mcp-config <文件>`，codex 走 `-c mcp_servers.ash={…}`。不依赖用户配置里有没有
// 登记，多人模式下各自的 CLI 配置目录也不用补登记 —— 注入的是这一份 ash 自己的入口 + 这个
// 端口，回合身份照旧走环境变量（`turn-identity.ts`）。
//
// **注入的那份必须是最终生效的那份**，两家都靠「排在最后」：
//  · claude：同名 server 以**最后一个** `--mcp-config` 为准（2026-11-14 claude 2.1.283 实测：
//    用户配置里的同名 ash、profile 里更早的 `--mcp-config`、`--strict-mcp-config`、一次传几份
//    都压不过排在最后的那份，只有它被拉起来）。所以它装在全部参数（含 profile 与本次 extraArgs）
//    之后 —— 早先把它排在最前，profile 里后置的同名配置就把它整条换掉了，init 里照样是
//    `connected`、`source=dynamic`，看不出差别（第 2 轮审查发现 1）。
//  · codex：`-c` 后者覆盖前者，同样装在用户 extraArgs 之后。`-c` 是**深合并**进用户那张表的
//    —— 我们写的 command/args/env.ASH_URL/enabled/env_vars 一律以注入为准，用户在那张表里另加
//    的键（`enabled_tools`、`tools.*.approval_mode`、别的 env 变量）保留，工具名单因此要在确认
//    那一半核对；用户把 ash 登记成 `url` 型时 codex 整份配置会拒载（回合当场失败、报原话，不静默）。
//    历史名 `harness` 不碰：给不存在的表写 `enabled=false` 会让 codex 拒载整份配置。
//
// **回合身份也要是这一回合的**：身份本身照旧走环境变量和 `PATH`，而那几条通道都可能被 CLI 配置
// 换成旧值（claude 的 `settings.env`、codex 登记里写死的 `env`）。所以注入的登记里另带一个
// 回合指纹（`@ash/shared/turn-fingerprint`），MCP 只认对得上它的那份身份，对不上就拒绝启动、
// 由 CLI 报出「没接上」；不是任务回合就写明「无身份」，MCP 哪条通道里有都不认。指纹是令牌的
// 单向摘要，进 argv 不泄密。claude 的注入文件因此按回合不同，写在任务自己的 runs 目录下、写新的
// 就删旧的。
//
// 其余执行器不注入，退路就是它们自己配置里的登记（注册执行器时 `mcp-registry/` 会补写），
// ash 不再替它们做任何探测。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASH_MCP_SERVER_NAME, ASH_TURN_IDENTITY_ENV, ASH_TURN_IDENTITY_ENV_KEYS } from "@ash/shared/mcp";
import { ASH_TURN_FINGERPRINT_ENV, ASH_TURN_FINGERPRINT_NONE, turnFingerprint } from "@ash/shared/turn-fingerprint";
import { ashMcpEntry } from "../mcp-registry/register.js";
import type { AshMcpEntry } from "../mcp-registry/types.js";
import { DATA_DIR, RUNS_DIR } from "../paths.js";

/** 起跑时由 ash 注入自己 MCP 的执行器。其余几家走它们自己的配置登记。 */
export const ASH_MCP_INJECTED = ["claude", "codex"] as const;

export const injectsAshMcp = (agentType: string): boolean =>
  (ASH_MCP_INJECTED as readonly string[]).includes(agentType);

/** 起跑那份环境（`RunOpts.env`）：回合身份由 `turn-identity.ts` 设进去，非任务回合显式清掉。 */
type SpawnEnv = Readonly<Record<string, string | undefined>> | undefined;

const turnTaskId = (env: SpawnEnv): string => env?.[ASH_TURN_IDENTITY_ENV.taskId]?.trim() ?? "";

/**
 * 注入登记里多出来的那一项：这一回合身份的指纹。判据是**有没有任务 id**，不是有没有回合令牌 ——
 * 团队调度台只带任务 id（见 `turnFingerprint`），缺的令牌按空串摘；连任务 id 都没有才是「无身份」。
 */
function fingerprintEnv(env: SpawnEnv): Record<string, string> {
  const taskId = turnTaskId(env);
  const turnToken = env?.[ASH_TURN_IDENTITY_ENV.turnToken]?.trim() ?? "";
  const directionToken = env?.[ASH_TURN_IDENTITY_ENV.directionToken]?.trim() ?? "";
  return {
    [ASH_TURN_FINGERPRINT_ENV]: taskId ? turnFingerprint({ taskId, turnToken, directionToken }) : ASH_TURN_FINGERPRINT_NONE,
  };
}

/** 这一回合 claude 注入的结果：`args` 拼进命令，`failure` 交给这一回合自己的 init 确认（不进任何全局状态）。 */
export type ClaudeAshMcpInjection = { args: string[]; failure: string | null };

/**
 * claude 的 `--mcp-config` 参数。写成文件而不是内联 JSON：Windows 上 claude 是 `.cmd` 垫片，
 * 一段带引号的 JSON 过 cmd.exe 是另一场仗。文件名按内容取哈希。
 *
 * 放在哪：任务回合的内容带着本回合指纹、一回合一份，写在 `<runs>/<taskId>/ash-mcp/` 下，写新的
 * 就删这个任务旧的那几份（claude 只在启动时读它）；非任务回合内容只随端口变，放数据目录下共用
 * —— 同一个数据目录下可能同时跑着不同端口的实例（预览、验证实例），各写各的、谁也盖不掉谁。
 *
 * MCP 产物还没 build 出来也照样注入：那样 CLI 会如实报「ash 没连上」，而不是悄悄退回用户
 * 全局配置里那条 —— 那条可能指着另一个 ash 实例。写不出文件就只能不注入，原因随结果交回，
 * 由**这一回合**的 init 确认带出来（`claudeAshMcpProblem`）：同一进程里同时起跑的别的回合
 * 写成没写成，跟这一回合无关（第 2 轮审查发现 3）。
 */
export function claudeAshMcpInjection(
  env: SpawnEnv,
  { entry = ashMcpEntry(), dir }: { entry?: AshMcpEntry; dir?: string } = {},
): ClaudeAshMcpInjection {
  const taskId = turnTaskId(env);
  const target = dir ?? (taskId ? join(RUNS_DIR, taskId, "ash-mcp") : join(DATA_DIR, "ash-mcp"));
  const server = { type: "stdio", ...entry, env: { ...entry.env, ...fingerprintEnv(env) } };
  const body = `${JSON.stringify({ mcpServers: { [ASH_MCP_SERVER_NAME]: server } }, null, 2)}\n`;
  const name = `claude-${createHash("sha256").update(body).digest("hex").slice(0, 12)}.json`;
  const file = join(target, name);
  try {
    if (!existsSync(file) || readFileSync(file, "utf8") !== body) {
      mkdirSync(target, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, file);
    }
  } catch (e) {
    const failure = `写不出注入文件 ${file}：${(e as Error).message}`;
    console.warn(`[ash] ${failure}`);
    return { args: [], failure };
  }
  if (taskId) {
    // 旧回合那几份：删不掉不碍事，下一回合再删。
    try {
      for (const old of readdirSync(target)) {
        if (old !== name && old.startsWith("claude-")) rmSync(join(target, old), { force: true });
      }
    } catch { /* 同上 */ }
  }
  return { args: ["--mcp-config", file], failure: null };
}

/**
 * codex 的 `-c` 覆盖：整条 ash 登记写成一张内联表。`env` 是起跑那份环境：里面有的回合身份变量
 * 按名字写进 `env_vars`，由 codex 从父进程透传给 MCP 子进程（codex 默认过滤 MCP 子进程环境）；
 * 只写名字，令牌值不进 argv。回合指纹写进 `env`，用户登记里同名的写死值压不过它。TOML 基本
 * 字符串与 JSON 字符串的转义规则在这里用得到的部分一致（`\\`、`\"`、`\uXXXX`），Windows 路径里
 * 的反斜杠因此成对。
 */
export function codexAshMcpArgs(env: SpawnEnv, entry: AshMcpEntry = ashMcpEntry()): string[] {
  const str = (s: string) => JSON.stringify(s);
  const identityVars = ASH_TURN_IDENTITY_ENV_KEYS.filter((key) => !!env?.[key]);
  const vars = Object.entries({ ...entry.env, ...fingerprintEnv(env) }).map(([k, v]) => `${k}=${str(v)}`).join(",");
  const fields = [
    `command=${str(entry.command)}`,
    `args=[${entry.args.map(str).join(",")}]`,
    `env={${vars}}`,
    "enabled=true",
    ...(identityVars.length ? [`env_vars=[${identityVars.map(str).join(",")}]`] : []),
  ];
  return ["-c", `mcp_servers.${ASH_MCP_SERVER_NAME}={${fields.join(",")}}`];
}
