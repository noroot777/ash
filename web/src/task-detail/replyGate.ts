import type { SkillEntry, Task } from "@ash/shared";
import type { CliCommand } from "@ash/shared/cli-commands";

/**
 * 回复框此刻接得住什么。分两层，各有各的去处：
 * - `closed`：整个框用不了（不是单任务、已归档）。输入框灰着，原因写在占位里——那时没有键可指；
 * - `unstarted`：还没跑过，没有会话可续。字照样能打，发得出去的只有服务端当场作答、不起回合的命令
 *   （`/goal --scopes`，server/src/task-cli-command.ts），别的发不出去、原因在发送键上；附件、`@`、叫人、
 *   截图批注这些要有会话才有去处的入口一个不开。
 *
 * 两层曾经并成一个 disabled 直接灰掉输入框：那条命令要从框里的字认出来，框却打不进字。
 */
export interface ReplyGate {
  closed: string | null;
  unstarted: boolean;
  /** 没有会话可说话：`closed` 或 `unstarted`。 */
  mute: boolean;
  /** 空框里占位写的那句原因；null = 照常写「回复…」。 */
  notice: string | null;
  /** 框里这些字发不出去的原因；null = 发得出去。 */
  held: string | null;
}

const UNSTARTED = "先运行任务，再继续回复";

/** 没有会话也答得了的命令：只读任务上存着的东西，不叫 CLI。 */
const answersWithoutSession = (command: CliCommand | null) => command?.name === "goal" && command.args === "--scopes";

export function replyGate(task: Pick<Task, "mode" | "archived" | "status">, hasConversation: boolean, command: CliCommand | null): ReplyGate {
  const closed = task.mode !== "single" ? "请在对应的团队或讨论页面继续操作" : task.archived ? "任务已归档，无法继续回复" : null;
  // 在跑 / 排着的任务说了先排队，这一轮一结束就有会话接。
  const unstarted = !closed && !hasConversation && task.status !== "running" && task.status !== "queued";
  return {
    closed,
    unstarted,
    mute: !!closed || unstarted,
    notice: closed ?? (unstarted ? UNSTARTED : null),
    held: closed ?? (unstarted && !answersWithoutSession(command) ? UNSTARTED : null),
  };
}

/** 还没跑过时斜杠菜单里留下的：有「没有会话也答得了」那一种写法的原生命令。 */
export function sessionlessSkills(skills: SkillEntry[]): SkillEntry[] {
  return skills.filter((skill) => skill.native && skill.command === "/goal");
}
