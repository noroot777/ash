// 「这条哨兵命令**自己会不会结束**」—— 创建闸与运行时共用的那一份判据与措辞。
//
// 起因是一次真实的空等（2026-10-21，任务 1Ek9U5dNDGSI）：agent 挂了
//   tail -F <那个任务的输出文件> | grep -E --line-buffered "^Ran |^OK|^FAILED|Traceback|Killed"
// 去盯一轮全量回归。被盯的活早就跑完了，而 `tail -F` 永远不会退出，于是「命令结束」这条
// 唤醒条件在它身上根本不可能触发，只剩到期那一条 —— 整整 30 分钟、0 条事件，白等。
//
// ── 为什么是**闸**而不是提醒 ─────────────────────────────────────────────────────
//
// 同一条命令的作者当然也可以记得加上结束条件，但那是自觉。用户 2026-10-21 问的就是这一句：
// 「你能保证 agent 一定会加吗」—— 不能。所以这一份判据的用法是：命令被判定为「自己永远
// 不会退出」而调用方又没给任何结束条件时，**创建当场 409**，命令一个字都不跑。
//
// ── 误判的代价不对称，所以只认**明确**的那几种 ───────────────────────────────────
//
// 漏判（把一条永不退出的命令放过去）= 退回今天的行为，不比现状坏；误判（把一条会自己结束
// 的命令拦下来）= 一件本来做得成的事做不成了。所以下面每一条都要求「这个写法不退出」是**这个
// 命令形状本身**决定的，而不是靠猜它的意图：`tail -f` 的语义就是不退出，`while true` 没有
// `break` 就是不退出。拿不准的一律不拦。
//
// 对称地，**拦下来一定要给得出出路**，而且三条出路覆盖全部合法意图（见 `endConditionDemand`）。

/** `timeout`/`gtimeout` 带着跑的命令**自带死线**，不管里面是什么都会结束。 */
const TIMED = /(^|[|;&(]\s*)g?timeout\s/;

/**
 * 跟随型：这些命令的语义就是「盯着不走」，放在管道里也一样 —— 它不退出，整条管道就不退出
 * （`tail -f x | grep -m1 y` 也救不了：日志安静下来 `tail` 收不到 SIGPIPE，管道照样挂着）。
 */
const FOLLOWERS: readonly { re: RegExp; what: string }[] = [
  { re: /\btail\s+(?:-\w*[fF]\w*\s|--follow\b)/, what: "tail -f/-F" },
  { re: /\bwatch\s+(?:-\S+\s+)*\S/, what: "watch" },
  { re: /\binotifywait\s+(?:-\w*m\w*\b|--monitor\b)/, what: "inotifywait -m" },
  { re: /\bjournalctl\b[^|;&]*\s(?:-\w*f\w*|--follow)\b/, what: "journalctl -f" },
  { re: /\b(?:kubectl|docker|podman)\s+logs\b[^|;&]*\s(?:-\w*f\w*|--follow)\b/, what: "logs -f" },
  { re: /\bfswatch\b(?![^|;&]*\s-1\b)/, what: "fswatch" },
];

/** `while true` / `until false` 这类恒真循环。循环体里有 `break`/`exit` 就不算。 */
const FOREVER_LOOP = /\b(?:while\s+(?:true|:)|until\s+false)\b([\s\S]*?)\bdone\b/;
const ESCAPES = /\b(?:break|exit|return)\b/;

/**
 * 这条命令**自己永远不会结束**吗。
 *
 * 返回那个判定它的写法（给拒绝文案用），不是的话返回 `null`。只回答形状，不回答意图 ——
 * 「永不退出」本身不是错，错的是**既永不退出、又没有任何别的结束条件**。
 */
export function neverExitsOnItsOwn(command: string): string | null {
  if (TIMED.test(command)) return null;
  for (const { re, what } of FOLLOWERS) if (re.test(command)) return what;
  const loop = FOREVER_LOOP.exec(command);
  if (loop && !ESCAPES.test(loop[1] ?? "")) return "while true / until false";
  return null;
}

/** `stopWhen` 编译结果：`null` = 没给；字符串 = 给了但编不过（那句话直接当 400 回出去）。 */
export type StopWhenCheck = { ok: true; re: RegExp | null } | { ok: false; error: string };

/**
 * 校验并编译 `stopWhen`。**在起进程之前做** —— 编不过的正则等于一个永远不会命中的结束条件，
 * 放进去只会变成另一条「只能等到期」的哨兵，而调用方还以为自己已经设过了。
 */
export function compileStopWhen(pattern: string | null | undefined): StopWhenCheck {
  const raw = typeof pattern === "string" ? pattern.trim() : "";
  if (!raw) return { ok: true, re: null };
  try {
    return { ok: true, re: new RegExp(raw) };
  } catch (error) {
    return {
      ok: false,
      error: `stopWhen 不是一个能用的正则（${error instanceof Error ? error.message : String(error)}）`
        + " —— 编不过的条件永远不会命中，等于没设。按 JS 正则写，比如 \"^(OK|FAILED)\" 或 \"SWEEP_EXIT=\"。",
    };
  }
}

/** 这一批新吐出来的行里，有没有一条命中了约定的结束条件。返回命中的那一行。 */
export function firstStopWhenHit(lines: readonly string[], re: RegExp): string | null {
  for (const line of lines) if (re.test(line)) return line;
  return null;
}

/**
 * 拒绝这次创建时说的那段话。**三条出路要同时给全**：它们分别对应三种合法意图，少给一条就会
 * 把那一种逼成「照抄另一种」—— 比如只给 `stopWhen`，那些「每出现一次就叫我一次」的哨兵就只能
 * 编一个永远不命中的正则来绕过闸。
 */
export function endConditionDemand(what: string): string {
  return (
    `这条命令自己永远不会结束（${what}），而你没有给它任何别的结束条件 —— `
    + "那样它只剩「盯满时长」这一条出路：被盯的活早就跑完了，任务还得干等到期才被叫醒"
    + "（2026-10-21 真实发生过，白等了 30 分钟、0 条事件）。命令一个字都没跑，按你要的那一种改："
    + "\n① **要等一件事干完** —— 把那件事本身放进命令里，它跑完哨兵就结束："
    + "`<跑那件事>; code=$?; <摘要几行>; echo \"EXIT=$code\"`。这是最省事也最准的写法。"
    + "\n② **活已经在别处跑着，只能跟着看** —— 原样保留这条命令，另外传 `stopWhen`：某一行命中它，"
    + "那一行照常推给你，哨兵随即收工。例：`stopWhen: \"^(OK|FAILED|ERROR)\"`。"
    + "（不想写正则也可以改成自退的跟随器：`until grep -q \"DONE\" log; do sleep 5; done; tail -4 log`。）"
    + "\n③ **本来就是要盯到到期** —— 「每出现一次就叫我一次」那种（盯错误日志、盯外部状态变化），"
    + "传 `untilExpiry: true` 明说一声，这次创建就照原样放行。"
  );
}
