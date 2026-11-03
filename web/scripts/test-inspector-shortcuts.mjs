import assert from "node:assert/strict";
import {
  activateInspectorShortcut,
  createInspectorShortcutSequence,
  hasInspectorShortcutTarget,
  inspectorShortcutLabel,
  registerInspectorShortcutTarget,
} from "../src/inspector/shortcuts.ts";
import { registerInspectorSectionOwner, revealInspectorSection, subscribeInspectorSection } from "../src/inspector/sections.ts";

const sequence = createInspectorShortcutSequence(1_000);
assert.deepEqual(sequence.handle("i", 100), { kind: "prefix" });
assert.deepEqual(sequence.handle("f", 500), { kind: "chord", key: "f" });
assert.deepEqual(sequence.handle("f", 600), { kind: "none" });

assert.deepEqual(sequence.handle("I", 1_000), { kind: "prefix" });
assert.deepEqual(sequence.handle("I", 1_200), { kind: "chord", key: "i" });

assert.deepEqual(sequence.handle("i", 2_000), { kind: "prefix" });
assert.deepEqual(sequence.handle("f", 3_001), { kind: "none" });

assert.deepEqual(sequence.handle("i", 4_000), { kind: "prefix" });
assert.deepEqual(sequence.handle("x", 4_100), { kind: "none" });
assert.deepEqual(sequence.handle("f", 4_200), { kind: "none" });
assert.equal(inspectorShortcutLabel("r"), "I R");
assert.deepEqual(sequence.handle("i", 5_000), { kind: "prefix" });
assert.deepEqual(sequence.handle("s", 5_100), { kind: "chord", key: "s" });
assert.equal(inspectorShortcutLabel("s"), "I S");
// 后续追问走单键 Q，不占 `I …` 的第二键。
assert.deepEqual(sequence.handle("i", 6_000), { kind: "prefix" });
assert.deepEqual(sequence.handle("q", 6_100), { kind: "none" });

const calls = [];
const unregisterMain = registerInspectorShortcutTarget((key) => {
  calls.push(`main:${key}`);
  return true;
});
assert.equal(hasInspectorShortcutTarget(), true);
assert.equal(activateInspectorShortcut("f"), true);
assert.deepEqual(calls, ["main:f"]);

const unregisterDrawer = registerInspectorShortcutTarget((key) => {
  calls.push(`drawer:${key}`);
  return key !== "e";
});
assert.equal(activateInspectorShortcut("r"), true);
assert.equal(activateInspectorShortcut("e"), false);
assert.deepEqual(calls, ["main:f", "drawer:r", "drawer:e"]);

unregisterDrawer();
assert.equal(activateInspectorShortcut("e"), true);
assert.deepEqual(calls, ["main:f", "drawer:r", "drawer:e", "main:e"]);
unregisterMain();
assert.equal(hasInspectorShortcutTarget(), false);
assert.equal(activateInspectorShortcut("i"), false);

// 面板里某一节的直达请求：没有哪份 Inspector 认得这一节时不算数，调用方好原样放过那颗键。
const opened = [];
const reveals = [];
assert.equal(revealInspectorSection("follow-ups", 9_000), false);
const unregisterTeam = registerInspectorSectionOwner({ has: () => false, open: (id) => opened.push(`team:${id}`) });
assert.equal(revealInspectorSection("follow-ups", 9_100), false);
const unregisterTask = registerInspectorSectionOwner({ has: (id) => id === "follow-ups", open: (id) => opened.push(`task:${id}`) });
// 后挂上的那份（抽屉里套着的）认不得也不挡路：往下找到认得的那份。
const unregisterSectionDrawer = registerInspectorSectionOwner({ has: () => false, open: (id) => opened.push(`drawer:${id}`) });

// 那一格已经挂着就当场送达。
const unsubscribeLive = subscribeInspectorSection("follow-ups", () => reveals.push("live"), 10_000);
assert.deepEqual(reveals, []);
assert.equal(revealInspectorSection("follow-ups", 10_100), true);
assert.deepEqual(opened, ["task:follow-ups"]);
assert.deepEqual(reveals, ["live"]);
unsubscribeLive();

// 那一格要等这次切换渲染完才挂上：请求先挂着，同名节一挂上就领走，且只领一次。
revealInspectorSection("follow-ups", 11_000);
const unsubscribeLate = subscribeInspectorSection("follow-ups", () => reveals.push("late"), 11_050);
assert.deepEqual(reveals, ["live", "late"]);
unsubscribeLate();
const unsubscribeAgain = subscribeInspectorSection("follow-ups", () => reveals.push("again"), 11_060);
assert.deepEqual(reveals, ["live", "late"]);
unsubscribeAgain();

// 别的节不领；过了一个和弦超时没人领的请求作废，之后碰巧挂上的同名节不许自己展开。
revealInspectorSection("follow-ups", 12_000);
const unsubscribeOther = subscribeInspectorSection("other", () => reveals.push("other"), 12_010);
unsubscribeOther();
const unsubscribeStale = subscribeInspectorSection("follow-ups", () => reveals.push("stale"), 13_500);
assert.deepEqual(reveals, ["live", "late"]);

// 卸载只摘自己：新挂上的那份不能被旧的清理函数顺手摘掉。
const unsubscribeNewer = subscribeInspectorSection("follow-ups", () => reveals.push("newer"), 14_000);
unsubscribeStale();
revealInspectorSection("follow-ups", 14_100);
assert.deepEqual(reveals, ["live", "late", "newer"]);
unsubscribeNewer();

unregisterSectionDrawer();
unregisterTask();
assert.equal(revealInspectorSection("follow-ups", 15_000), false);
unregisterTeam();

console.log("inspector shortcut tests passed");
