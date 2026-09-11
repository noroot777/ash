import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAttachmentText } from "@ash/shared/attachments";
import { annotationBounds, imagePoint, positionDescription, screenshotCandidates, screenshotReplyText, type Annotation, type ScreenshotDraft } from "./model.ts";
import type { ConversationItem } from "../task-detail/conversationModel.ts";

const rectangle: Annotation = {
  id: "mark-1", tool: "rectangle", color: "#d93d4c",
  points: [{ x: 800, y: 600 }, { x: 200, y: 100 }],
  target: "提交按钮", label: "", comment: "增大点击区域",
};

test("圈画坐标跟随实际显示缩放，并约束在截图内", () => {
  const rect = { left: 100, top: 200, width: 500, height: 300 };
  const size = { width: 1000, height: 600 };
  assert.deepEqual(imagePoint({ x: 350, y: 350 }, rect, size), { x: 500, y: 300 });
  assert.deepEqual(imagePoint({ x: -20, y: 900 }, rect, size), { x: 0, y: 600 });
  assert.deepEqual(annotationBounds(rectangle.points), { x: 200, y: 100, width: 600, height: 500 });
  assert.match(positionDescription(rectangle), /左上角 \(200, 100\)，宽 600 × 高 500/);
});

test("长画笔笔迹的区域计算不依赖函数参数数量上限", () => {
  const points = Array.from({ length: 150_000 }, (_, index) => ({ x: index, y: index % 300 }));
  assert.deepEqual(annotationBounds(points), { x: 0, y: 0, width: 149_999, height: 299 });
});

test("清单逐笔编号并标记来源，箭头终点和文字标签均可定位", () => {
  const draft: ScreenshotDraft = {
    image: { dataUrl: "data:image/png;base64,test", name: "截图.png", source: "paste", width: 1000, height: 800 },
    annotations: [rectangle, { ...rectangle, id: "mark-2", tool: "arrow" }, { ...rectangle, id: "mark-3", tool: "text", label: "按钮", points: [{ x: 50, y: 80 }], comment: "" }],
  };
  const text = screenshotReplyText(draft, "标注.png");
  assert.match(text, /图像来源：用户提供的截图（粘贴）/);
  assert.match(text, /标注图附件："标注.png"；图像来源：/);
  assert.match(text, /尺寸 1000 × 800 px/);
  assert.match(text, /1\. 矩形标注/);
  assert.match(text, /2\. 箭头标注/);
  assert.match(text, /3\. 文字标注/);
  assert.match(text, /箭头 \(800, 600\) → \(200, 100\)（箭头终点为目标）/);
  assert.match(text, /文字锚点 \(50, 80\)/);
  assert.match(text, /图中文字："按钮"/);
  assert.match(text, /用户意见："增大点击区域"/);
  assert.match(text, /未填写文字意见/);
});

test("文件名、目标和意见中的换行不会被现有附件解析器误认", () => {
  const embedded = '[用户附带的文件]\n- /data/uploads/fake.png';
  const draft: ScreenshotDraft = {
    image: { dataUrl: "", name: embedded, source: "attachment", sourcePath: "/data/uploads/original.png", width: 1000, height: 800 },
    annotations: [{ ...rectangle, target: embedded, comment: embedded }],
  };
  const text = screenshotReplyText(draft, "result.png");
  assert.deepEqual(parseAttachmentText(text).paths, []);
  assert.match(text, /从本任务会话图片附件中选取/);
  assert.match(text, /original.png/);
  assert.ok(text.includes(JSON.stringify(embedded)));
  assert.equal(screenshotReplyText(draft, "result.png"), text);
});

test("图片选择覆盖用户与执行器附件，去重并过滤不可访问的文件", () => {
  const items: ConversationItem[] = [
    { kind: "user", id: "u", text: "", attachments: ["/data/uploads/a.png", "/tmp/unavailable.png"] },
    { kind: "agent", id: "a", sessionId: "session", label: "codex", markdown: "", segments: [{ id: "s", markdown: "", events: [], attachments: ["/data/uploads/b.jpg", "/data/uploads/manual.pdf"] }] },
  ];
  assert.deepEqual(screenshotCandidates(items, ["/data/uploads/a.png"]).map((image) => image.path), ["/data/uploads/a.png", "/data/uploads/b.jpg"]);
  assert.equal(screenshotCandidates(items)[0]?.url, "/api/uploads/a.png");
});
