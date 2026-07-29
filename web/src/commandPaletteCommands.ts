export type SlashCommandId = "scope" | "git";

export type SlashCommand = {
  id: SlashCommandId;
  trigger: `/${string}`;
  label: string;
  description: string;
  keywords: string[];
};

// Slash commands are registered here instead of being hard-coded into the
// palette render tree. Adding a command is intentionally a data + handler change.
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "scope",
    trigger: "/scope",
    label: "限定搜索范围",
    description: "按项目和内容类型过滤任务与随手记",
    keywords: ["范围", "项目", "类型", "filter"],
  },
  {
    id: "git",
    trigger: "/git",
    label: "Git 概览",
    description: "查看本地分支与 worktree，不执行写操作",
    keywords: ["分支", "worktree", "仓库", "branch"],
  },
];

export function filterSlashCommands(query: string): SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle || needle === "/") return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((command) =>
    [command.trigger, command.label, command.description, ...command.keywords]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}
