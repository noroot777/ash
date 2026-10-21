// trace 里那条附件事件 → 气泡分段 → 正文里真的画出那张图。
//
// DOM 那份（test:markdown-images）是自己手搓分段喂进组件的，看不见**这一段接缝**：服务端
// 标在附件事件上的 `source` 有没有一路带到分段里。接缝断了的表现跟「功能没做」一模一样
// ——正文里什么都不画、附件卡片照旧挂着，而两边的单元测试全绿。
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { turnImages } from "../src/task-detail/turnImages.ts";

const STARTED = "2026-10-21T08:00:00.000Z";
const session = {
  id: "s1",
  taskId: "t1",
  agentType: "kimi",
  role: "single",
  executor: "kimi@local",
  startedAt: STARTED,
  endedAt: "2026-10-21T08:10:00.000Z",
};
const traced = (at, event) => ({ at, turnStartedAt: STARTED, event });
const uploads = (name) => `/Users/demo/code/ash/data/uploads/${name}`;

// 真实形状：正文 → 附件（服务端收到正文的那一刻就落盘，所以恒在它后面）→ 正文。
// 同一个路径被重拍过两次，两处引用必须各拿自己那一次。
const output = "修改前：\n\n![前](output/shot.png)\n\n修改后：\n\n![后](output/shot.png)\n";
const trace = [
  traced("2026-10-21T08:01:00.000Z", { kind: "text", text: "修改前：\n\n![前](output/shot.png)\n\n" }),
  traced("2026-10-21T08:01:01.000Z", { kind: "attachment", path: uploads("aaaaaaaaaaaa-shot.png"), source: "output/shot.png" }),
  traced("2026-10-21T08:02:00.000Z", { kind: "text", text: "修改后：\n\n![后](output/shot.png)\n" }),
  traced("2026-10-21T08:02:01.000Z", { kind: "attachment", path: uploads("bbbbbbbbbbbb-shot.png"), source: "output/shot.png" }),
  // 正文没提它（工具结果截图那类），没有 source。
  traced("2026-10-21T08:02:02.000Z", { kind: "attachment", path: uploads("cccccccccccc-tool.png") }),
];

const items = buildConversationItems([{ session, output, trace }], [session], []);
const turns = items.filter((item) => item.kind === "agent");
assert.equal(turns.length, 1);

// ① 接缝：来源标注一路带到了分段上，且逐处引用各一条（同一个 source 两条）。
const sources = turns[0].segments.flatMap((segment) => segment.attachmentSources ?? []);
assert.deepEqual(
  sources.map((item) => [item.source, item.path.split("/").pop()]),
  [["output/shot.png", "aaaaaaaaaaaa-shot.png"], ["output/shot.png", "bbbbbbbbbbbb-shot.png"]],
  "服务端标的 source 必须按事件顺序带到分段里",
);

// ② 配对：两处引用各自那一次的字节，按出场顺序。
const claimed = turnImages(turns[0].segments);
const markdown = claimed.map((segment) => segment.markdown).join("");
assert.match(markdown, /!\[前\]\(\/api\/uploads\/aaaaaaaaaaaa-shot\.png\)/, "「修改前」那句画第一次的字节");
assert.match(markdown, /!\[后\]\(\/api\/uploads\/bbbbbbbbbbbb-shot\.png\)/, "「修改后」那句画第二次的字节");

// ③ 画进正文的撤出卡片排，正文没提的留着。
assert.deepEqual(
  claimed.flatMap((segment) => segment.attachments).map((path) => path.split("/").pop()),
  ["cccccccccccc-tool.png"],
  "已经画进正文的不该再挂卡片；正文没提的那张照旧",
);

// ④ 没有 source 的历史消息：原样返回同一份引用，什么都不改（省掉下游重渲染）。
const legacy = [{ id: "x:0", markdown: "![旧](output/gone.png)", events: [], attachments: [uploads("dddddddddddd-x.png")] }];
assert.equal(turnImages(legacy), legacy, "一条都配不上时要原样返回入参");

console.log("回合图片配对(trace → 分段 → 正文)回归通过");
