// 预览开了、起了、收了、启动被取消：服务端不再写这几句，之前落盘的老记录在会话、审查卡、
// 团队页里也都不再出现——不进尾注、不进「N 条记录」、不算条数。没办成的那几句照旧显示。
// Run: npm -w web run test:preview-lifecycle-notices
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SystemEventNote } from "../src/task-detail/SystemNotice.tsx";
import { conversationSystemRows, laneReceipts } from "../src/task-detail/conversationSystemRows.ts";
import { isPreviewLifecycleNotice } from "../src/task-detail/timelineNoticeCopy.ts";

const OPENED = "自由工作流预览已打开（自动识别：npm run dev）：http://localhost:5173/";
const STARTED = "预览已起：http://localhost:5173/（`npm run dev`）";
const RETIRED = "预览已回收（用户关闭了自由工作流预览）：http://localhost:5173/";
const CANCELED = "预览启动已取消（用户关闭了自由工作流预览）";
const CANCELED_DIRTY = "预览启动已取消（用户关闭了自由工作流预览）；仍有进程未退出，后台会继续检查。";

const OPENED_OLD = "自由工作流预览已打开：http://127.0.0.1:49185/";
for (const text of [OPENED, OPENED_OLD, STARTED, RETIRED, CANCELED, `〔系统〕${RETIRED}`, `  ${CANCELED}\n`]) {
  assert.equal(isPreviewLifecycleNotice(text), true, `该拿掉的老记录没认出来：${text}`);
}
for (const text of [
  CANCELED_DIRTY,
  "预览进程已自行退出：http://localhost:5173/",
  "预览已回收：预览脚本 的进程已自行退出，其它服务一并关闭",
  "预览异常：服务退出了",
  "预览没起来（`npm run dev`）\n端口被占用",
  "预览未能回收，工作区已保留：仍有进程未退出",
  "旧预览回收暂缓，任务继续运行。仍有进程未退出",
  "仍有进程未退出，后台会继续检查。（任务重新开跑，旧预览指向的是上一版代码）",
  "开始验收：准备安全合并。",
]) {
  assert.equal(isPreviewLifecycleNotice(text), false, `没办成的那句也被拿掉了：${text}`);
}

const ev = (id: string, text: string, notice?: { kind: "receipt" | "alert" }) => ({
  kind: "item" as const,
  item: { kind: "event" as const, id, text, variant: "note" as const, tone: "neutral" as const, ...(notice ? { notice } : {}) },
});
const agent = (id: string) => ({ kind: "item" as const, item: { kind: "agent" as const, id, segments: [] } as never });
const user = (id: string, text = "你说的", bySystem = false) => ({
  kind: "item" as const, item: { kind: "user" as const, id, text, attachments: [], ...(bySystem ? { bySystem } : {}) },
});
const rowIds = (rows: Array<{ kind: string; id?: string; item?: { id: string } }>) =>
  rows.map((row) => row.kind === "item" ? row.item!.id : row.id);

// 任务会话：同一回合里别的记录照旧在、条数对；整回合只有这几条的，不出「N 条记录」。
{
  const display = conversationSystemRows([
    user("u0"),
    agent("a1"),
    ev("open", OPENED, { kind: "receipt" }),
    ev("other", "审查已预约，这一轮跑完自动开始", { kind: "receipt" }),
    ev("retire", RETIRED, { kind: "receipt" }),
    user("u1"),
    agent("a2"),
    ev("started", STARTED),
    ev("canceled", CANCELED, { kind: "receipt" }),
    user("u2"),
    ev("lonely", RETIRED),
    user("u3"),
    ev("dirty", CANCELED_DIRTY, { kind: "alert" }),
  ]);
  assert.deepEqual(display.receipts.get("a1")?.map((r) => r.id), ["other"], "同一回合别的记录照旧在，预览那两条不算条数");
  assert.equal(display.receipts.has("a2"), false, "整回合只有预览记录，就不该有「N 条记录」");
  assert.equal(display.footnotes.has("a1"), false);
  assert.equal(display.footnotes.has("a2"), false, "预览记录不进尾注");
  assert.deepEqual(
    rowIds(display.rows as never),
    ["u0", "a1", "u1", "a2", "u2", "u3", "footnote:dirty"],
    "落单的预览记录不在原处留「N 条记录」；没收干净那句照旧留着",
  );
}

// 审查卡：卡里的旁注同样不出现。
{
  const lane = laneReceipts({
    complete: false,
    items: [
      agent("r1").item,
      ev("open", OPENED, { kind: "receipt" }).item,
      ev("note", "开始盯：回归测试", { kind: "receipt" }).item,
      ev("retire", RETIRED, { kind: "receipt" }).item,
    ] as never,
  });
  assert.deepEqual(lane.receipts.get("r1")?.map((r) => r.id), ["note"], "审查卡里预览那两条不算条数");
  assert.deepEqual(rowIds(lane.rows as never), ["r1"]);
}

// 验收冲突那张卡：中间夹着一条老的「预览已回收」，前面的上下文照旧收进卡里，它自己不出现。
{
  const display = conversationSystemRows([
    ev("begin", "开始验收：准备安全合并。"),
    ev("retire", "预览已回收（验收清理工作区前回收预览）：http://localhost:5173/"),
    ev("conflict", "冲突交接：已叫醒任务"),
    user("handoff", "【验收未通过 · 需要你解冲突】\n冲突文件：\n- a.ts\n\n请你来解决：", true),
  ]);
  const card = display.rows.find((row) => row.kind === "system-action") as { related: Array<{ id: string }> } | undefined;
  assert.deepEqual(card?.related.map((event) => event.id), ["begin", "conflict"], "冲突卡的流程记录里没有预览那一条，前面的上下文照旧在");
  assert.deepEqual(rowIds(display.rows as never), ["system-action:handoff"]);
}

// 团队页：单独摆的那一句同样不画。
{
  const markup = (text: string) => renderToStaticMarkup(<SystemEventNote item={{ id: "e", text, tone: "neutral", variant: "note" }} />);
  assert.equal(markup(RETIRED), "", "团队页上还画着老的「预览已回收」");
  assert.equal(markup(OPENED), "");
  assert.notEqual(markup(CANCELED_DIRTY), "", "没收干净那句在团队页上不见了");
}

console.log("preview lifecycle notices: ok");
