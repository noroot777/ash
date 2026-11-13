/**
 * 工作流「跑一条命令」那一站落进时间线的那句话（server/src/workflow-steps.ts 写）。
 *
 * 放在 shared 是因为认老记录的那一头（web 的 legacyNoticeTable.commandVerdict）要跟它逐字对格式：
 * 老记录没有类型，成败只能从这句话里切出来，哪一头改了写法另一头就会认错。web 的测试拿这里的
 * 函数造记录，而不是自己再拼一份。
 */
export const COMMAND_NOTE_HEAD = "跑了一条命令：`";

function shorten(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** 跑完了：输出取尾巴 400 字，裁掉首尾空白；什么都没吐（或只吐空白）就不接换行。 */
export function commandPassedNote(cmd: string, stdout: string, stderr: string): string {
  const out = shorten(`${stdout}${stderr}`, 400);
  return `${COMMAND_NOTE_HEAD}${cmd}\`（通过）${out ? `\n${out}` : ""}`;
}

export type CommandFailure = { stdout?: string; stderr?: string; message?: string; killed?: boolean };

/**
 * 没跑完：原因是超时，或者输出（先 stderr 后 stdout）的尾巴 600 字。
 * 注意原因可以是空串——输出只有空白时它不算「没输出」，不会换成 message，裁完就空了；
 * 那句话就以「（没通过）\n」结尾。
 */
export function commandFailedNote(cmd: string, error: CommandFailure, timeoutMinutes: number): { text: string; reason: string } {
  const reason = error.killed
    ? `超时（${timeoutMinutes} 分钟）`
    : shorten(`${error.stderr ?? ""}${error.stdout ?? ""}` || error.message || "命令失败", 600);
  return { text: `${COMMAND_NOTE_HEAD}${cmd}\`（没通过）\n${reason}`, reason };
}
