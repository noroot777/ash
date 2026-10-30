// 提示词拼装层的**片段保留**不变量:新增一段只许插在片段之间,不许顶掉任何一个 `parts.*`。
//
// 第 1 轮审查 F1 就是这么漏的 —— 产出质量规则那一段当初是**替换** `parts.peerNotice +`
// 加进去的:类型里 `peerNotice` 仍必填、调用方照样算了也传了,只有拼装那一行不再读它。
// 于是「本任务还有其他智能体参与」在首次被 @ 进来、普通续聊、审查三条路上一起消失,
// 而编译通过、当时那一摞样本(同伴字段一律传空)全绿 —— 体积闸任何一张表都量不到。
//
// 为什么单独一个文件、不住在 `test-prompt-budget.ts` 里:那份已经 668 行,这一摞堆进去
// 就破了 700 行上限(第 2 轮审查 F2)。它也确实是**另一件事** —— 那边量「这条消息有多大、
// 哪一段落在哪」,这边量「拼装有没有把交进去的片段弄丢」,两者连样本集都不共用。
//
// 两步闭环,缺一不可:
// ① **声明了的字段必须出现在夹具里**:字段名从生产源码的接口声明里现读,据此造夹具。
//    往接口加一个字段就自动纳入保护 —— 否则第 ② 步只能证明「我列出来的那几个没丢」,
//    新字段照样能悄悄不被读(脚本不过 tsc,少一个键编译器不会吭声)。
// ② **夹具里每个片段都必须活着出现在输出里**:每个字段喂一个独一无二的记号,跨三种调用
//    事实各量一遍(首次新开 / 已有上下文的续跑 / 审查回合)—— 第 1 轮审查点名要覆盖的正是
//    这三种,而它们走的是同一个拼装器。
//
// **能力边界**(第 2 轮审查已单列为不拦事项):声明读取认的是「两空格缩进的属性行」这一种
// 写法,不是通用 TypeScript 结构解析器。改成 `readonly`、接口继承或别的合法写法时,不能
// 推定字段仍会自动纳入 —— 解析读不到字段会当场红(见下面那条 `fields.length > 0`),
// 不会静默放过,但那时要做的是把这里跟着改,而不是以为它还在保着。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** 跑一遍片段保留检查；任何片段被吞或声明读不到都直接抛。 */
export async function assertSegmentRetention(): Promise<void> {
  const turnSrc = readFileSync(new URL("../src/turn-prompt.ts", import.meta.url), "utf8");
  const teamSrc = readFileSync(new URL("../src/team/prompts.ts", import.meta.url), "utf8");
  /** 从生产源码里现读一个 parts 声明的字段名（两空格缩进的属性行；注释行天然不匹配）。 */
  const declaredFields = (text: string, open: string, close: string, what: string): string[] => {
    const start = text.indexOf(open);
    assert.ok(start >= 0, `片段保留闸找不到 ${what} 的声明（${open}）：生产声明换了形状，改这个闸，别改声明`);
    const end = text.indexOf(close, start + open.length);
    assert.ok(end > start, `片段保留闸找不到 ${what} 声明的收尾（${close}）`);
    const fields = [...text.slice(start + open.length, end).matchAll(/^ {2}([A-Za-z]\w*)\??:/gm)].map((hit) => hit[1]!);
    assert.ok(fields.length > 0, `片段保留闸在 ${what} 里一个字段都没读到：解析已经空转了`);
    return fields;
  };
  const mark = (name: string) => `〔片段·${name}〕`;
  /** 每个字符串字段喂一个独一无二的记号；`craft`/`reviewReminder` 按各自的真实形状给。 */
  const fixtureFor = (keys: readonly string[], craft: { freshContext: boolean; verifying: boolean }) =>
    Object.fromEntries(keys.map((key) => [
      key,
      key === "craft" ? craft
        : key === "reviewReminder" ? { text: mark(key), manifestEntry: null }
        : mark(key),
    ])) as never;
  /** 这一份夹具里**应当**活着出现在输出里的那些记号（`craft` 那一格由判据自己定）。 */
  const expectedMarks = (keys: readonly string[]) => keys.filter((key) => key !== "craft").map(mark);

  const turnKeys = declaredFields(turnSrc, "export interface TurnPromptParts {", "\n}", "TurnPromptParts");
  const freshKeys = declaredFields(turnSrc, "export interface FreshPromptParts {", "\n}", "FreshPromptParts");
  const leadKeys = declaredFields(teamSrc, "export const leadFirstMessage = (parts: {", "\n}): string =>", "leadFirstMessage");
  const { assembleFreshPrompt, assembleTurnPrompt } = await import("../src/turn-prompt.js");
  const { leadFirstMessage } = await import("../src/team/prompts.js");
  const { PLANNING_TURN } = await import("../src/run-prompts.js");
  const assemblers: Array<{ what: string; keys: readonly string[]; render: (parts: never) => string }> = [
    { what: "assembleTurnPrompt（续聊/续跑/审查）", keys: turnKeys, render: assembleTurnPrompt },
    { what: "assembleFreshPrompt（fresh run）", keys: freshKeys, render: assembleFreshPrompt },
    { what: "leadFirstMessage（团队开台）", keys: leadKeys, render: leadFirstMessage },
  ];
  const facts = [
    { what: "首次新开（没有旧上下文）", craft: { freshContext: true, verifying: false } },
    { what: "已有上下文的续跑", craft: { freshContext: false, verifying: false } },
    { what: "审查/验证回合", craft: { freshContext: true, verifying: true } },
  ];
  for (const { what, keys, render } of assemblers) {
    // ① 声明的字段必须都在夹具里（夹具就是按 keys 现造的，所以这一条等价于「声明读得到」）。
    assert.ok(keys.includes("craft"),
      `${what} 的 parts 声明里没有 craft：产出质量规则的槽位没了，PLACEMENT 那一行会跟着空转`);
    for (const fact of facts) {
      const out = render(fixtureFor(keys, fact.craft));
      // ② 每个片段都要活着出现在输出里。
      const lost = expectedMarks(keys).filter((needle) => !out.includes(needle));
      assert.deepEqual(lost, [],
        `${what} 在「${fact.what}」这一轮把片段吞掉了：${lost.join("、")}。\n` +
        "新增一段只许插在片段之间，不许替换掉任何一个 `parts.*` —— 这正是第 1 轮审查 F1。");
    }
  }
  // 规划回合那条是位置参数（没有 parts 对象），单独量一次：正文和规则段都要在。
  const { CRAFT_RULES } = await import("../src/craft-rules.js");
  const plan = PLANNING_TURN({ freshContext: true, verifying: false }, mark("userText"));
  assert.ok(plan.includes(mark("userText")) && plan.includes(CRAFT_RULES),
    "PLANNING_TURN 丢了用户正文或规则段：规划开场那条路是「先规划后实施」唯一的注入点");
}
