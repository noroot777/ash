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
import { injectsAshMcp } from "../executors/ash-mcp-inject.js";
import { ensureAshMcp, ashMcpRegistration, hostCliConfigDir, hostCliConfigFile, INJECTED_ASH_MCP } from "./user-cli-mcp.js";

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

/**
 * 个人档没接这家 CLI 时,如实说明原因(界面上原样显示)。
 *
 * 注意**别把「没接」写成「做不到」**:2026-10-31 实测,gemini 有 `GEMINI_CLI_HOME`、grok 有
 * `GROK_HOME`、kimi 有 `KIMI_CODE_HOME`、copilot 有 `COPILOT_HOME`(各家见
 * `mcp-registry/catalog.ts` 那张表的 `dirEnv`)—— 技术上都能隔离。没接是**有意的**:那些变量
 * 整体取代配置目录,一接上,用户宿主机上这些 CLI 的登录态就一起被隔掉(claude 实测如此),
 * 那是另一件要单独验的事。这里只如实说现状。
 */
const UNSUPPORTED_REASON: Partial<Record<AgentType, string>> = {
  gemini: "gemini 有 GEMINI_CLI_HOME（2026-10-31 实测整体取代配置目录），但个人档还没接它 —— "
    + "接上会把宿主机上的 gemini 登录态一起隔掉，要单独一轮；现在只有项目级生效",
};

export const configDirEnvVar = (agentType: string): string | null =>
  CONFIG_DIR_ENV[agentType as AgentType] ?? null;

export function userCliDir(userId: string, agentType: string): string {
  return join(USER_CLI_ROOT, userId, agentType);
}

/**
 * 建目录并写下最小 seed。幂等 —— 已存在的文件一律不覆盖(用户可能已经改过)。
 *
 * seed 只有两样,都属于「确定无害」:
 *  · `skills/` 空目录:让「个人技能」这一层从第一天起就存在,不必等第一次上传。
 *  · claude 的 `.claude.json`:只写 onboarding 完成标记。CLI 首跑会自己在这个目录里
 *    生成这份文件(探针②),我们只是把「别再问一遍引导问题」这一位先摆好。
 *    **不预置任何 model / permissions / env** —— 那些会改变 CLI 行为,而探针③ 表明
 *    带 key 的首跑本来就有一个未定位的挂起,再加变量只会让排查更难。
 *
 * **不写 ash MCP 登记**:有个人目录的这几家(claude / codex)起跑时由 ash 注入自己的 MCP
 * (`executors/ash-mcp-inject.ts`),个人目录里有没有那条登记都不影响交卷。
 */
export async function ensureUserCliDir(userId: string, agentType: AgentType): Promise<string | null> {
  return seedUserCliDir(userId, agentType);
}

/** 同 `ensureUserCliDir`,同步版。 */
export function seedUserCliDir(userId: string, agentType: AgentType): string | null {
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
  return dir;
}

/** 建用户时把他所有 CLI 的个人环境初始化出来。 */
export async function initUserCliEnv(userId: string): Promise<void> {
  for (const type of PERSONAL_CLI_TYPES) {
    try {
      await ensureUserCliDir(userId, type);
    } catch (e) {
      console.warn(`[ash] 初始化 ${userId} 的 ${type} 个人配置目录失败:`, e);
    }
  }
}

/**
 * spawn 这个用户的任务时要注入的 CLI 配置目录环境变量。
 * 自用模式(userId 为 null)返回空对象 —— 那条路继续用宿主机默认目录,订阅照用(§九)。
 */
export async function cliConfigEnvFor(userId: string | null, agentType: string): Promise<Record<string, string>> {
  if (!userId) return {};
  const key = configDirEnvVar(agentType);
  if (!key) return {};
  const dir = await ensureUserCliDir(userId, agentType as AgentType);
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

export async function personalCliEnv(userId: string, agentType: AgentType): Promise<PersonalCliEnv> {
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
  const dir = seedUserCliDir(userId, agentType)!;
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
    // 起跑时注入的那几家不看目录里的登记;其余的现问(用户手工改完刷新页面就该看到新状态)。
    ashMcp: injectsAshMcp(agentType) ? INJECTED_ASH_MCP : await ensureAshMcp(dir, agentType),
  };
}

