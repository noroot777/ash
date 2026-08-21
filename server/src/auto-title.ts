// 从智能体首轮输出里认出它给自己起的标题（`标题：xxx`）。
//
// 为什么是「读输出」而不是「让它调 patch_task 上报」：同 mcp-handoff.ts 顶部第 ① 条
// 口径——提示词约定会忘、会写歪，读它自己吐出来的字才是确定的。而且 ash 不给各 CLI
// 自动注入 MCP 配置（用户手工接），15 个执行器里谁挂着 ash MCP 是环境决定的，解析
// 则对执行器无感：能吐文本就行（duet 那条一次性 `ex.run` 连 MCP 上下文都没有）。
//
// 放宽到「前几行 + 认繁体」是照着现场数据改的。2026-08-21 翻了库里 15 个「该改名却
// 没改成」的单飞任务，逐条对首轮输出：
//   9 个输出的是**繁体「標題」** —— 老正则只认简体，`标` 与 `標` 不是同一个字符；
//   3 个先寒暄了一句（`I'll look at the image first.`）才写标题，而老实现只看第一行；
//   2 个整轮没有标题行（401 认证失败 / 被秒停）——这两个本来就救不回来；
//   1 个疑似被重启接管（接管路径按「标题早解析过了」跳过解析，但打断发生在首段文本之前）。
// 前两类占 12/15，就是这个文件的全部目标。
//
// 缓冲是有代价的：结论出来之前正文不往前端流。所以扫描窗口卡死在「5 个正文行」或
// 「1000 字」，先到为准，之后一律放弃解析、原样放行。引用块行（`>` 开头）不计入行数
// 预算——那是 ash 自己注入的执行诊断（codex 重连提示就长这样），让它吃掉模型的额度
// 是本末倒置。
//
// 窗口还有**第三种关法，不在这个文件里**：缓冲里已经攒着正文时来了个非 text 事件
// （tool/error/…），single-run.ts 会当场 flush 一次把正文放出去——否则那条事件会插到
// 已经产生的正文前面，live 和 trace 的顺序就跟真实输出对不上了。也就是说这里的两个
// 上限是**上界而非保证**：别写出「一定能看到前 5 行」的依赖。
//
// 回归测试：npm -w server run test:auto-title（纯解析 + 事件流两支）

const MAX_LINES = 5;
const MAX_BYTES = 1000;

// 容忍 markdown 包裹：实测见过 `**标题：解释不可运行与审查者模型**` 这种加粗写法。
const TITLE_LINE = /^[\s>*_#`]*[标標][题題]\s*[:：]\s*(.+?)\s*$/;

export type TitleScan =
  | { kind: "buffer" } // 还没有结论，继续攒
  | { kind: "resolved"; title: string | null; text: string };

/** 标题里的装饰字符一律剥掉，再截到库里那一列的长度。 */
export function cleanTitle(raw: string): string {
  return raw.replace(/[`*"「」]/g, "").trim().slice(0, 30);
}

/** 这一行是不是标题行；是就给出洗干净的标题，否则 null。 */
export function parseTitleLine(line: string): string | null {
  const m = line.match(TITLE_LINE);
  if (!m) return null;
  return cleanTitle(m[1]!) || null;
}

/**
 * 扫描首轮输出缓冲区。
 *
 * @param buf   到目前为止攒下的文本
 * @param flush 流已经结束，必须给结论（否则最后一行没有换行时会一直等下去）
 */
export function scanForTitle(buf: string, flush: boolean): TitleScan {
  const lines = buf.split("\n");
  // 最后一段还没遇到换行 = 可能只写了一半，不能拿去匹配（除非流已经结束）。
  const complete = flush ? lines.length : lines.length - 1;
  let budget = 0;
  for (let i = 0; i < complete; i++) {
    const line = lines[i]!;
    const title = parseTitleLine(line);
    if (title) return { kind: "resolved", title, text: dropLine(lines, i) };
    if (!/^\s*>/.test(line)) budget++;
    if (budget >= MAX_LINES) return { kind: "resolved", title: null, text: buf };
  }
  if (flush || buf.length >= MAX_BYTES) return { kind: "resolved", title: null, text: buf };
  return { kind: "buffer" };
}

// 摘掉标题那一行。它后面跟着空行、而且它自己前面要么是空行要么就是开头时，连带把
// 那个空行吃掉，免得正文顶上多出一道空隙（`寒暄\n\n标题：x\n\n正文` 摘完应当是
// `寒暄\n\n正文`，`标题：x\n\n正文` 摘完应当是 `正文`）。
function dropLine(lines: string[], i: number): string {
  const rest = [...lines];
  const blankBefore = i === 0 || rest[i - 1] === "";
  if (blankBefore && rest[i + 1] === "") rest.splice(i, 2);
  else rest.splice(i, 1);
  return rest.join("\n");
}
