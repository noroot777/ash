// 个人 CLI 环境:每用户每 CLI 一个独立配置目录(§九)。
//
// 位置是 **server 数据目录 `data/user-cli/<userId>/<agentType>/`**,不是用户项目目录内
// (审查修订 D10):放进去就会撞上「把含 .ash 的目录建成项目」的污染,而且 git 会看见它。
// 放在这里,项目路径永远够不着,git 也永远看不见。
//
// 载体是各 CLI 自己的「整体取代配置目录」环境变量:
//   claude → CLAUDE_CONFIG_DIR   (实测:设了就整个取代 ~/.claude,**不回落**)
//   codex  → CODEX_HOME
// 于是自然得到个人 skill / 个人全局 CLAUDE.md·AGENTS.md / 个人插件 / 个人 CLI 设置。
// 没有等价环境变量的 CLI(gemini 等)如实降级为「仅项目级」,并在 UI 标注 —— 不假装。
//
// ⚠ seed 的现状(2026-08-27 探针,见 docs/multi-user-plan.md §九):
//   ① 空配置目录 + 无 API key → claude 直接「Not logged in」退出,**不回落宿主钥匙串**。
//      「配置目录即隔离/抹去订阅」成立,这是整节的地基。
//   ② `~/.claude.json` 跟着配置目录走,宿主那份不被触碰。
//   ③ **带 key 的首跑挂起 >120s,卡点未定位** —— 所以 seed 只写「确定无害」的最小集
//      (onboarding 已完成标记),不预置任何会改变 CLI 行为的开关;上线前必须过
//      `server/scripts/test-user-cli-smoke.ts` 的零交互冒烟测试。
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentType, PersonalCliEnv, PersonalSkill } from "@ash/shared";
import { DATA_DIR } from "../paths.js";
import { ensureAshMcp, ashMcpRegistration, hostCliConfigDir, hostCliConfigFile } from "./user-cli-mcp.js";

/** 个人配置目录的根。刻意放 data/ 下 —— 见文件顶部。 */
export const USER_CLI_ROOT = join(DATA_DIR, "user-cli");

/** 「整体取代配置目录」的环境变量名。没有 = 该 CLI 的个人级降级为仅项目级。 */
const CONFIG_DIR_ENV: Partial<Record<AgentType, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/** 个人全局指令文件叫什么(claude 是 CLAUDE.md,codex 是 AGENTS.md)。 */
const MEMORY_FILE: Partial<Record<AgentType, string>> = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
};

/** 有个人配置目录的 CLI(管理面按它列节)。 */
export const PERSONAL_CLI_TYPES = Object.keys(CONFIG_DIR_ENV) as AgentType[];

/** 没有等价环境变量时,如实说明原因(界面上原样显示)。 */
const UNSUPPORTED_REASON: Partial<Record<AgentType, string>> = {
  gemini: "gemini CLI 没有「整体取代配置目录」的环境变量，个人级技能/指令暂时做不到，只有项目级生效",
};

export const configDirEnvVar = (agentType: string): string | null =>
  CONFIG_DIR_ENV[agentType as AgentType] ?? null;

export function userCliDir(userId: string, agentType: string): string {
  return join(USER_CLI_ROOT, userId, agentType);
}

/**
 * 建目录并写下最小 seed。幂等 —— 已存在的文件一律不覆盖(用户可能已经改过)。
 *
 * seed 只有三样,都属于「确定无害」:
 *  · `skills/` 空目录:让「个人技能」这一层从第一天起就存在,不必等第一次上传。
 *  · claude 的 `.claude.json`:只写 onboarding 完成标记。CLI 首跑会自己在这个目录里
 *    生成这份文件(探针②),我们只是把「别再问一遍引导问题」这一位先摆好。
 *    **不预置任何 model / permissions / env** —— 那些会改变 CLI 行为,而探针③ 表明
 *    带 key 的首跑本来就有一个未定位的挂起,再加变量只会让排查更难。
 *  · **ash MCP 的登记**(`user-cli-mcp.ts`):它不是「改变 CLI 行为的开关」,而是完成
 *    协议本身 —— 没有它 agent 调不到 `complete_task`,干完的活一律显示成失败。缺了
 *    才写、已有不覆盖,所以对已经跑起来的目录也是安全的补做。
 */
