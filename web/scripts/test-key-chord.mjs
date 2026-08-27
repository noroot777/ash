import assert from "node:assert/strict";
import { KEY_CHORD_TIMEOUT_MS, createKeyChordSequence } from "../src/lib/keyChord.ts";
import {
  TASK_MODE_CHORD_KEY,
  TASK_MODE_CHORD_PREFIX,
  TASK_MODE_SHORTCUT_LABEL,
  isTaskModeChordKey,
} from "../src/workspace/taskScope.ts";

const taskMode = createKeyChordSequence(TASK_MODE_CHORD_PREFIX, isTaskModeChordKey, 1_000);
assert.deepEqual(taskMode.handle("g", 100), { kind: "prefix" });
assert.deepEqual(taskMode.handle("t", 400), { kind: "chord", key: "t" });
// 一轮走完就清空：紧跟着的那下 t 是孤零零一个键，不是上一轮的尾巴。
assert.deepEqual(taskMode.handle("t", 500), { kind: "none" });
assert.deepEqual(taskMode.handle("g", 600), { kind: "prefix" });
assert.deepEqual(taskMode.handle("t", 700), { kind: "chord", key: "t" });

// 大写（按住 Shift 或开着 Caps Lock）走同一条路。
assert.deepEqual(taskMode.handle("G", 1_000), { kind: "prefix" });
assert.deepEqual(taskMode.handle("T", 1_100), { kind: "chord", key: "t" });

// 超时之后那一下不算数，前缀得重按。
assert.deepEqual(taskMode.handle("g", 2_000), { kind: "prefix" });
assert.deepEqual(taskMode.handle("t", 3_001), { kind: "none" });

// 中间按了别的键就作废：`g j t` 不能切模式，得从头再来。
assert.deepEqual(taskMode.handle("g", 4_000), { kind: "prefix" });
assert.deepEqual(taskMode.handle("j", 4_100), { kind: "none" });
assert.deepEqual(taskMode.handle("t", 4_200), { kind: "none" });

// 连着按前缀只是把这一轮往后推，不会自己触发。
assert.deepEqual(taskMode.handle("g", 4_300), { kind: "prefix" });
assert.deepEqual(taskMode.handle("g", 4_400), { kind: "prefix" });
assert.deepEqual(taskMode.handle("t", 4_500), { kind: "chord", key: "t" });

// reset 是「浮层开了、焦点进了输入框」这类场合用的：清掉半截序列，下一下重新开始。
taskMode.reset();
assert.deepEqual(taskMode.handle("t", 4_600), { kind: "none" });
assert.deepEqual(taskMode.handle("g", 4_700), { kind: "prefix" });
taskMode.reset();
assert.deepEqual(taskMode.handle("t", 4_800), { kind: "none" });

// 前缀和第二键相同的那一档（`X X`）：第一下只能算前缀，不能被自己认成第二下。
const doubled = createKeyChordSequence("x", (key) => key === "x", 1_000);
assert.deepEqual(doubled.handle("x", 100), { kind: "prefix" });
assert.deepEqual(doubled.handle("x", 200), { kind: "chord", key: "x" });
assert.deepEqual(doubled.handle("x", 300), { kind: "prefix" });

assert.equal(KEY_CHORD_TIMEOUT_MS, 1_000);
assert.equal(isTaskModeChordKey("t"), true);
assert.equal(isTaskModeChordKey("g"), false);
// 展示给用户的键位和实际吃的键不能各说各话。
assert.equal(
  TASK_MODE_SHORTCUT_LABEL.replace(/\s+/g, "").toLowerCase(),
  `${TASK_MODE_CHORD_PREFIX}${TASK_MODE_CHORD_KEY}`,
);

console.log("key chord tests passed");
