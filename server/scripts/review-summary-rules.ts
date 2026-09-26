// 摘要契约的回归断言。规则表本身住在 `server/src/review-report-format.ts`——那里同时
// 是完整版和缩略版的**唯一源**，两个常量都从表里拼出来。
//
// 所以这里不再维护「清单」：第 3 轮加的那张测试侧清单，第 4 轮被发现自己漏登记了排序
// 规则，说明任何一份需要人工同步的副本都会漂。改成拼接之后，「规则在不在两边」由类型
// 系统保证（`short` 必填），这里只补拼接兜不住的两件事：
//
// ① **枚举型规则的内容**——一句话里列了五样东西，改写时掉一样是无声的（缩略版就这么
//    丢过 `git status` 和浏览器通道降级说明）。靠规则自带的 `probes` 逐项核。
// ② **常量有没有真的被塞进 prompt**——断言对象必须是「这段 prompt 里**原样包含**那个
//    常量」，不能是「这段 prompt 里能 grep 到某些关键词」。后者会被旁文喂饱：需求引用、
//    浏览器策略、任务正文里碰巧出现同样的词，格式常量整段删了也照样绿。
import assert from "node:assert/strict";
import {
  REPORT_SUMMARY_FORMAT,
  REPORT_SUMMARY_REMINDER,
  SUMMARY_RULES,
} from "../src/review-report-format.js";

/** 规则表自身的体检：两种说法都得有，枚举型规则两边都得列全。 */
export function assertSummaryRuleTable(): void {
  assert.ok(SUMMARY_RULES.length > 0, "规则表不能是空的");
  for (const rule of SUMMARY_RULES) {
    assert.ok(rule.full.trim().length > 0, `规则「${rule.id}」缺完整版说法`);
    assert.ok(rule.short.trim().length > 0, `规则「${rule.id}」缺缩略版说法——断线续跑那一轮就会丢掉它`);
    for (const probe of rule.probes ?? []) {
      assert.match(rule.full, probe, `规则「${rule.id}」的完整版漏了 ${probe}`);
      assert.match(rule.short, probe, `规则「${rule.id}」的缩略版漏了 ${probe}`);
    }
  }
  // 拼接结果必须真的由表拼成（有人绕过表直接改常量时当场红）。
  assert.equal(REPORT_SUMMARY_FORMAT, SUMMARY_RULES.map((rule) => rule.full).join(""));
  assert.equal(REPORT_SUMMARY_REMINDER, SUMMARY_RULES.map((rule) => rule.short).join(""));
}

/** 这段 prompt 原样带上了完整版契约。 */
export function assertCarriesSummaryFormat(text: string, source: string): void {
  assert.ok(
    text.includes(REPORT_SUMMARY_FORMAT),
    `${source} 必须原样带上完整摘要契约（不是碰巧出现几个同名词）`,
  );
}

/** 这段续跑提醒原样带上了缩略版契约。 */
export function assertCarriesSummaryReminder(text: string, source: string): void {
  assert.ok(
    text.includes(REPORT_SUMMARY_REMINDER),
    `${source} 必须原样带上缩略摘要契约——中断路径上它是格式要求唯一的来源`,
  );
}
