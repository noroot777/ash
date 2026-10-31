// 「每家 CLI 的 ash MCP 登记写在哪、什么形状」——**一家一条,这是唯一真相来源**。
//
// 读这张表前先看 `types.ts` 的文件头(为什么要有它)。这里只补三条读表规矩:
//
//  ① **`source` 写死依据,`evidence` 只有两档**:`tested` = 本机拿真 CLI 跑过/读过装好的
//     产物;`docs` = 只查了官方文档或发布包源码。没有第三档「我觉得」—— 十五家里有九家
//     本机没装,凭直觉写一条路径出来,最后收获的是「登记写了、CLI 不读、任务照样失败」,
//     正是这轮要治的病(用户 2026-10-30 实测:换别的 agent 跑任务全是 failed)。
//  ② **`identity` 比 `shape` 更要紧**:登记写对了只代表 CLI 连得上 ash MCP;交卷还需要
//     回合身份(`ASH_TASK_ID` / 两套 token)真的进到 MCP 子进程里。gemini 就是现成的坑 ——
//     登记完全正确、工具列得出来,但它按**变量名**把 `*_TOKEN` 从子进程环境里删了,于是
//     `complete_task` 永远报「这不是当前回合」。所以这一列拿不准时写 `unknown` 并在
//     `identityNote` 里说明,别默认它通。
//  ③ **宿主机那份配置只在缺 ash 条目时追加**(用户 2026-10-30 的硬边界)。表里不写「怎么写」,
//     怎么写由 `shapes.ts` 的 compose + `auth/config-publish.ts` 的事务统一负责。
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentType } from "@ash/shared";
import { mcpServersJsonShape, mcpServersTomlShape, opencodeJsonShape } from "./shapes.js";
import type { AshMcpConfigSite, AshMcpMechanism, AshMcpTable } from "./types.js";

/** 配置目录就是 home 本身(claude 的 `.claude.json`、gemini 的 `.gemini/`)。 */
const atHome: AshMcpConfigSite["defaultDir"] = (_env, home) => home;
/** `~/<段>/…`。 */
const underHome = (...segments: string[]): AshMcpConfigSite["defaultDir"] =>
  (_env, home) => join(home, ...segments);
/** XDG 那一族:`$XDG_CONFIG_HOME/<名>`,没设就 `~/.config/<名>`。 */
const xdgConfig = (name: string): AshMcpConfigSite["defaultDir"] =>
  (env, home) => join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), name);

