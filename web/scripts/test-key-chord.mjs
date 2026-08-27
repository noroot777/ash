import assert from "node:assert/strict";
import { KEY_CHORD_TIMEOUT_MS, createKeyChordSequence } from "../src/lib/keyChord.ts";
import {
  TASK_MODE_CHORD_KEY,
  TASK_MODE_SHORTCUT_LABEL,
  isTaskModeChordKey,
} from "../src/workspace/taskScope.ts";

// 前缀键和第二键是同一个（T T）是这套序列最容易写错的一档：第一下必须只作数为前缀、
// 不能立刻被自己认成第二下，第三下又得重新开一轮。
const taskMode = createKeyChordSequence(TASK_MODE_CHORD_KEY, isTaskModeChordKey, 1_000);
assert.deepEqual(taskMode.handle("t", 100), { kind: "prefix" });
assert.deepEqual(taskMode.handle("t", 400), { kind: "chord", key: "t" });
assert.deepEqual(taskMode.handle("t", 500), { kind: "prefix" });
assert.deepEqual(taskMode.handle("t", 700), { kind: "chord", key: "t" });

// 大写（按住 Shift 或开着 Caps Lock）走同一条路。
assert.deepEqual(taskMode.handle("T", 1_000), { kind: "prefix" });
assert.deepEqual(taskMode.handle("T", 1_100), { kind: "chord", key: "t" });

// 超时之后那一下重新算作前缀，而不是补上第二下。
assert.deepEqual(taskMode.handle("t", 2_000), { kind: "prefix" });
assert.deepEqual(taskMode.handle("t", 3_001), { kind: "prefix" });
assert.deepEqual(taskMode.handle("t", 3_100), { kind: "chord", key: "t" });

// 中间按了别的键就作废：`t j t` 不能切模式，得从头再来。
assert.deepEqual(taskMode.handle("t", 4_000), { kind: "prefix" });
assert.deepEqual(taskMode.handle("j", 4_100), { kind: "none" });
assert.deepEqual(taskMode.handle("t", 4_200), { kind: "prefix" });

// reset 是「浮层开了、焦点进了输入框」这类场合用的：清掉半截序列，下一下重新开始。
taskMode.reset();
assert.deepEqual(taskMode.handle("t", 4_300), { kind: "prefix" });
taskMode.reset();
assert.deepEqual(taskMode.handle("t", 4_400), { kind: "prefix" });

// 前缀和第二键不同的那一档（Inspector 的 `I F`）由 test-inspector-shortcuts 覆盖，
// 这里只钉住「非法第二键不算数」这条对任何配置都成立。
const prefixed = createKeyChordSequence("g", (key) => key === "d", 1_000);
assert.deepEqual(prefixed.handle("g", 100), { kind: "prefix" });
assert.deepEqual(prefixed.handle("x", 200), { kind: "none" });
assert.deepEqual(prefixed.handle("g", 300), { kind: "prefix" });
assert.deepEqual(prefixed.handle("d", 400), { kind: "chord", key: "d" });

assert.equal(KEY_CHORD_TIMEOUT_MS, 1_000);
assert.equal(isTaskModeChordKey("t"), true);
assert.equal(isTaskModeChordKey("f"), false);
// 展示给用户的键位和实际吃的键不能各说各话。
assert.equal(TASK_MODE_SHORTCUT_LABEL.replace(/\s+/g, "").toLowerCase(), `${TASK_MODE_CHORD_KEY}${TASK_MODE_CHORD_KEY}`);

console.log("key chord tests passed");
