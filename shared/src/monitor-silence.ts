// 「这条哨兵命令会不会一个字都不吐」—— 两端共用的那一份判据。
//
// 起因是一次真实的空转（2026-10-20，任务 u7nb4wnGcX2O）：agent 挂了
//   until grep -qE "^(OK|FAILED)" /tmp/x.log 2>/dev/null; do sleep 15; done; grep -E … | tail -3
// 去盯一个全量测试的收尾标记。这条命令在标记出现之前**结构上不可能有任何输出**（`grep -q`
// 静默、`sleep` 静默），而那个标记最后永远没出现 —— 被等的测试进程中途就没了。于是哨兵
// 从头到尾 0 条事件、日志 0 字节，而「还在等」和「已经没戏了」在界面上长得一模一样。
//
// 这里不猜命令的意图，只回答一个**结构问题**：循环体里除了 sleep 还有没有别的东西。没有
// ⇒ 循环期间必然零输出，这是可以直说的事实，不是启发式；有 ⇒ 一个字都不说。宁可漏报也
// 不误报 —— 一句说错的提醒比没有提醒更贵。

/** `until|while …; do … done` 里的循环体。null = 没有这种循环。 */
const WAIT_LOOP = /\b(?:until|while)\b[\s\S]*?(?:;|\n)\s*do\b([\s\S]*?)\bdone\b/;

/**
 * 这条命令是不是「跳出循环之前完全静默」的等待循环。
 *
 * 判据只有一条：**循环体里除了 sleep / true / `:` 之外什么都没有**。多一个 `echo`、一个
 * `wc -l`、一个不带 `-q` 的 grep，它就有可能吐字，这里就不再出声。
 */
export function isSilentWaitLoop(command: string): boolean {
  const body = WAIT_LOOP.exec(command)?.[1];
  if (body === undefined) return false;
  const rest = body
    .replace(/\bsleep\s+[\d.]+[smhd]?/g, "")
    .replace(/\btrue\b/g, "")
    .replace(/[:;&|\s]+/g, "");
  return rest === "";
}

/**
 * 挂这种哨兵时当场回给 agent 的提醒。`null` = 这条命令不是静默等待循环。
 *
 * 三句话各自对着一种**真实发生过**的失败：① 静默本身让两种处境无法区分；② 条件永远不
 * 成立时它一条事件都不会推；③ 那次空转的四个具体成因 —— 它们都是「标记根本不会被写进
 * 那个文件」，而不是「还没写到」。
 */
export function silentWaitNotice(command: string, timeoutMs: number): string | null {
  if (!isSilentWaitLoop(command)) return null;
  const minutes = Math.round(timeoutMs / 60_000);
  return (
    "这条命令在跳出等待循环之前不会输出任何东西（循环体里只有 sleep），所以：" +
    "① 中途没有任何事件，「它还在等」和「它等的东西已经不会来了」在你这边长得一模一样；" +
    `② 条件要是永远不成立，你一条事件都收不到，直到 ${minutes} 分钟后到期。` +
    "挂之前先确认那个标记真的会被写进去 —— 几种常见的「永远不成立」：" +
    "被等的进程已经退出或被杀（它不会再写任何东西了）、标记只走 stderr 而那条命令没有 2>&1、" +
    "标记不在行首而你用了 ^ 锚、那个文件被另一条命令覆盖重写。" +
    "稳妥的写法是把「它已经没了」也并进跳出条件，让这个哨兵在两种结局上都能出声。"
  );
}

/**
 * 收尾时那句「推了多少条」。
 *
 * 0 条要**说人话**而不是报一个 0：用户看到「共推送 0 条事件」只能得出「哨兵坏了」，而真相
 * 是这条命令从头到尾没吐出一行。静默等待循环再多给一句结构性的解释 —— 那不是故障，是这条
 * 命令本来就只在条件成立时才说话，它沉默到最后说明条件始终没成立。
 */
export function monitorEventTally(events: number, command: string): string {
  if (events > 0) return `共推送 ${events} 条事件`;
  return isSilentWaitLoop(command)
    ? "一条事件都没推：它等的条件直到最后都没出现，而这条命令在那之前本来就不会说话"
    : "一条事件都没推：这个命令从头到尾没吐出一行";
}
