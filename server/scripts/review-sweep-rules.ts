// 「一次查全」契约的回归断言。规则表住在 `server/src/review-sweep.ts`——那里同时是派审
// 完整版和续跑缩略版的唯一源。
//
// 这里核的东西跟 `review-summary-rules.ts` 一一对应，只多一条：`short` 允许显式为 null
// （那条规则只在开工时有意义），所以**必须分清「写了 null」和「忘了写」**——类型上
// `short: string | null` 让省略编译不过，这里再核一次 null 的那几条至少没把 `full` 也
// 写空，以及**整张表不能全是 null**（那样缩略版会是空串，续跑路径上一条扫描义务都不剩）。
import assert from "node:assert/strict";
import {
  CLASS_REPAIR_NOTE,
  REVIEW_SWEEP_PROTOCOL,
  REVIEW_SWEEP_REMINDER,
  SWEEP_RULES,
} from "../src/review-sweep.js";

export function assertSweepRuleTable(): void {
  assert.ok(SWEEP_RULES.length > 0, "扫描义务表不能是空的");
  for (const rule of SWEEP_RULES) {
    assert.ok(rule.full.trim().length > 0, `规则「${rule.id}」缺完整版说法`);
    assert.ok(
      rule.short === null || rule.short.trim().length > 0,
      `规则「${rule.id}」的缩略版是空串——要么写出来，要么显式写 null`,
    );
    assert.ok(rule.probes.length > 0, `规则「${rule.id}」没声明探针——它载着规则的那几个字是哪几个？`);
    for (const probe of rule.probes) {
      assert.match(rule.full, probe, `规则「${rule.id}」的完整版漏了 ${probe}`);
      if (rule.short !== null) {
        assert.match(rule.short, probe, `规则「${rule.id}」的缩略版漏了 ${probe}`);
      }
    }
  }
  assert.ok(
    SWEEP_RULES.some((rule) => rule.short !== null),
    "整张表不能全是 null：续跑提醒会变成空串，那条路径上一条扫描义务都不剩",
  );
  // 拼接结果必须真的由表拼成（有人绕过表直接改常量时当场红）。
  assert.ok(
    REVIEW_SWEEP_PROTOCOL.endsWith(SWEEP_RULES.map((rule) => rule.full).join("")),
    "完整版必须由表拼出来",
  );
  assert.equal(
    REVIEW_SWEEP_REMINDER,
    SWEEP_RULES.map((rule) => rule.short).filter((text) => !!text).join(""),
    "缩略版必须由表里 short 非 null 的那几条拼出来",
  );
  assert.ok(
    REVIEW_SWEEP_REMINDER.length < REVIEW_SWEEP_PROTOCOL.length,
    "缩略版比完整版还长的话，续跑路径的长度预算就白设了",
  );
}

/** 这段 prompt 原样带上了完整版扫描义务。 */
export function assertCarriesSweepProtocol(text: string, source: string): void {
  assert.ok(
    text.includes(REVIEW_SWEEP_PROTOCOL),
    `${source} 必须原样带上完整扫描义务（不是碰巧出现几个同名词）`,
  );
}

/** 这段续跑提醒原样带上了缩略版扫描义务。 */
export function assertCarriesSweepReminder(text: string, source: string): void {
  assert.ok(
    text.includes(REVIEW_SWEEP_REMINDER),
    `${source} 必须原样带上缩略扫描义务——中断路径上它是扫描要求唯一的来源`,
  );
}

/** 交回执行者的那段话带上了「类问题照层级修」的口径。 */
export function assertCarriesClassRepairNote(text: string, source: string): void {
  assert.ok(
    text.includes(CLASS_REPAIR_NOTE),
    `${source} 必须带上类问题修复口径，否则「不要扩大边界」会把报出来的类吃掉`,
  );
}
