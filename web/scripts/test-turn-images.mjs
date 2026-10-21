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
  traced("2026-10-21T08:01:01.000Z", { kind: "attachment", path: uploads("aaaaaaaaaaaa-shot.png"), source: "output/shot.png", ref: 0 }),
  traced("2026-10-21T08:02:00.000Z", { kind: "text", text: "修改后：\n\n![后](output/shot.png)\n" }),
  traced("2026-10-21T08:02:01.000Z", { kind: "attachment", path: uploads("bbbbbbbbbbbb-shot.png"), source: "output/shot.png", ref: 1 }),
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

// ⑧ **明确没有副本**的那处引用才退到当前文件(服务端读不到文件、格式不认、写盘失败时
// 就是这一条:带 source/ref、没有 path)。没有这条交代,展示端分不清「从没存过」和「关联
// 丢了」——后者退到当前文件就是审查第 1 轮 F1 实测 B 那一幕。
const missing = [{
  id: "m:0",
  markdown: "![没存下](output/missing.png)",
  events: [],
  attachments: [],
  attachmentSources: [{ source: "output/missing.png", ref: 0 }],
}];
assert.equal(
  turnImages(missing, "C0ojRgeQnMsa")[0].markdown,
  "![没存下](/api/tasks/C0ojRgeQnMsa/file/raw?path=output%2Fmissing.png&workspaceOnly=1)",
  "明确没有副本 → 现在去工作目录取",
);

// ⑨ 正文里的引用序列跟记录**对不上**(契约保证过每处引用恒有一条,这里两处却只记了一
// 条)→ 记录过的那几处**一处都不画**,显式作废。
//
// 为什么连第一处也不画:对不上说明「这段正文不是服务端扫过的那一段」,那时「第一处」未必
// 就是记录的那一条 —— 展示端有一条按权威 .md 重建正文的恢复分支,重建出来可能只剩最后一
// 句,于是幸存的那处引用其实是第三处。按位置顶上去画出来的恰好是错的那张(审查第 2 轮
// F1:正文写蓝色、画出来是红色)。拷贝全部留在附件卡片里点得开,宁可让人自己点。
const shortQueue = [{
  id: "q:0",
  markdown: "![一](output/s.png) ![二](output/s.png)",
  events: [],
  attachments: [uploads("eeeeeeeeeeee-s.png")],
  attachmentSources: [{ path: uploads("eeeeeeeeeeee-s.png"), source: "output/s.png", ref: 0 }],
}];
const short = turnImages(shortQueue, "C0ojRgeQnMsa");
assert.equal(
  short[0].markdown,
  "![一](#ash-image-unavailable:output%2Fs.png) ![二](#ash-image-unavailable:output%2Fs.png)",
  "对不上就显式作废:作废**不能**靠「原样留着」表达,否则下一个 resolver 又把它救活成当前文件",
);
assert.deepEqual(
  short[0].attachments,
  [uploads("eeeeeeeeeeee-s.png")],
  "一处都没领走,那份拷贝必须留在卡片里 —— 画不出来不等于让人拿不到",
);

// ⑨' 序列**对得上**就按位置逐处认领(红→蓝→红:第三处回到第一份拷贝,不是按来源取第一个)。
const abaSources = [
  { path: uploads("1111eeeeeeee-shot.png"), source: "output/shot.png", ref: 0 },
  { path: uploads("2222ffffffff-shot.png"), source: "output/shot.png", ref: 1 },
  { path: uploads("1111eeeeeeee-shot.png"), source: "output/shot.png", ref: 2 },
];
assert.equal(
  turnImages([{
    id: "aba:0",
    markdown: "改前：![改前](output/shot.png)\n\n改后：![改后](output/shot.png)\n\n回滚了：![恢复](output/shot.png)",
    events: [],
    attachments: abaSources.map((item) => item.path),
    attachmentSources: abaSources,
  }], "C0ojRgeQnMsa")[0].markdown,
  "改前：![改前](/api/uploads/1111eeeeeeee-shot.png)\n\n改后：![改后](/api/uploads/2222ffffffff-shot.png)\n\n回滚了：![恢复](/api/uploads/1111eeeeeeee-shot.png)",
  "三处引用各拿自己那一次",
);

