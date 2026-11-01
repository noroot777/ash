// 子智能体抽屉的展示归约:一条「上游在重试」不许显示成执行异常。
// 跑:npm -w web run test:native-agent-segments
//
// 起因(审查 N1):`level:"notice"` 这一位从主会话一路带到了子线程
// (shared/src/native-work.ts 的 NativeAgentActivity),可展示末端曾经把所有 error 活动一律
// 归约成 `kind:"error"` —— 一场重连风暴在抽屉里就是几百条红色「执行异常」,而它只是在重试。
// 同一份判据在主会话那一侧是 conversationModel 的 `segment.level === "notice"`。
import assert from "node:assert/strict";
import { nativeAgentSegments } from "../src/task-detail/nativeAgentSegments.ts";

const kinds = (activity) => nativeAgentSegments(activity).flatMap((s) => s.events.map((e) => e.kind));

// 重试提示 → notice;真故障 → error。两者必须分得开(否则抽屉里一片红,看不出哪条是真的)。
assert.deepEqual(
  kinds([
    { kind: "error", message: "Reconnecting… waiting for network", level: "notice" },
    { kind: "error", message: "tool crashed" },
  ]),
  ["notice", "error"],
  "子线程的重试提示被显示成了执行异常",
);
// 不带 level 的历史记录照旧按故障显示(缺省不是 notice)。
assert.deepEqual(kinds([{ kind: "error", message: "boom" }]), ["error"], "没带 level 的错误不该被降级");
// 其余活动的归约不受影响。
assert.deepEqual(
  kinds([{ kind: "tool", name: "Bash", detail: "ls" }, { kind: "thinking", text: "想一下" }]),
  ["tool", "thinking"],
  "工具/思考的归约被改坏了",
);

console.log("✓ native-agent-segments (notice vs error)");
