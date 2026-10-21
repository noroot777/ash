// trace 里那条附件事件 → 气泡分段 → 正文里真的画出那张图。
//
// DOM 那份（test:markdown-images）是自己手搓分段喂进组件的，看不见**这一段接缝**：服务端
// 标在附件事件上的 `source` 有没有一路带到分段里。接缝断了的表现跟「功能没做」一模一样
// ——正文里什么都不画、附件卡片照旧挂着，而两边的单元测试全绿。
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { turnImages } from "../src/task-detail/turnImages.ts";
import { taskFilePath } from "../src/components/markdownPolicy.ts";

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

// ④ 没有 source 的历史消息 + 不知道是哪个任务：原样返回同一份引用（省掉下游重渲染）。
const legacy = [{ id: "x:0", markdown: "![旧](output/gone.png)", events: [], attachments: [uploads("dddddddddddd-x.png")] }];
assert.equal(turnImages(legacy), legacy, "一条都配不上时要原样返回入参");

// ⑤ 存量消息的唯一出路：知道是哪个任务，就改写成「现在去那个工作目录里取」。
// 用户 2026-10-21 报的那一幕正是这一类——落盘是那天才加的,那之前说过的图一份拷贝都没有,
// 而文件还好好躺在工作目录里（他自己的「生成物」截图就能看见那几个文件）。
const live = turnImages(legacy, "C0ojRgeQnMsa");
assert.notEqual(live, legacy, "知道任务时要改写,不能原样返回");
assert.equal(
  live[0].markdown,
  "![旧](/api/tasks/C0ojRgeQnMsa/file/raw?path=output%2Fgone.png&workspaceOnly=1)",
  "没有快照拷贝的引用改写到任务工作目录的原始字节接口",
);
assert.deepEqual(live[0].attachments, [uploads("dddddddddddd-x.png")], "实时那一档不认领附件卡片");

// ⑥ **快照优先**:有拷贝时一律画拷贝——那是 agent 说那句话时的那一张,工作目录里的已经
// 可能被改过了。顺序反了就会出现「结论说修改前、画出来是改完以后」。
const snapshot = turnImages(turns[0].segments, "C0ojRgeQnMsa");
assert.match(
  snapshot.map((segment) => segment.markdown).join(""),
  /!\[前\]\(\/api\/uploads\/aaaaaaaaaaaa-shot\.png\)/,
  "有快照就不走实时那一档",
);

// ⑦ 取不到的几种一个字都不改:站外地址、站内绝对地址、爬出工作目录的 `..`。
const untouched = [{
  id: "y:0",
  markdown: "![站外](https://example.invalid/a.png)\n![站内](/api/uploads/x.png)\n![越界](../../etc/x.png)",
  events: [],
  attachments: [],
}];
assert.equal(
  turnImages(untouched, "C0ojRgeQnMsa")[0].markdown,
  untouched[0].markdown,
  "站外/站内绝对地址/越界路径都不许改写成任务文件地址",
);

// ⑧ 目的地 → 任务工作目录里的那个文件（`taskFilePath` 的口径,跟服务端 resolveInRoot 对齐）。
for (const [destination, expected] of [
  ["output/shot.png", "output/shot.png"],
  ["./output/shot.png", "output/shot.png"],
  ["output/%E7%BB%93%E6%9E%9C%20%E5%9B%BE.png", "output/结果 图.png"],
  ["output/shot.png?v=2", "output/shot.png"],
  ["/Users/fjh/code/harness/output/shot.png", "/Users/fjh/code/harness/output/shot.png"],
  ["file:///Users/fjh/code/harness/output/shot.png", "/Users/fjh/code/harness/output/shot.png"],
  ["D:/ai_workspace/ash/output/shot.png", "D:/ai_workspace/ash/output/shot.png"],
  ["D:\\ai_workspace\\ash\\output\\shot.png", "D:\\ai_workspace\\ash\\output\\shot.png"],
  ["https://example.invalid/a.png", null],
  ["/api/uploads/x.png", null],
  ["../x.png", null],
  ["output/../../x.png", null],
  ["", null],
]) {
  assert.equal(taskFilePath(destination), expected, `taskFilePath(${JSON.stringify(destination)})`);
}

console.log("回合图片配对(trace → 分段 → 正文)回归通过");
