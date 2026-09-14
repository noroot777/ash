import assert from "node:assert/strict";
import { KEY_CHORD_TIMEOUT_MS, createKeyChordSequence } from "../src/lib/keyChord.ts";
import {
  GO_CHORD_KEYS,
  GO_CHORD_PREFIX,
  SETTINGS_SHORTCUT_LABEL,
  TASK_MODE_SHORTCUT_LABEL,
  isGoChordKey,
} from "../src/workspace/goChord.ts";

const go = createKeyChordSequence(GO_CHORD_PREFIX, isGoChordKey, 1_000);
assert.deepEqual(go.handle("g", 100), { kind: "prefix" });
assert.deepEqual(go.handle("t", 400), { kind: "chord", key: "t" });
// 一轮走完就清空：紧跟着的那下 t 是孤零零一个键，不是上一轮的尾巴。
assert.deepEqual(go.handle("t", 500), { kind: "none" });
assert.deepEqual(go.handle("g", 600), { kind: "prefix" });
assert.deepEqual(go.handle("t", 700), { kind: "chord", key: "t" });

// 大写（按住 Shift 或开着 Caps Lock）走同一条路。
assert.deepEqual(go.handle("G", 1_000), { kind: "prefix" });
assert.deepEqual(go.handle("T", 1_100), { kind: "chord", key: "t" });

// 超时之后那一下不算数，前缀得重按。
assert.deepEqual(go.handle("g", 2_000), { kind: "prefix" });
assert.deepEqual(go.handle("t", 3_001), { kind: "none" });

// 中间按了别的键就作废：`g j t` 不能切模式，得从头再来。
assert.deepEqual(go.handle("g", 4_000), { kind: "prefix" });
assert.deepEqual(go.handle("j", 4_100), { kind: "none" });
assert.deepEqual(go.handle("t", 4_200), { kind: "none" });

// 连着按前缀只是把这一轮往后推，不会自己触发。
assert.deepEqual(go.handle("g", 4_300), { kind: "prefix" });
assert.deepEqual(go.handle("g", 4_400), { kind: "prefix" });
assert.deepEqual(go.handle("t", 4_500), { kind: "chord", key: "t" });

// reset 是「浮层开了、焦点进了输入框」这类场合用的：清掉半截序列，下一下重新开始。
go.reset();
assert.deepEqual(go.handle("t", 4_600), { kind: "none" });
assert.deepEqual(go.handle("g", 4_700), { kind: "prefix" });
go.reset();
assert.deepEqual(go.handle("t", 4_800), { kind: "none" });

// 前缀和第二键相同的那一档（`X X`）：第一下只能算前缀，不能被自己认成第二下。
const doubled = createKeyChordSequence("x", (key) => key === "x", 1_000);
assert.deepEqual(doubled.handle("x", 100), { kind: "prefix" });
assert.deepEqual(doubled.handle("x", 200), { kind: "chord", key: "x" });
assert.deepEqual(doubled.handle("x", 300), { kind: "prefix" });

assert.equal(KEY_CHORD_TIMEOUT_MS, 1_000);
assert.equal(isGoChordKey("t"), true);
assert.equal(isGoChordKey("s"), true);
assert.equal(isGoChordKey("g"), false);
// 展示给用户的键位和实际吃的键不能各说各话。
assert.equal(
  TASK_MODE_SHORTCUT_LABEL.replace(/\s+/g, "").toLowerCase(),
  `${GO_CHORD_PREFIX}${GO_CHORD_KEYS.taskMode}`,
);
assert.equal(
  SETTINGS_SHORTCUT_LABEL.replace(/\s+/g, "").toLowerCase(),
  `${GO_CHORD_PREFIX}${GO_CHORD_KEYS.settings}`,
);
// 同一个前缀下两档不能撞键，否则后加的那一档永远轮不到。
assert.equal(new Set(Object.values(GO_CHORD_KEYS)).size, Object.values(GO_CHORD_KEYS).length);

// G S 走的是同一条序列：前缀之后换个第二键就换一档。
assert.deepEqual(go.handle("g", 6_000), { kind: "prefix" });
assert.deepEqual(go.handle("s", 6_100), { kind: "chord", key: "s" });

console.log("key chord tests passed");