export const ASH_MCP_TABLE = {
  // ── 本机实测过的六家 ────────────────────────────────────────────────────

  claude: {
    kind: "file",
    shape: mcpServersJsonShape,
    // 用户级配置是配置目录**根**下的 `.claude.json`(不在 `~/.claude/` 里),差一层。
    site: { dirEnv: "CLAUDE_CONFIG_DIR", defaultDir: atHome, relative: [".claude.json"] },
    identity: "inherit",
    evidence: "tested",
    // CLI 自己 `mcp add` 写出来的那条带 `type`,照抄它:同一份文件两种写法会让人以为被改过。
    writeType: true,
    source: "`claude mcp add ash --scope user` 实测；本仓 `scripts/setup.mjs` 从一开始就在写这份",
    notes: "`.claude.json` 同时是 CLI 自己在写的文件（会话、onboarding 标记都在里面），"
      + "所以写它必须走 `config-publish.ts` 那套就地写 + 读回来比对：半截内容比缺一条登记更糟",
  },

  codex: {
    kind: "file",
    shape: mcpServersTomlShape,
    site: { dirEnv: "CODEX_HOME", defaultDir: underHome(".codex"), relative: ["config.toml"] },
    // codex 按 `env_vars` 白名单过滤 MCP 子进程环境:起跑时用 `-c mcp_servers.<名>.env_vars=[…]`
    // 声明(`executors/codex.ts`)。**那是按回合给的命令行覆盖,不是写进配置文件的** ——
    // 回合 token 一轮一个,写进配置就是过期的假身份。
    identity: "declare",
    identityNote: "回合身份靠起跑时 `-c mcp_servers.ash.env_vars=[…]` 声明放行（`executors/codex.ts`）",
    evidence: "tested",
    source: "`codex mcp add` 实测 + `server/src/codex-toml.ts` 的结构扫描器（整套回归在 `test:codex-toml`）",
    notes: "整张表被写成内联值（`mcp_servers = { … }`）之后 TOML 不许再用表头扩展，"
      + "这种写法下只能让用户自己加 —— 判据在 `scanCodexToml` 的 `sealed`",
  },

  gemini: {
    kind: "file",
    shape: mcpServersJsonShape,
    site: { dirEnv: "GEMINI_CLI_HOME", defaultDir: atHome, relative: [".gemini", "settings.json"] },
    identity: "inherit",
    identityNote: "gemini 把交给 MCP 子进程的环境按**变量名**过滤（命中 /TOKEN|KEY|SECRET|AUTH/i 一类的删掉），"
      + "所以回合身份另按 `*_TICKET` 别名导一份（`shared/src/mcp.ts` 的 `ASH_TURN_IDENTITY_ENV`）；"
      + "只注 `ASH_TURN_TOKEN` 那一套的话登记再对也交不了卷",
    evidence: "tested",
    source: "`GEMINI_CLI_HOME=<沙盘> gemini mcp add ash node <entry> -s user -e ASH_URL=…` 实测写出 "
      + "`$GEMINI_CLI_HOME/.gemini/settings.json`；环境过滤用只 dump 环境的假 MCP server 取证",
    notes: "**工作区信任**:未信任的目录连用户级 MCP server 都不加载 —— 所以 `catalog/gemini.ts` 的 "
      + "`baseArgs` 带 `--skip-trust`，别去掉",
  },

  grok: {
    kind: "file",
    shape: mcpServersTomlShape,
    site: { dirEnv: "GROK_HOME", defaultDir: underHome(".grok"), relative: ["config.toml"] },
    identity: "unknown",
    identityNote: "没验过它给 MCP 子进程的环境是不是原样继承（TOML 里也没有 codex 那样的 `env_vars` 声明位）",
    evidence: "tested",
    // 跟 codex 同格式到字节级:`[mcp_servers.ash]` + command/args,多一行 `enabled = true`。
    writeEnabled: true,
    source: "`GROK_HOME=<沙盘> grok mcp add ash --command node --args …` 实测写出 `$GROK_HOME/config.toml`，"
      + "内容与 codex 的 `[mcp_servers.x]` 同形（多 `enabled = true`）",
    notes: "还有个根级开关 `disabled_mcp_servers = [\"ash\"]`（`grok mcp disable` 会同时写它），"
      + "判据只认写在一行里的那种数组，多行漏读时刻意偏向「放行」",
  },

  kimi: {
    kind: "file",
    shape: mcpServersJsonShape,
    site: { dirEnv: "KIMI_CODE_HOME", defaultDir: underHome(".kimi-code"), relative: ["mcp.json"] },
    identity: "unknown",
    evidence: "tested",
    source: "装好的 kimi 二进制里原文写着「The unified MCP management view: user-level "
      + "`<KIMI_CODE_HOME>/mcp.json`」，`mcpServers` 形状同族；本仓 `scripts/kimi-mcp.mjs` 已按它写",
    notes: "**没有 `mcp` 子命令**（`kimi mcp add` 报 unknown command），所以只能我们写文件，"
      + "也意味着没法拿 CLI 自己的输出来复核 —— 预检对它只有读配置这一档依据",
  },

  opencode: {
    kind: "file",
    shape: opencodeJsonShape,
    // `OPENCODE_CONFIG` 指的是**一个文件**,不是目录。
    site: {
      dirEnv: "OPENCODE_CONFIG",
      dirEnvIsFile: true,
      defaultDir: xdgConfig("opencode"),
      relative: ["opencode.json"],
      alternates: [["opencode.jsonc"]],
    },
    identity: "inherit",
    evidence: "tested",
    source: "`OPENCODE_CONFIG=<沙盘>/opencode.json opencode mcp list` 实测读得出我们写的那条 "
      + "`mcp.ash`（`type:\"local\"` + `command:[argv]` + `environment`），并按它去 spawn",
    notes: "跟 `mcpServers` 那族**不是同一个形状**（容器叫 `mcp`、argv 是数组、环境变量键叫 "
      + "`environment`），别拿那份硬套",
  },

  // ── 只有文档/发布包源码依据的八家(本机未装,一律标未实测)──────────────

  cursor: {
    kind: "file",
    shape: mcpServersJsonShape,
    site: { dirEnv: null, defaultDir: underHome(".cursor"), relative: ["mcp.json"] },
    identity: "unknown",
    evidence: "docs",
    // 文档明说 stdio 这条 `type` 是必填。
    writeType: true,
    source: "cursor.com/docs/context/mcp（2026-10-31 查）：全局 `~/.cursor/mcp.json`，"
      + "`mcpServers` 容器，stdio 支持 type/command/args/env",
    notes: "**未实测**（本机没装 cursor-agent）。CLI 侧的配置文档是 `~/.cursor/cli-config.json` 那一份，"
      + "通篇不提 MCP，所以 CLI 到底读不读这份全局 `mcp.json` 没有第二处证据",
  },

  qwen: {
    kind: "file",
    shape: mcpServersJsonShape,
    site: { dirEnv: "QWEN_HOME", defaultDir: atHome, relative: [".qwen", "settings.json"] },
    identity: "unknown",
    evidence: "docs",
    source: "读 npm 包 `@qwen-code/qwen-code@0.26.4` 的 bundle：`QWEN_DIR=\".qwen\"`、用户级 "
      + "settings 里的 `mcpServers`、`QWEN_HOME` 作为 home 基准（报错原文「QWEN_HOME points to … "
      + "but no settings.json was found there」）",
    notes: "**未实测**（本机没装）。它是 gemini-cli 的衍生，bundle 里同样有 `isTrustedFolder()` 判断，"
      + "很可能也有「未信任目录不加载 MCP」那道门 —— 真装上之后先验这一条",
  },

  qoder: {
    kind: "file",
    shape: mcpServersJsonShape,
    site: {
      dirEnv: null,
      // 目录名本身可以被 `QODER_CONFIG_DIR_NAME` 换掉(bundle 里有这个分支)。
      defaultDir: (env, home) => join(home, env.QODER_CONFIG_DIR_NAME?.trim() || ".qoder"),
      relative: ["mcp.json"],
    },
    identity: "unknown",
    evidence: "docs",
    source: "读 npm 包 `@qoder-ai/qodercli@1.1.81` 的 bundle：用户级配置目录 `~/.qoder`"
      + "（目录名可由 `QODER_CONFIG_DIR_NAME` 覆盖），MCP 读 `mcp.json`，`mcpServers` 容器",
    notes: "**未实测**（本机没装）。它还读项目里的 `.mcp.json`/`mcp.json`，那是仓库文件，ash 不替用户写",
  },

  copilot: {
    kind: "file",
    shape: mcpServersJsonShape,
    site: { dirEnv: "COPILOT_HOME", defaultDir: underHome(".copilot"), relative: ["mcp-config.json"] },
    identity: "unknown",
    evidence: "docs",
    source: "docs.github.com/copilot/reference/copilot-cli-reference/cli-config-dir-reference"
      + "（2026-10-31 查）：`COPILOT_HOME` 整体取代 `~/.copilot`，用户级 MCP 在 `mcp-config.json`",
    notes: "**未实测**（本机没装）。旧版文档曾写成 `~/.config`，后来改正；另有 `--config-dir` 旗标"
      + "**优先于** `COPILOT_HOME`，起跑时用了那个旗标的话这条判据会错",
  },

  kiro: {
    kind: "file",
    shape: mcpServersJsonShape,
    site: { dirEnv: null, defaultDir: underHome(".kiro"), relative: ["settings", "mcp.json"] },
    identity: "unknown",
    evidence: "docs",
    source: "kiro.dev/docs/mcp/configuration（2026-10-31 查）：用户级 `~/.kiro/settings/mcp.json`，"
      + "`mcpServers` 容器，stdio 支持 command/args/env/disabled",
    notes: "**未实测，而且这一家的依据最弱**：官方那页把配置位置按 IDE / CLI / Web 分页签，"
      + "抓到的只有 IDE 那一份；`kiro-cli` 若读别处，这条登记写了也不生效 —— 真机验过再改 tested",
  },

  kilo: {
    kind: "file",
    shape: opencodeJsonShape,
    site: {
      dirEnv: "KILO_CONFIG",
      dirEnvIsFile: true,
      defaultDir: xdgConfig("kilo"),
      relative: ["kilo.json"],
      alternates: [["kilo.jsonc"], ["config.json"], ["opencode.json"], ["opencode.jsonc"]],
    },
    identity: "unknown",
    evidence: "docs",
    source: "kilo.ai/docs 的 CLI + MCP 章节（2026-10-31 查）：`@kilocode/cli` 是 opencode 的衍生，"
      + "全局 `~/.config/kilo/kilo.json`（也认 `.jsonc` / `config.json` / 遗留的 `opencode.json[c]`），"
      + "MCP 在 `mcp` 键下，本地服务 `command` 是数组、可用 `enabled: false` 关掉",
    notes: "**未实测**（本机没装）。另有 `KILO_CONFIG_DIR`（配置目录根）语义没核实，所以只认 "
      + "`KILO_CONFIG` 这个指到文件的变量；旧版文档里的 `~/.kilocode/cli/global/settings/mcp_settings.json` "
      + "是上一代布局，不是现在这个包",
  },

  antigravity: {
    kind: "file",
    shape: mcpServersJsonShape,
    site: { dirEnv: null, defaultDir: underHome(".gemini", "config"), relative: ["mcp_config.json"] },
    identity: "unknown",
    evidence: "docs",
    source: "antigravity.google/docs/mcp（2026-10-31 查）：全局 `~/.gemini/config/mcp_config.json`，"
      + "`mcpServers` 容器，stdio 支持 command/args/env/cwd，可用 `disabled` 关掉",
    notes: "**未实测**（本机没装）。**别和 gemini CLI 搞混**：两家都住在 `~/.gemini` 下面，"
      + "但 gemini 读 `settings.json`、antigravity 读 `config/mcp_config.json`，互不相认",
  },

  pi: {
    kind: "file",
    shape: mcpServersJsonShape,
    site: { dirEnv: "PI_CODING_AGENT_DIR", defaultDir: underHome(".pi", "agent"), relative: ["mcp.json"] },
    // pi-mcp 的 StdioTransport 默认 `{ ...process.env, ...options.env }`(inheritEnv 不为 false),
    // pi 自己没传 inheritEnv —— 所以起跑时注的回合身份进得去。
    identity: "inherit",
    evidence: "docs",
    source: "读 npm 包 `@earendil-works/pi-coding-agent@1.4.0`（`dist/extensions/mcp/config.js` 原文："
      + "「Servers are read from `mcp.json` in the agent directory」，agent dir = `$PI_CODING_AGENT_DIR` "
      + "或 `~/.pi/agent`）与 `@earendil-works/pi-mcp@1.4.0`（stdio 默认继承 `process.env`）",
    notes: "**本机装的是 0.83.0，整个产物里一个 MCP 入口都没有**（grep 全库只有 vendored highlight.js 的 "
      + "\"mcpy\"）—— 那个版本下这条登记写了也没人读，任务照样交不了卷。MCP 是 1.x 才有的，"
      + "所以这一条是「新版按文档支持、老版完全不支持」,别只看文件在不在就当它通了",
  },

  // ── 有 MCP、但 ash 不替你写的一家 ───────────────────────────────────────

  trae: {
    kind: "manual",
    howTo: "全局登记在 `trae_cli.yaml`（`traecli config edit` 打开），按 stdio 加一条："
      + "`name: ash` / `type: stdio` / `command: node` / `args: [<仓库>/mcp/dist/index.js]` / "
      + "`env: { ASH_URL: … }`；回合身份由 ash 起跑时注入，不要写进配置文件",
    evidence: "docs",
    source: "docs.trae.cn 的 TRAE CLI「模型上下文协议（MCP）」章节（2026-10-31 经检索摘要核对，"
      + "直连该页当天 404）：全局配置是 YAML 的 `trae_cli.yaml`，stdio 字段 name/type/command/args/env/timeout",
    notes: "**未实测**（本机没装）。不自动写有两个原因：① 全局配置是 YAML，本仓没有能保住注释与"
      + "缩进的写入器，拿 JSON 那套硬写会毁掉用户整份配置；② 它另认项目里的 `.trae/mcp.json`"
      + "（`mcpServers` 形状），但那是用户仓库里的文件，会被提交进去，ash 不碰",
  },
} satisfies AshMcpTable;

/** 这家 CLI 的 ash MCP 机制;不是已知执行器就返回 null(调用方按「不知道」处理,别当成没有)。 */
export function ashMcpMechanism(agentType: string): AshMcpMechanism | null {
  return (ASH_MCP_TABLE as Record<string, AshMcpMechanism>)[agentType] ?? null;
}

/** ash 能不能**自动**把登记写进这家 CLI(manual / none 都是不能)。 */
export function canRegisterAshMcp(agentType: string): boolean {
  return ashMcpMechanism(agentType)?.kind === "file";
}

/** 宿主机上这家 CLI 的 ash MCP 配置目录(`dirEnv` 优先,它指到文件时返回那个文件所在目录)。 */
export function ashMcpConfigDir(
  agentType: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  const mechanism = ashMcpMechanism(agentType);
  if (mechanism?.kind !== "file") return null;
  const { site } = mechanism;
  const override = site.dirEnv ? env[site.dirEnv]?.trim() : "";
  if (override && !site.dirEnvIsFile) return override;
  if (override) return join(override, "..");
  return site.defaultDir(env, home);
}

export type { AgentType };