/**
 * 共用宿主 CLI 的那一档（含自用模式）：宿主配置里缺 ash MCP 时**出声，但一个字节都不改**。
 *
 * 只看**不注入**的那几家（claude / codex 起跑时由 ash 注入，见 `executors/ash-mcp-inject.ts`），
 * 而且只读一次它们自己的配置文件、不起 CLI —— 那几家的退路就是自己配置里的登记，读出来
 * 确实没有（或关着）才说一句。没装的 CLI 不报：配置文件不在、PATH 上也找不到它就跳过。
 */
async function warnHostAshMcp(): Promise<void> {
  const gaps: string[] = [];
  const { AGENT_TYPES } = await import("@ash/shared");
  const { cliSpec } = await import("../executors/catalog/index.js");
  const { resolveBin } = await import("../executors/bin-resolve.js");
  for (const agentType of AGENT_TYPES) {
    if (injectsAshMcp(agentType)) continue;
    const file = hostCliConfigFile(agentType);
    const dir = hostCliConfigDir(agentType);
    if (!file || !dir) continue;
    if (!existsSync(file) && !cliSpec(agentType).bins.some((bin) => resolveBin(bin))) continue;
    const found = ashMcpRegistration(dir, agentType);
    if (found.state === "absent" || found.state === "disabled") gaps.push(`${agentType}（${file}）：${found.detail}`);
  }
  if (!gaps.length) return;
  console.warn("[ash] 看这台机器的默认配置，这些 CLI 没有可用的 ash MCP 登记（ash 不替它们注入），"
    + "这么跑起来的 agent 交不了卷（没有 complete_task，干完的活会记 failed）：");
  for (const line of gaps) console.warn(`  · ${line}`);
  console.warn("  接法见 docs/install.md，或在仓库根跑一次 npm run setup（已有登记不会被覆盖）。");
}

/**
 * 启动时那一趟：共用档提示宿主配置的缺口；隔离档的个人目录只有 claude / codex 两家，
 * 都由 ash 起跑时注入，不需要补登记 —— 这里只把目录建好。
 */
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
      const dir = await ensureUserCliDir(row.id, type);
      if (!dir || injectsAshMcp(type)) continue;
      const state = await ensureAshMcp(dir, type);
      // 只取第一行:补不上时那句话里会带上「要手工加的那段」(整段 TOML),一台机器上每个用户
      // 都印一遍会把启动日志冲掉。完整的那一份在设置页/`GET /me/cli-env` 里。
      const why = (state.problem ?? "原因不明").split("\n")[0]!;
      if (!state.configured) broken.push(`${row.name} 的 ${type}：${why}`);
    }
  }
  if (!broken.length) return;
  console.warn("[ash] 这些个人 CLI 配置目录缺 ash MCP 登记，它们的 agent 交不了卷（没有 complete_task，干完的活会记 failed）：");
  for (const line of broken) console.warn(`  · ${line}`);
}

export async function listPersonalCliEnv(userId: string): Promise<PersonalCliEnv[]> {
  const all: AgentType[] = [...PERSONAL_CLI_TYPES, "gemini"];
  return await Promise.all(all.map((type) => personalCliEnv(userId, type)));
}

// 技能名同样落成磁盘目录名,校验从严(理由同用户目录名)。
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function writePersonalSkill(userId: string, agentType: AgentType, name: string, body: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw Object.assign(new Error("技能名只能用字母、数字、点、下划线和连字符，1~64 个字符"), { status: 400 });
  }
  const dir = seedUserCliDir(userId, agentType);
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
  const dir = seedUserCliDir(userId, agentType);
  if (!dir) throw Object.assign(new Error(`${agentType} 不支持个人级配置目录`), { status: 400 });
  writeFileSync(join(dir, name), body, "utf8");
}
