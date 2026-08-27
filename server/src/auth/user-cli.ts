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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentType, PersonalCliEnv, PersonalSkill } from "@ash/shared";
import { DATA_DIR } from "../paths.js";

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
 * seed 只有两样,都属于「确定无害」:
 *  · `skills/` 空目录:让「个人技能」这一层从第一天起就存在,不必等第一次上传。
 *  · claude 的 `.claude.json`:只写 onboarding 完成标记。CLI 首跑会自己在这个目录里
 *    生成这份文件(探针②),我们只是把「别再问一遍引导问题」这一位先摆好。
 *    **不预置任何 model / permissions / env** —— 那些会改变 CLI 行为,而探针③ 表明
 *    带 key 的首跑本来就有一个未定位的挂起,再加变量只会让排查更难。
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
  };
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
