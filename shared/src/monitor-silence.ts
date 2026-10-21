// 「这条哨兵命令会不会一个字都不吐」—— 两端共用的那一份判据与措辞。
//
// 起因是一次真实的空转（2026-10-20，任务 u7nb4wnGcX2O）：agent 挂了
//   until grep -qE "^(OK|FAILED)" /tmp/x.log 2>/dev/null; do sleep 15; done; grep -E … | tail -3
// 去盯一个全量测试的收尾标记。那个标记最后永远没出现（被等的测试进程中途就没了），于是
// 哨兵从头到尾 0 条事件、日志 0 字节，而「还在等」和「已经没戏了」在界面上长得一模一样。
//
// ── 这里**只说可证实的事实**（第 1 轮审查 F3）────────────────────────────────────
//
// 第一版越界了两次，两次都被真实复现打回：
//  · `while printf 'HEARTBEAT\n'; do sleep 0.02; done` —— 只看 `do … done` 之间就断言整条
//    命令静默，而**循环条件本身也会执行、也会输出**（实测 150ms 内吐了好几行）；
//  · `until true; do sleep 1; done` —— 条件一开始就满足，哨兵正常退出（exitCode=0、日志空），
//    收尾却写成「它等的条件直到最后都没出现」。**没有输出不是「条件没发生」的证据**，
//    而同一张卡上方还写着「命令自己跑完了」，两句话互相打脸。
//
// 所以现在分两层：
//  · **事后**（收尾、卡片）一个字都不猜命令的意图，只陈述能证实的那几样：推了几条事件、
//    日志里读到过没有、它是怎么结束的；
//  · **事前**（创建那一刻）仍然提醒，但措辞是**条件句**而不是断言 —— 它要防的是「挂上去
//    三十分钟后才发现它根本不会说话」，这个价值不需要靠断言换。判据同时收紧：循环体之外，
//    条件里出现任何常见的会写 stdout 的命令就不提示（宁可漏报，不误报）。

/** `until|while <条件>; do <循环体> done` —— 条件和循环体分开拿，两边都要看。 */
const WAIT_LOOP = /\b(?:until|while)\b([\s\S]*?)(?:;|\n)\s*do\b([\s\S]*?)\bdone\b/;

/** 循环体里只剩这些 ⇒ 这一圈自己不出声。 */
const BODY_QUIET = /^(?:\s|;|&|\||:|sleep\s+[\d.]+[smhd]?|true)*$/;

/**
 * 条件里只要出现这些，就**不**声称它不说话。
 *
 * 不是穷举（做不到），而是把「写 stdout 几乎是它唯一用途」的那些挡在外面 —— 第 1 轮审查
 * 实测的 `while printf …` 正落在这里。漏网的那些由条件句措辞兜底：提示说的是「如果它在
 * 条件满足前不出声」，不是「它一定不出声」。
 */
const NOISY_IN_CONDITION = /\b(?:echo|printf|cat|head|tail|wc|date|ls|curl|wget|seq|yes|awk|sed|jq|git|docker|kubectl)\b/;

/**
 * 这条命令**看上去**是「跳出循环之前不出声」的等待循环吗。
 *
 * 只用来决定**要不要给那条以「如果」开头的提示**，不用来对事后发生的事下任何结论。
 */
export function isSilentWaitLoop(command: string): boolean {
  const m = WAIT_LOOP.exec(command);
  if (!m) return false;
  const [, condition, body] = m;
  if (!BODY_QUIET.test(body)) return false;
  // `grep -q` 这类判据恰恰是静默的，所以条件只挡**明显**会写 stdout 的那些。
  return !NOISY_IN_CONDITION.test(condition);
}

/** 把毫秒说成人话。不足一分钟用秒 —— `Math.round(ms/60000)` 会把 1 秒说成「0 分钟」（N3）。 */
export function spanWords(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * 挂这种哨兵时当场回给 agent 的提醒。`null` = 这条命令看不出是静默等待循环。
 *
 * **通篇是条件句**：它要防的那件事（挂上去几十分钟后才发现它根本不会说话）不需要靠断言。
 * 后半截那几条「永远不成立」是那次空转的真实成因，每一条都指向「标记根本不会被写进那个
 * 文件」，而不是「还没写到」。
 */
export function silentWaitNotice(command: string, timeoutMs: number): string | null {
  if (!isSilentWaitLoop(command)) return null;
  return (
    `这看着像一条等待循环。**如果**它在条件满足之前不往 stdout 写东西（\`grep -q\`、\`test\` 这类判据配上只有 sleep 的循环体就是这样），`
    + `那么：中途不会有任何事件，「它还在等」和「它等的东西已经不会来了」在你这边长得一模一样；`
    + `而条件万一永远不成立，你一条事件都收不到，直到 ${spanWords(timeoutMs)}后到期。`
    + "挂之前先确认那个标记真的会被写进去 —— 几种常见的「永远不成立」："
    + "被等的进程已经退出或被杀（它不会再写任何东西了）、标记只走 stderr 而那条命令没有 2>&1、"
    + "标记不在行首而你用了 ^ 锚、那个文件被另一条命令覆盖重写。"
    + "稳妥的写法是把「它已经没了」也并进跳出条件，让这个哨兵在两种结局上都能出声。"
  );
}

/**
 * 收尾时那句「推了多少条」。
 *
 * **只说这两件能证实的事**：推出去了几条、它的日志文件这一刻有多少字节。一个字都不提
 * 「它等的条件」—— 那是运行时的业务事实，这一层看不见（第 1 轮审查 F3 实测：`until true`
 * 的条件一开始就满足，命令正常退出，照样 0 事件 0 输出）。
 *
 * `logBytes` 必须是**对那个日志文件的实际观测**，不是投递游标（第 2 轮审查 R2-4）：
 * `monitors.read_offset` 只在 `pushToTask` **接受投递**时才推进，而终态/归档会把投递挡回、
 * `keepBuffered:false` 会把没投出去的缓冲直接丢掉 —— 那时「日志里明明有字」和「游标是 0」
 * 同时成立，拿游标当输出证据就会断言出一句假话。`null` = 这一刻读不出那个文件，那就照实
 * 说读不出来，不替它下结论。
 */
export function monitorEventTally(events: number, logBytes: number | null): string {
  if (events > 0) return `共推送 ${events} 条事件`;
  if (logBytes === null) return "一条事件都没推，它的日志这一刻也读不出来（有没有产出过，这里说不准）";
  return logBytes > 0
    ? `一条事件都没推：它的日志里有 ${logBytes} 字节输出，但没有一条送到这个任务头上`
    : "一条事件都没推，它的日志文件也是空的";
}
