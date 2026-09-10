import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AnnotationWaiting } from "../src/preview-workspace/AnnotationWaiting.tsx";
import { AnnotationReviewPanel } from "../src/preview-workspace/AnnotationReviewPanel.tsx";
import type { useAnnotationBatch } from "../src/preview-workspace/useAnnotationBatch.ts";
import type { useAnnotationReview } from "../src/preview-workspace/useAnnotationReview.ts";
import type { AnnotationBatchRecord } from "../../shared/src/page-annotation-batch.ts";

Object.assign(globalThis, { React });

const record: AnnotationBatchRecord = { revision: 1, state: "reviewable", messageId: "sent", savedAt: "2026-09-10", deliveredAt: "2026-09-10", error: null,
  review: { releasedAt: "2026-09-10", roundStatus: "done", decisions: [] },
  batch: { id: "batch", taskId: "task-a", gen: "old", serviceId: "web", createdAt: 1,
    items: [{ id: "item", number: 1, comment: "加大按钮", gen: "old", serviceId: "web", documentId: "expired-document", tool: "pin", element: null,
      points: [{ x: 20, y: 400 }], context: { route: "/settings", scroll: { x: 0, y: 300 }, viewport: { width: 1000, height: 700, scale: 1 }, capturedAt: 1 } }],
    evidence: [{ id: "image", annotationId: "item", source: "user-paste", capturedAt: 1, path: "/uploads/original.png", missing: [] }] } };
const controller = { records: [record], busy: false, review: false } as ReturnType<typeof useAnnotationBatch>;
const review = { canPrompt: true, dismissed: false, busy: false, error: "", status: { canReopen: true, reason: "", taskStatus: "done", previewKind: "free" } } as ReturnType<typeof useAnnotationReview>;
const waiting = (props = review) => renderToStaticMarkup(<AnnotationWaiting controller={controller} review={props} starting={false} />);
const html = waiting();
assert(html.includes("这不是可操作页面")); assert(!html.includes("<iframe"));
assert(html.includes("/api/uploads/original.png")); assert(html.includes("加大按钮"));
assert(html.includes("重新打开预览")); assert(html.includes("另存为新批次"));
assert(!waiting({ ...review, canPrompt: false, dismissed: true }).includes(">重新打开预览</button>"));
assert(waiting({ ...review, canPrompt: false, dismissed: true }).includes("已停止自动重开提示"));
assert(!waiting({ ...review, canPrompt: false, status: { ...review.status!, canReopen: false, reason: "后续消息仍在投递" } }).includes(">重新打开预览</button>"));
record.batch.evidence = [];
assert(waiting().includes("未存图像 · 目标摘要"));
const panel = () => renderToStaticMarkup(<AnnotationReviewPanel record={record} item={record.batch.items[0]} match={null}
  ready gen="new-gen" controller={controller} review={review} onLocate={() => {}} onContinue={async () => {}} />);
assert(panel().includes("尚未确认")); assert(panel().includes(">满意</button>")); assert(panel().includes(">继续圈</button>"));
record.review!.decisions = [{ itemId: "item", verdict: "satisfied", gen: "new-gen", savedAt: "2026-09-10" }];
assert(panel().includes("用户确认：满意"));
console.log("annotation presentation: noninteractive waiting evidence, missing-image fallback, dismissed/pending reopen hint and separate per-item satisfaction passed");