// ⑨'' 分段**不许改变配对与解析**:同一条消息被附件事件切成两段时,拼回去才是 agent 说的
// 那一段(审查第 2 轮 F2:切段让一对反引号被切开,里面的写法示例在后半段里成了真图)。
const split = turnImages([
  { id: "sp:0", markdown: "示例 `![示例](output/x.png)", events: [], attachments: [] },
  {
    id: "sp:1",
    markdown: "` 真图：![真图](output/y.png)",
    events: [],
    attachments: [uploads("3333aaaaaaaa-y.png")],
    attachmentSources: [{ path: uploads("3333aaaaaaaa-y.png"), source: "output/y.png", ref: 0 }],
  },
], "C0ojRgeQnMsa");
assert.equal(split[0].markdown, "示例 `![示例](output/x.png)", "行内代码里的示例一个字都不许改写");
assert.equal(
  split[1].markdown,
  "` 真图：![真图](/api/uploads/3333aaaaaaaa-y.png)",
  "真图照旧认领;改写落在它自己那一段里",
);

// ⑩ 老数据(一条 ref 都没有)队列取空了:仍退到当前文件 —— 那时服务端按字节去重,同一张
// 图被引用两次只留了一条记录,而「现在去工作目录取」是存量消息唯一的出路。
const legacyQueue = [{
  id: "l:0",
  markdown: "![一](output/s.png) ![二](output/s.png)",
  events: [],
  attachments: [uploads("ffffffffffff-s.png")],
  attachmentSources: [{ path: uploads("ffffffffffff-s.png"), source: "output/s.png" }],
}];
assert.equal(
  turnImages(legacyQueue, "C0ojRgeQnMsa")[0].markdown,
  "![一](/api/uploads/ffffffffffff-s.png) ![二](/api/tasks/C0ojRgeQnMsa/file/raw?path=output%2Fs.png&workspaceOnly=1)",
  "老数据的第二处引用退到当前文件",
);

// ⑪ trace 与权威正文**真发散**时的兜底单段:关联不能跟着分段一起丢。丢了的后果是正文
// 配不上已经存着的正确副本,读时兜底又拿当前文件去画(说的是红图、画出来是蓝图;
// 审查第 1 轮 F1 实测 B)。
const divergedOutput = "权威正文说的是这张：\n\n![图](output/shot.png)\n";
const divergedItems = buildConversationItems([{
  session,
  output: divergedOutput,
  trace: [
    traced("2026-10-21T08:03:00.000Z", { kind: "text", text: "另一种说法，跟权威正文互不包含：![图](output/shot.png)\n" }),
    traced("2026-10-21T08:03:01.000Z", { kind: "attachment", path: uploads("99999999999a-shot.png"), source: "output/shot.png", ref: 0 }),
  ],
}], [session], []);
const diverged = divergedItems.filter((item) => item.kind === "agent")[0].segments;
assert.equal(diverged.length, 1, "真发散时退回单段");
assert.deepEqual(
  (diverged[0].attachmentSources ?? []).map((item) => item.source),
  ["output/shot.png"],
  "兜底单段必须保住「哪一处引用对哪份拷贝」",
);
assert.equal(
  turnImages(diverged, "C0ojRgeQnMsa")[0].markdown,
  "权威正文说的是这张：\n\n![图](/api/uploads/99999999999a-shot.png)",
  "关联还在就画那份副本,不许退到当前文件",
);

// ⑪' **投影重建**那一路:trace 记了三处引用(红→蓝→红),权威 .md 只剩最后一句。
// 这是审查第 2 轮 F1 的实测用例 —— 旧实现按「来源队列取第一个」把幸存的那句话配给了**红
// 图**,正文写着「已经改为蓝色」。现在序列对不上就一处都不画,三份拷贝全留在卡片里。
const projectionItems = buildConversationItems([{
  session,
  output: "最终结论：已经改为蓝色\n\n![最终](output/take.png)\n",
  trace: [
    traced("2026-10-21T08:04:00.000Z", { kind: "text", text: "改前：![改前](output/take.png)\n" }),
    traced("2026-10-21T08:04:01.000Z", { kind: "attachment", path: uploads("aaaa11111111-take.png"), source: "output/take.png", ref: 0 }),
    traced("2026-10-21T08:04:02.000Z", { kind: "text", text: "改后：![改后](output/take.png)\n" }),
    traced("2026-10-21T08:04:03.000Z", { kind: "attachment", path: uploads("bbbb22222222-take.png"), source: "output/take.png", ref: 1 }),
    traced("2026-10-21T08:04:04.000Z", { kind: "text", text: "回滚：![恢复](output/take.png)\n" }),
    traced("2026-10-21T08:04:05.000Z", { kind: "attachment", path: uploads("aaaa11111111-take.png"), source: "output/take.png", ref: 2 }),
  ],
}], [session], []);
const projected = projectionItems.filter((item) => item.kind === "agent")[0].segments;
const painted = turnImages(projected, "C0ojRgeQnMsa");
assert.equal(
  painted.map((segment) => segment.markdown).join("").includes("/api/uploads/"),
  false,
  "正文只剩一句、记录却有三条:一处都不许按位置顶上去 —— 顶出来的恰好是红图",
);
assert.match(
  painted.map((segment) => segment.markdown).join(""),
  /#ash-image-unavailable:/,
  "作废要显式表达,这样任何 resolver 都救不活它",
);
assert.deepEqual(
  [...new Set(painted.flatMap((segment) => segment.attachments))].sort(),
  [uploads("aaaa11111111-take.png"), uploads("bbbb22222222-take.png")].sort(),
  "两份拷贝都留在卡片里:画不出来不等于让人拿不到",
);

