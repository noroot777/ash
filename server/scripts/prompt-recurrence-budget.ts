// 同类问题熔断（`server/src/review-recurrence.ts`）在提示词上的那几笔账，用户直接问过预算：
//
// - 审查者侧常驻增量 ≤ 320B：`recurs` 字段说明 ≤ 200B + 清单旁那一句 ≤ 120B；
// - 执行者侧常驻增量 = 0；熔断指令**只在触发轮**出现，≤ 300B。
//
// 「其余轮投递态一个字节不变」怎么证：`delivered/repair` 的预算原数没动（棘轮表里那一行），
// 而熔断轮那份样本**去掉那一段指令、把夹具的 run id 换回来**之后，必须和它逐字节相同 ——
// 多出任何别的一个字节都在这里红。
//
// 为什么单独一个文件：`test-prompt-budget.ts` 已经顶到 700 行（同 `prompt-segment-retention.ts`）。
import assert from "node:assert/strict";
import type { PromptSample } from "./prompt-budget-samples.js";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** 单源：每段只许出现在声明的那几份样本里，且每份至多一次。 */
const PLACEMENT: Array<{ name: "RECURS_FIELD_GUIDE" | "RECURRENCE_HINT"; cap: number; where: string[] }> = [
  { name: "RECURS_FIELD_GUIDE", cap: 200, where: ["mcp/report_stage"] },
  // 只在清单真列出了编号时出现：第一轮、折成摘要、就地验证那条线（不编号）都一个字节不发。
  { name: "RECURRENCE_HINT", cap: 120, where: ["section/history-refs"] },
];

export async function assertRecurrenceBudget(samples: PromptSample[]): Promise<void> {
  const shared = await import("@ash/shared/free-workflow");
  for (const { name, cap, where } of PLACEMENT) {
    const text = shared[name];
    assert.ok(bytes(text) <= cap, `${name} 有 ${bytes(text)}B，用户给的上限是 ${cap}B`);
    const hits = samples.filter((sample) => sample.text.includes(text)).map((sample) => sample.id);
    assert.deepEqual(hits.sort(), [...where].sort(), `${name} 的落脚处变了：现在在 ${hits.join("、") || "(没有)"}`);
    for (const id of hits) {
      assert.equal(samples.find((sample) => sample.id === id)!.text.split(text).length - 1, 1,
        `${name} 在 ${id} 里出现了不止一次`);
    }
  }

  const { recurrenceLabel } = await import("../src/review-recurrence.js");
  const header = `【${recurrenceLabel(2)}】`;
  const repair = samples.find((sample) => sample.id === "delivered/repair")!.text;
  const breaker = samples.find((sample) => sample.id === "delivered/repair-breaker")!.text;
  for (const sample of samples.filter((item) => item.id !== "delivered/repair-breaker")) {
    assert.ok(!sample.text.includes("已熔断"), `熔断指令漏进了不该有它的 ${sample.id}：它只许出现在触发轮`);
  }
  const start = breaker.indexOf(`\n\n${header}`);
  assert.ok(start > 0, "熔断轮的修复交接里没有熔断指令");
  const end = breaker.indexOf("\n", start + 2 + header.length) + 1;
  const note = breaker.slice(start, end);
  assert.ok(bytes(note) <= 300, `熔断指令 ${bytes(note)}B，用户给的上限是 300B：\n${note}`);
  assert.equal((breaker.slice(0, start) + breaker.slice(end)).split("pb-run-breaker").join("pb-run"), repair,
    "熔断轮的修复交接去掉那一段指令后，必须和普通修复交接逐字节相同：执行者侧常驻增量必须是 0");
}