export function ensureUserCliDir(userId: string, agentType: AgentType): string | null {
  if (!configDirEnvVar(agentType)) return null;
  const dir = userCliDir(userId, agentType);
  mkdirSync(join(dir, "skills"), { recursive: true });
  if (agentType === "claude") {
    const marker = join(dir, ".claude.json");
    if (!existsSync(marker)) {
      writeFileSync(
        marker,
        `${JSON.stringify({ hasCompletedOnboarding: true, projects: {} }, null, 2)}\n`,
        "utf8",
      );
    }
  }
  if (agentType === "codex") mkdirSync(join(dir, "sessions"), { recursive: true });
  ensureAshMcp(dir, agentType);
  return dir;
}

/** 建用户时把他所有 CLI 的个人环境初始化出来。 */
export function initUserCliEnv(userId: string): void {
  for (const type of PERSONAL_CLI_TYPES) {
    try {
      ensureUserCliDir(userId, type);
    } catch (e) {
      console.warn(`[ash] 初始化 ${userId} 的 ${type} 个人配置目录失败:`, e);
    }
  }
}

/**
 * spawn 这个用户的任务时要注入的 CLI 配置目录环境变量。
 * 自用模式(userId 为 null)返回空对象 —— 那条路继续用宿主机默认目录,订阅照用(§九)。
 */
export function cliConfigEnvFor(userId: string | null, agentType: string): Record<string, string> {
  if (!userId) return {};
  const key = configDirEnvVar(agentType);
  if (!key) return {};
  const dir = ensureUserCliDir(userId, agentType as AgentType);
  return dir ? { [key]: dir } : {};
}

// ── 管理面(设置页「个人 CLI 环境」节)────────────────────────────────────────