// ⑫ 扫描器跟渲染器同一套语义(F2):带括号的文件名要完整改写,四空格缩进的写法示例一个
// 字都不许动(渲染器把它画成代码),引用式图照样认(渲染器照样画)。
const semantics = [{
  id: "s:0",
  markdown: "真图：![截图](output/result(1).png)\n\n写法示例：\n\n    ![示例](output/shot.png)\n\n引用式：![图][ref]\n\n[ref]: output/ref.png\n",
  events: [],
  attachments: [],
}];
assert.equal(
  turnImages(semantics, "C0ojRgeQnMsa")[0].markdown,
  "真图：![截图](</api/tasks/C0ojRgeQnMsa/file/raw?path=output%2Fresult(1).png&workspaceOnly=1>)\n\n写法示例：\n\n    ![示例](output/shot.png)\n\n引用式：![图](/api/tasks/C0ojRgeQnMsa/file/raw?path=output%2Fref.png&workspaceOnly=1)\n\n[ref]: output/ref.png\n",
  // 地址里带括号时必须 `<>` 包起来,否则 CommonMark 在第一个括号处就截断(见 shared 的 rewriter)。
  "括号文件名完整、缩进代码原样、引用式图认得出来",
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
  // 合法的 POSIX 根列不全,所以判据是「站内路由才是网址」而不是「顶层目录白名单」
  // (审查第 1 轮 F3:上一版照搬磁盘根白名单,这几条全被当成站内地址拒掉)。
  ["/System/Volumes/Data/Users/fjh/output/shot.png", "/System/Volumes/Data/Users/fjh/output/shot.png"],
  ["/data/work/shot.png", "/data/work/shot.png"],
  ["/app/output/shot.png", "/app/output/shot.png"],
  ["/code/harness/output/shot.png", "/code/harness/output/shot.png"],
  ["/projects/x/shot.png", "/projects/x/shot.png"],
  ["https://example.invalid/a.png", null],
  ["/api/uploads/x.png", null],
  ["/assets/index-abc123.png", null],
  ["/review/x.png", null],
  ["/mobile/app/x.png", null],
  ["../x.png", null],
  ["output/../../x.png", null],
  ["", null],
]) {
  assert.equal(taskFilePath(destination), expected, `taskFilePath(${JSON.stringify(destination)})`);
}

// ⑬ 已经有正主的地址不许被「去工作目录取」抢走（真实数据上撞到的一幕：审查者在结论里
// 引用自己那几张证据截图，被改写成任务工作目录的 raw 地址之后 400、整张被收掉）。
const owned = [{
  id: "o:0",
  markdown: [
    "证据：![证据](/Users/fjh/code/harness/data/runs/kCIlzUlQsB9w/free-review/P6pTi1-Ksavv/round-2/team.png)",
    "",
    "附件：![附件](/api/uploads/99999999999a-shot.png)",
    "",
    "工作目录里的那张照旧改写：![图](output/shot.png)",
  ].join("\n"),
  events: [],
  attachments: [],
}];
assert.equal(
  turnImages(owned, "C0ojRgeQnMsa")[0].markdown,
  [
    "证据：![证据](/Users/fjh/code/harness/data/runs/kCIlzUlQsB9w/free-review/P6pTi1-Ksavv/round-2/team.png)",
    "",
    "附件：![附件](/api/uploads/99999999999a-shot.png)",
    "",
    "工作目录里的那张照旧改写：![图](/api/tasks/C0ojRgeQnMsa/file/raw?path=output%2Fshot.png&workspaceOnly=1)",
  ].join("\n"),
  "证据目录和 uploads 的地址原样留给渲染点去解,只有工作目录相对路径才改写",
);

console.log("回合图片配对(trace → 分段 → 正文)回归通过");
