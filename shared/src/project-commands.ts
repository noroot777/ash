// 项目「常用命令」：项目级的常驻服务/脚本（dev server、watch、metro…），由全局状态栏
// 启动/停止/重启，运行载体是项目终端会话（server/src/terminal.ts，带 commandId 的那类）。
//
// 跟预览（preview.ts）的分界：预览 = 临时、借 $PORT、跑在任务工作区；常用命令 = 常驻、
// 项目自有端口、跑在主仓当前检出的分支上。两份配置刻意不复用 —— 预览服务的语义绑着
// 借端口/enabled 勾选/kind 那一套，混在一起会把两种心智搅浑。
export interface ProjectCommandConfig {
  id: string;
  name: string;
  /** 启动命令，在项目主仓根目录用用户的 shell 执行。 */
  command: string;
  /**
   * 重启时改跑的命令（如 `expo start -c` 这类「带清缓存的启动变体」）。
   * 空/null = 杀掉进程后再跑一遍 `command`。重启永远先杀旧会话 —— 这个字段替换的是
   * 「重新启动用什么命令」，不是「不杀进程的原地重载」。
   */
  restartCommand: string | null;
}

export const MAX_PROJECT_COMMANDS = 12;
export const MAX_PROJECT_COMMAND_LENGTH = 4000;

/** 存进 projects.commands_config 前的校验。null 透传（= 清空配置）。 */
export function parseProjectCommands(value: unknown): ProjectCommandConfig[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error("常用命令配置格式不正确");
  if (value.length > MAX_PROJECT_COMMANDS) throw new Error(`常用命令最多保存 ${MAX_PROJECT_COMMANDS} 条`);
  const ids = new Set<string>();
  const commands = value.map((item): ProjectCommandConfig => {
    if (!item || typeof item !== "object") throw new Error("常用命令配置格式不正确");
    const c = item as Record<string, unknown>;
    if (typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || ids.has(c.id)) throw new Error("命令标识无效或重复");
    ids.add(c.id);
    if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 80) throw new Error("请填写命令名称（最多 80 字）");
    if (typeof c.command !== "string" || !c.command.trim()) throw new Error(`请填写「${c.name}」的启动命令`);
    if (c.command.length > MAX_PROJECT_COMMAND_LENGTH || c.command.includes("\0")) throw new Error("启动命令无效或过长");
    const restart = c.restartCommand ?? null;
    if (restart !== null && (typeof restart !== "string" || restart.length > MAX_PROJECT_COMMAND_LENGTH || restart.includes("\0"))) {
      throw new Error("重启命令无效或过长");
    }
    return {
      id: c.id,
      name: c.name.trim(),
      command: c.command.trim(),
      restartCommand: typeof restart === "string" && restart.trim() ? restart.trim() : null,
    };
  });
  return commands;
}
