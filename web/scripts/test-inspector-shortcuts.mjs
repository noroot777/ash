import assert from "node:assert/strict";
import {
  activateInspectorShortcut,
  createInspectorShortcutSequence,
  hasInspectorShortcutTarget,
  inspectorShortcutLabel,
  registerInspectorShortcutTarget,
} from "../src/inspector/shortcuts.ts";

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

console.log("inspector shortcut tests passed");
