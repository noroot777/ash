// 项目「常用命令」：项目级的常驻服务/脚本（dev server、watch、metro…），由全局状态栏
// 启动/停止/重启，运行载体是项目终端会话（server/src/terminal.ts，带 commandId 的那类）。
//
// 配置分两块：
//   service  —— 项目的「启动 / 重启」：一对命令，操作面是状态栏弹层头部的 ▶/⟳ 图标按钮
//               （没配置就置灰）。整个项目只有这一对,不跟着普通命令逐条长。
//   commands —— 普通常用命令：只有名称 + 命令,重启一律「杀掉进程再跑一遍」。
//
// 跟预览（preview.ts）的分界：预览 = 临时、借 $PORT、跑在任务工作区；常用命令 = 常驻、
// 项目自有端口、跑在主仓当前检出的分支上。两份配置刻意不复用 —— 预览服务的语义绑着
// 借端口/enabled 勾选/kind 那一套，混在一起会把两种心智搅浑。
export interface ProjectCommandConfig {
  id: string;
  name: string;
  /** 在项目主仓根目录用用户的 shell 执行。 */
  command: string;
}

export interface ProjectServiceConfig {
  /** 启动命令。 */
  command: string;
  /**
   * 重启时改跑的命令（如 `expo start -c` 这类「带清缓存的启动变体」）。
   * 空/null = 杀掉进程后再跑一遍 `command`。重启永远先杀旧会话 —— 这个字段替换的是
   * 「重新启动用什么命令」，不是「不杀进程的原地重载」。
   */
  restartCommand: string | null;
}

export interface ProjectCommandsConfig {
  service: ProjectServiceConfig | null;
  commands: ProjectCommandConfig[];
}

/** service 会话在终端层的 commandId（普通命令用自己的随机 id，这个字保留给 service）。 */
export const SERVICE_COMMAND_ID = "service";

export const MAX_PROJECT_COMMANDS = 12;
export const MAX_PROJECT_COMMAND_LENGTH = 4000;

function parseScript(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`请填写${label}`);
  if (value.length > MAX_PROJECT_COMMAND_LENGTH || value.includes("\0")) throw new Error(`${label}无效或过长`);
  return value.trim();
}

function parseServiceConfig(value: unknown): ProjectServiceConfig | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new Error("启动/重启配置格式不正确");
  const s = value as Record<string, unknown>;
  const restartRaw = s.restartCommand ?? null;
  const hasRestart = typeof restartRaw === "string" && restartRaw.trim().length > 0;
  const startRaw = s.command;
  if ((typeof startRaw !== "string" || !startRaw.trim()) && !hasRestart) return null; // 两个都空 = 没配置
  if (typeof startRaw !== "string" || !startRaw.trim()) throw new Error("填了重启命令就必须先填启动命令");
  return {
    command: parseScript(startRaw, "启动命令"),
    restartCommand: hasRestart ? parseScript(restartRaw, "重启命令") : null,
  };
}

function parseCommandList(value: unknown): ProjectCommandConfig[] {
  if (!Array.isArray(value)) throw new Error("常用命令配置格式不正确");
  if (value.length > MAX_PROJECT_COMMANDS) throw new Error(`常用命令最多保存 ${MAX_PROJECT_COMMANDS} 条`);
  const ids = new Set<string>();
  return value.map((item): ProjectCommandConfig => {
    if (!item || typeof item !== "object") throw new Error("常用命令配置格式不正确");
    const c = item as Record<string, unknown>;
    if (typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || ids.has(c.id) || c.id === SERVICE_COMMAND_ID) {
      throw new Error("命令标识无效或重复");
    }
    ids.add(c.id);
    if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 80) throw new Error("请填写命令名称（最多 80 字）");
    if (typeof c.command !== "string" || !c.command.trim()) throw new Error(`请填写「${c.name}」的命令`);
    if (c.command.length > MAX_PROJECT_COMMAND_LENGTH || c.command.includes("\0")) throw new Error("命令无效或过长");
    return { id: c.id, name: c.name.trim(), command: c.command.trim() };
  });
}

/**
 * 存进 projects.commands_config 前的校验。null 透传（= 清空配置），空配置也归一成 null。
 * 兼容旧客户端发来的纯数组（历史形状：每条命令自带 restartCommand），当作普通命令收下 ——
 * 那一代的逐条重启命令已经没有归宿，直接丢弃。
 */
export function parseProjectCommands(value: unknown): ProjectCommandsConfig | null {
  if (value === null) return null;
  const shaped = Array.isArray(value) ? { service: null, commands: value } : value;
  if (!shaped || typeof shaped !== "object") throw new Error("常用命令配置格式不正确");
  const record = shaped as Record<string, unknown>;
  const service = parseServiceConfig(record.service);
  const commands = parseCommandList(record.commands ?? []);
  if (!service && commands.length === 0) return null;
  return { service, commands };
}

/**
 * DB 读侧的归一：列里可能躺着两代形状 —— 旧 = `ProjectCommandConfig[]`（每条带
 * restartCommand），新 = `{ service, commands }`。读出来一律走这里,坏数据宁可丢弃
 * 也不把异常抛到列表接口上。
 */
export function normalizeProjectCommands(value: unknown): ProjectCommandsConfig | null {
  if (!value || typeof value !== "object") return null;
  try {
    return parseProjectCommands(value);
  } catch {
    return null;
  }
}