function readSkills(dir: string): PersonalSkill[] {
  const skillsDir = join(dir, "skills");
  let names: string[];
  try {
    names = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const list: PersonalSkill[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const file = join(skillsDir, name, "SKILL.md");
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    let description = "";
    try {
      const head = readFileSync(file, "utf8").slice(0, 2048);
      description = /^description:[ \t]*(.*)$/m.exec(head)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    } catch {
      /* 读不出就留空 */
    }
    list.push({ name, description: description.slice(0, 200) });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

function readPlugins(dir: string): string[] {
  try {
    return readdirSync(join(dir, "plugins")).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
}

export function personalCliEnv(userId: string, agentType: AgentType): PersonalCliEnv {
  const envVar = configDirEnvVar(agentType);
  if (!envVar) {
    return {
      agentType,
      supported: false,
      reason: UNSUPPORTED_REASON[agentType] ?? `${agentType} 没有「整体取代配置目录」的环境变量`,
      configDir: null,
      envVar: null,
      skills: [],
      memoryFile: null,
      memoryName: null,
      hasMemory: false,
      plugins: [],
      ashMcp: null,
    };
  }
  const dir = ensureUserCliDir(userId, agentType)!;
  const memoryName = MEMORY_FILE[agentType] ?? null;
  const memoryFile = memoryName ? join(dir, memoryName) : null;
  return {
    agentType,
    supported: true,
    configDir: dir,
    envVar,
    skills: readSkills(dir),
    memoryFile,
    memoryName,
    hasMemory: !!memoryFile && existsSync(memoryFile),
    plugins: readPlugins(dir),
    // 现读一遍(不是复用 ensureUserCliDir 那次的结果):这一屏正是用来看「补上了没有」的,
    // 用户手工改完刷新页面就该看到新状态。
    ashMcp: ensureAshMcp(dir, agentType),
  };
}

/**
 * 共用宿主 CLI 的那一档（含自用模式）：宿主配置里缺 ash MCP 时**出声，但一个字节都不改**。
 *
 * 边界见 `user-cli-mcp.ts` 开头那条：那些是用户自己的配置文件。但「不该改」不等于
 * 「不该说」—— 2026-10-28 现场正是一台 `~/.codex/config.toml` 里从来没有过
 * `[mcp_servers.ash]` 的机器：codex 任务干完活交不了卷、一律记 failed，一轮审查更是
 * 跑满 35 分钟写完报告，最后才发现没有 `report_stage` 可调，而 ash 全程一言不发。
 */
async function warnHostAshMcp(): Promise<void> {
  const gaps: { line: string; basis: "cli" | "file" }[] = [];
  for (const agentType of ["claude", "codex"]) {
    const file = hostCliConfigFile(agentType);
    // **不拿「配置文件在不在」当「这个 CLI 用没用过」**：装了 codex、从没写过 config.toml 的
    // 机器正是最该出声的那种 —— 派审那道门禁对同一个形状答的是「确实没有」（新链第 2 轮审查
    // 第 3 条）。「这台机器上有没有这个 CLI」由 `hostAshMcpGap` 自己判（找不到 CLI 就不报缺口），
    // 跟派审用同一份解析，这里不另起一份。
    if (!file) continue;
    const dir = hostCliConfigDir(agentType);
    // 两道判据，顺序有意：**先用配置文件快速放过**（已经接好的机器零开销），只有它说
    // 「没有」或「关着」才去确认。快速通道**只许省掉那次确认，不许替它下「没问题」的结论**：
    // 上一版只看「不是 absent」就放过，`enabled = false` 的登记读出来是「在」，于是那道
    // 本来算得出「没启用」的 CLI 确认被跳过（新链第 1 轮审查第 2 条）。所以只有明确的
    // present 才放过；读不出来（unknown）也放过 —— 那时确认那一道同样问不出结论。
    const quick = dir ? ashMcpRegistration(dir, agentType).state : "unknown";
    if (quick === "present" || quick === "unknown") continue;
    const { hostAshMcpGap } = await import("../ash-mcp-reachability.js");
    const gap = await hostAshMcpGap(agentType);
    if (!gap) continue;
    gaps.push({ line: `${agentType}（${file}）：${gap.problem}`, basis: gap.basis });
  }
  if (!gaps.length) return;
  // 措辞里的「这台机器的默认配置下」不是客套：这里问的是**宿主默认上下文** ——
  // `hostAshMcpGap` 没有任务目录、没有执行器 profile，而 claude 的项目级登记
  // (`--scope local`)和 codex 的 `-c mcp_servers.…` 覆盖都能让某条具体任务照样有工具。
  // 派审那道门禁(`ashMcpReachability`)才问得到那些,所以这行启动日志只敢说默认配置。
  //
  // 证据来源也要说实话：问不了 CLI 本人的机器上（macOS 等，见 ash-mcp-reachability.ts
  // 「问不了 CLI 时」）结论来自配置文件，措辞降一档成「看配置像是没登记」。
  const fromCli = gaps.every((g) => g.basis === "cli");
  console.warn((fromCli
    ? "[ash] 这些 CLI 在这台机器的默认配置下自己报告没有可用的 ash MCP 登记，"
    : "[ash] 看这台机器的默认配置，这些 CLI 像是没有可用的 ash MCP 登记（读配置得出，没经 CLI 本人确认），")
    + "这么跑起来的 agent 交不了卷"
    + "（没有 complete_task，干完的活会记 failed；派出去的审查跑完也给不出结论）：");
  for (const g of gaps) console.warn(`  · ${g.line}`);
  console.warn("  自查：claude mcp get ash / codex mcp list --json。接法见 docs/install.md，"
    + "或在仓库根跑一次 npm run setup（已有登记不会被覆盖）。");
}

export async function sweepPersonalAshMcp(): Promise<void> {
  // 动态 import:mode.ts / db 都在 auth 这一圈里绕回来,顶层导入会绕出一个环。
  const { isHostCliIsolated } = await import("./mode.js");
  if (!(await isHostCliIsolated())) return await warnHostAshMcp();
  const { db } = await import("../db/index.js");
  const { users } = await import("../db/schema.js");
  const rows = await db.select({ id: users.id, name: users.name }).from(users);
  const broken: string[] = [];
  for (const row of rows) {
    for (const type of PERSONAL_CLI_TYPES) {
      const dir = ensureUserCliDir(row.id, type);
      if (!dir) continue;
      const state = ensureAshMcp(dir, type);
      if (!state.configured) broken.push(`${row.name} 的 ${type}：${state.problem ?? "原因不明"}`);
    }
  }
  if (!broken.length) return;
  console.warn("[ash] 这些个人 CLI 配置目录缺 ash MCP 登记，它们的 agent 交不了卷（没有 complete_task，干完的活会记 failed）：");
  for (const line of broken) console.warn(`  · ${line}`);
}

export function listPersonalCliEnv(userId: string): PersonalCliEnv[] {
  const all: AgentType[] = [...PERSONAL_CLI_TYPES, "gemini"];
  return all.map((type) => personalCliEnv(userId, type));
}

// 技能名同样落成磁盘目录名,校验从严(理由同用户目录名)。
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function writePersonalSkill(userId: string, agentType: AgentType, name: string, body: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw Object.assign(new Error("技能名只能用字母、数字、点、下划线和连字符，1~64 个字符"), { status: 400 });
  }
  const dir = ensureUserCliDir(userId, agentType);
  if (!dir) throw Object.assign(new Error(`${agentType} 不支持个人级技能`), { status: 400 });
  const target = join(dir, "skills", name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), body, "utf8");
}

export function readPersonalSkill(userId: string, agentType: AgentType, name: string): string | null {
  if (!SKILL_NAME_RE.test(name)) return null;
  const dir = userCliDir(userId, agentType);
  try {
    return readFileSync(join(dir, "skills", name, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

export function updatePersonalSkill(userId: string, agentType: AgentType, name: string, body: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw Object.assign(new Error("技能名非法"), { status: 400 });
  }
  if (!configDirEnvVar(agentType)) {
    throw Object.assign(new Error(`${agentType} 不支持个人级技能`), { status: 400 });
  }
  let file: number;
  try {
    file = openSync(join(userCliDir(userId, agentType), "skills", name, "SKILL.md"), "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error("技能不存在，无法保存。请重新读取技能列表。"), { status: 404 });
    }
    throw error;
  }
  try {
    writeFileSync(file, body, "utf8");
    ftruncateSync(file, Buffer.byteLength(body, "utf8"));
  } finally {
    closeSync(file);
  }
}

export function deletePersonalSkill(userId: string, agentType: AgentType, name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw Object.assign(new Error("技能名非法"), { status: 400 });
  }
  rmSync(join(userCliDir(userId, agentType), "skills", name), { recursive: true, force: true });
}

export function readPersonalMemory(userId: string, agentType: AgentType): string {
  const name = MEMORY_FILE[agentType];
  if (!name) return "";
  try {
    return readFileSync(join(userCliDir(userId, agentType), name), "utf8");
  } catch {
    return "";
  }
}

export function writePersonalMemory(userId: string, agentType: AgentType, body: string): void {
  const name = MEMORY_FILE[agentType];
  if (!name) throw Object.assign(new Error(`${agentType} 没有个人级全局指令文件`), { status: 400 });
  const dir = ensureUserCliDir(userId, agentType);
  if (!dir) throw Object.assign(new Error(`${agentType} 不支持个人级配置目录`), { status: 400 });
  writeFileSync(join(dir, name), body, "utf8");
}
