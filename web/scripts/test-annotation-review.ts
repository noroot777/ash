import assert from "node:assert/strict";
import { scoreAnnotationCandidate, reliableAnnotationMatch } from "../../shared/src/page-annotation-review.ts";
import type { AnnotationBatch } from "../../shared/src/page-annotation-batch.ts";
import { createReviewStatusReader } from "../src/preview-workspace/reviewStatusReader.ts";
import type { AnnotationReviewStatus } from "../../shared/src/page-annotation-review.ts";
import { annotationFollowup, mergeAnnotationRecord } from "../src/preview-workspace/annotationFollowup.ts";

const context = { route: "/", viewport: { width: 1000, height: 700, scale: 1 }, scroll: { x: 0, y: 300 }, capturedAt: 1 };
const card = { tag: "button", text: "保存设置", role: "button", rect: { x: 100, y: 200, width: 100, height: 50 } };
const match = (candidate = card, selector = true) => scoreAnnotationCandidate(card, candidate, context, context, selector);
assert(reliableAnnotationMatch([match()]));
assert.equal(match({ ...card, text: "永久删除" }), 0, "a reused selector cannot identify different text");
assert(reliableAnnotationMatch([match(card, false)]), "semantic features can find an element after selector changes");
assert(!reliableAnnotationMatch([match(), match()]), "duplicate candidates require manual review");
const scrolled = { ...context, scroll: { x: 0, y: 500 } };
assert.equal(scoreAnnotationCandidate(card, { ...card, rect: { ...card.rect, y: 0 } }, context, scrolled, true), match());
const zoomed = { ...context, viewport: { width: 500, height: 350, scale: 2 }, scroll: { x: 0, y: 150 } };
assert.equal(scoreAnnotationCandidate(card, { ...card, rect: { x: 50, y: 100, width: 50, height: 25 } }, context, zoomed, true), match());
assert.equal(scoreAnnotationCandidate({ ...card, text: "", role: "", tag: "div" }, { ...card, text: "", role: "", tag: "div" }, context, context, true), 0);
assert.equal(mergeAnnotationRecord({ revision: 1, messageId: "m", state: "reviewable" }, { revision: 1, messageId: "m", state: "modifying" }).state, "modifying");
assert.equal(mergeAnnotationRecord({ revision: 2, messageId: "m", state: "modifying" }, { revision: 1, messageId: null, state: "saved" }).revision, 2);
const batch: AnnotationBatch = { id: "sent", taskId: "task-a", gen: "old", serviceId: "web", createdAt: 1,
  items: [{ id: "item", gen: "old", serviceId: "web", documentId: "old-document", number: 1, comment: "原意见", tool: "element",
    element: { ...card, selectors: ["#save"], outerHTML: "", computedStyle: {}, ancestors: [] }, context, points: [{ x: 100, y: 500 }] }],
  evidence: [{ id: "image", annotationId: "item", source: "user-paste", capturedAt: 1, path: "/uploads/record.png", missing: [] }] };
const before = JSON.stringify(batch);
const next = annotationFollowup(batch, batch.items[0], "再放大", "new-batch");
assert.equal(JSON.stringify(batch), before);
assert.equal(next.id, "new-batch"); assert.equal(next.taskId, "task-a");
assert(next.items[0].comment.includes("再放大")); assert(next.items[0].comment.includes("原记录，非新现场"));
assert.equal(next.evidence[0].path, "/uploads/record.png");
assert.deepEqual(next.items[0].context, batch.items[0].context);
console.log("annotation review: selector reuse, ambiguity, scroll/zoom scoring, reversible delivery state and immutable task-scoped followups passed");

let finishRead!: (value: AnnotationReviewStatus) => void;
let reads = 0;
const reader = createReviewStatusReader(() => { reads++; return new Promise((resolve) => { finishRead = resolve; }); });
const firstRead = reader.read();
assert.equal(reader.read(), firstRead, "slow requests are shared, not continuously superseded by polling");
const idle: AnnotationReviewStatus = { canReopen: true, reason: "", taskStatus: "done", previewKind: "free" };
reader.invalidate();
finishRead(idle);
assert.equal(await firstRead, null, "a pending-message event invalidates an in-flight idle response");
const secondRead = reader.read(); finishRead({ ...idle, canReopen: false, reason: "pending" });
assert.equal((await secondRead)?.canReopen, false); assert.equal(reads, 2);
const leavingTask = reader.read(); reader.invalidate(); finishRead(idle);
assert.equal(await leavingTask, null, "unmount/task switch discards the old task response");
console.log("review status: slow-network deduplication, pending-message race and task-switch invalidation passed");
const { reopenDismissed, setReopenDismissed } = await import("../src/preview-workspace/reopenPreference.ts");
const memory = new Map<string, string>();
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key), setItem: (key: string, value: string) => memory.set(key, value) } });
Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
try {
  setReopenDismissed("task-a", true);
  assert.equal(reopenDismissed("task-a"), true, "explicit close persists beyond component state");
  assert.equal(reopenDismissed("task-b"), false, "close preference cannot leak across tasks");
  setReopenDismissed("task-a", false);
  assert.equal(reopenDismissed("task-a"), false, "user can explicitly restore hints");
} finally {
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
}
console.log("review preference: durable explicit close, task isolation and manual restoration passed");
