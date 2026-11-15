import assert from "node:assert/strict";
import { prerequisiteOptions } from "../src/lib/prerequisiteOptions.ts";

// 「建在谁上面」的下拉（新建面板与「信息」格共用）：候选全部列出不过滤；不能选的置灰、右边写服务端给的原因、
// 沉到底；能选的右边写它此刻到哪一步了；已经选进来的不再列。
const c = (taskId, extra = {}) => ({ taskId, title: taskId, groupId: null, problem: null, step: "running", round: null, ...extra });
const groups = [{ id: "g1", name: "前端" }];
const options = prerequisiteOptions([
  c("team", { problem: "团队任务", step: null }),
  c("a", { groupId: "g1" }),
  c("shelved", { problem: "已归档", step: null }),
  c("b", { step: "reviewing", round: 2 }),
  c("picked"),
], groups, ["picked"]);
assert.deepEqual(options.map((option) => option.value), ["a", "b", "team", "shelved"], "能选的在上、置灰的沉底，已选的不再列");
assert.deepEqual(options.map((option) => option.detail), ["在跑", "在审第 2 轮", "团队任务", "已归档"]);
assert.deepEqual(options.map((option) => !!option.disabled), [false, false, true, true]);
assert.equal(options[0].group, "前端");
assert.equal(options[1].group, "无分组");
console.log("prerequisite options: all assertions passed");
