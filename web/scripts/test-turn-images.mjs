// trace 里那条附件事件 → 气泡分段 → 正文里真的画出那张图。
//
// DOM 那份（test:markdown-images）是自己手搓分段喂进组件的，看不见**这一段接缝**：服务端
// 标在附件事件上的 `source` 有没有一路带到分段里。接缝断了的表现跟「功能没做」一模一样
// ——正文里什么都不画、附件卡片照旧挂着，而两边的单元测试全绿。
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { turnImages } from "../src/task-detail/turnImages.ts";
import { taskFilePath } from "../src/components/markdownPolicy.ts";
import { markdownImageRefs } from "../../shared/src/markdown-images.ts";

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

// ⑧ **压根没有字节可存**的那处引用才退到当前文件(说那句话时文件还不存在、格式不认:带
// source/ref、没有 path、也没有 lost)。agent 先写 `![](shot.png)` 再去截图是常事,现在那张
// 就是它说的那张。没有这条交代,展示端分不清「从没存过」和「关联丢了」——后者退到当前文件
// 就是审查第 1 轮 F1 实测 B 那一幕。字节**丢了**(lost)那一档见 ⑯。
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

// ⑩ 老数据(一条 ref 都没有)走**同一套对账**:两处引用、只记了一条 → 这个目的地配不上,
// 一处都不画。老数据曾经有一条宽松的例外(按来源排队、取空了退当前文件),而那条路恰恰是
// F1 的原形 —— 服务端那时按字节去重,「队列短一条」正是重拍过的那张,顶上去画出来的就是
// 错的那张。判据对两种数据同一个,例外整条删掉。
const legacyQueue = [{
  id: "l:0",
  markdown: "![一](output/s.png) ![二](output/s.png)",
  events: [],
  attachments: [uploads("ffffffffffff-s.png")],
  attachmentSources: [{ path: uploads("ffffffffffff-s.png"), source: "output/s.png" }],
}];
assert.equal(
  turnImages(legacyQueue, "C0ojRgeQnMsa")[0].markdown,
  "![一](#ash-image-unavailable:output%2Fs.png) ![二](#ash-image-unavailable:output%2Fs.png)",
  "老数据配不上也显式作废,不许按位置顶上去",
);

// ⑩' 老数据条数对得上就照样逐处认领:判据是条数,不是有没有 `ref`。存量对话里绝大多数
// 消息都是这一类(一处引用一条记录),它们一张都不该因为新判据而消失。
const legacyPaired = [{
  id: "lp:0",
  markdown: "一：![一](output/a.png)\n\n二：![二](output/b.png)",
  events: [],
  attachments: [uploads("1a1a1a1a1a1a-a.png"), uploads("2b2b2b2b2b2b-b.png")],
  attachmentSources: [
    { path: uploads("1a1a1a1a1a1a-a.png"), source: "output/a.png" },
    { path: uploads("2b2b2b2b2b2b-b.png"), source: "output/b.png" },
  ],
}];
assert.equal(
  turnImages(legacyPaired, "C0ojRgeQnMsa")[0].markdown,
  "一：![一](/api/uploads/1a1a1a1a1a1a-a.png)\n\n二：![二](/api/uploads/2b2b2b2b2b2b-b.png)",
  "老数据对得上就画拷贝",
);

// ⑩'' **失败范围收窄到目的地**:同一条消息里 A 配不上(两处引用一条记录)、B 对得上,
// B 那张照旧画出来。以前是整条消息一刀切 —— 一个目的地出问题,这条消息里所有图一起消失。
const mixed = [{
  id: "mx:0",
  markdown: "坏的：![A1](output/a.png) ![A2](output/a.png)\n\n好的：![B](output/b.png)",
  events: [],
  attachments: [uploads("3c3c3c3c3c3c-a.png"), uploads("4d4d4d4d4d4d-b.png")],
  attachmentSources: [
    { path: uploads("3c3c3c3c3c3c-a.png"), source: "output/a.png", ref: 0 },
    { path: uploads("4d4d4d4d4d4d-b.png"), source: "output/b.png", ref: 1 },
  ],
}];
const mixedOut = turnImages(mixed, "C0ojRgeQnMsa");
assert.equal(
  mixedOut[0].markdown,
  "坏的：![A1](#ash-image-unavailable:output%2Fa.png) ![A2](#ash-image-unavailable:output%2Fa.png)\n\n好的：![B](/api/uploads/4d4d4d4d4d4d-b.png)",
  "配不上的那个目的地作废,对得上的那个照旧画",
);
assert.deepEqual(
  mixedOut[0].attachments,
  [uploads("3c3c3c3c3c3c-a.png")],
  "作废的那份留在卡片里,被领走的那份撤掉",
);

// ⑩-重 同一处引用递上来两次(直播那一路 + 刷新重建那一路汇到一起):按「来源 + 身份」去重,
// 否则条数翻倍、这个目的地会被整个误判成配不上。
const doubled = [{
  id: "db:0",
  markdown: "![图](output/one.png)",
  events: [],
  attachments: [uploads("5e5e5e5e5e5e-one.png")],
  attachmentSources: [
    { path: uploads("5e5e5e5e5e5e-one.png"), source: "output/one.png", ref: 7 },
    { path: uploads("5e5e5e5e5e5e-one.png"), source: "output/one.png", ref: 7 },
  ],
}];
assert.equal(
  turnImages(doubled, "C0ojRgeQnMsa")[0].markdown,
  "![图](/api/uploads/5e5e5e5e5e5e-one.png)",
  "同一处引用送两次不算两处",
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

// ⑭ **工具步骤插进正文,不许改变语法边界。** 整条消息里那是写法示例(行内代码),而分段
// 一旦切在反引号中间,后半段就把它当成真图画出来(审查第 3 轮 R2 实测:完整正文 0 个图片
// 节点、切成两段各认出 1 个)。切点挪到顶层块边界之后,这条消息压根切不动 → 仍是一段。
const session2 = { ...session, id: "s2", taskId: "t2" };
const exampleBody = "以下只是示例：`![示例](output/shot.png)`，不该显示图片。";
const exampleItems = buildConversationItems([{
  session: session2,
  output: exampleBody,
  trace: [
    traced("2026-10-21T08:01:00.000Z", { kind: "text", text: "以下只是示例：`![示例](output/shot.png)" }),
    traced("2026-10-21T08:01:01.000Z", { kind: "tool", name: "exec", detail: "读取工作目录" }),
    traced("2026-10-21T08:01:02.000Z", { kind: "text", text: "`，不该显示图片。" }),
  ],
}], [session2], []);
const exampleSegments = exampleItems.find((item) => item.kind === "agent").segments;
assert.equal(markdownImageRefs(exampleBody).length, 0, "整条消息里那是写法示例");
assert.equal(
  exampleSegments.reduce((count, segment) => count + markdownImageRefs(segment.markdown).length, 0),
  0,
  "分段之后还得是写法示例 —— 每一段都要自己过一遍渲染器",
);
assert.equal(
  turnImages(exampleSegments, "t2").map((segment) => segment.markdown).join(""),
  exampleBody,
  "示例一个字都不许被改写",
);

// ⑮ 反过来:**真图的写法被工具隔开**。上一版这里两头都落空 —— 正文留着原始碎片(跨段改
// 不了),而附件卡片又已经被「认领」吃掉了(审查第 3 轮 R2 实测 remainingAttachments=[])。
const session3 = { ...session, id: "s3", taskId: "t3" };
const crossedBody = "真实截图：![真实截图](output/shot.png)\n\n另一张：![另一张](output/shot.png)\n";
const crossedItems = buildConversationItems([{
  session: session3,
  output: crossedBody,
  trace: [
    traced("2026-10-21T08:01:00.000Z", { kind: "text", text: "真实截图：![真实" }),
    traced("2026-10-21T08:01:01.000Z", { kind: "tool", name: "exec", detail: "读取工作目录" }),
    traced("2026-10-21T08:01:02.000Z", { kind: "text", text: "截图](output/shot.png)\n\n另一张：![另一张](output/shot.png)\n" }),
    traced("2026-10-21T08:01:03.000Z", { kind: "attachment", path: uploads("eeee55555555-shot.png"), source: "output/shot.png", ref: 0 }),
    traced("2026-10-21T08:01:04.000Z", { kind: "attachment", path: uploads("ffff66666666-shot.png"), source: "output/shot.png", ref: 1 }),
  ],
}], [session3], []);
const crossed = turnImages(crossedItems.find((item) => item.kind === "agent").segments, "t3");
assert.equal(
  crossed.map((segment) => segment.markdown).join(""),
  "真实截图：![真实截图](/api/uploads/eeee55555555-shot.png)\n\n另一张：![另一张](/api/uploads/ffff66666666-shot.png)\n",
  "被工具隔开的那一处照样改写成它自己那份拷贝",
);
assert.deepEqual(
  crossed.flatMap((segment) => segment.attachments),
  [],
  "两处都画进正文了,卡片排才该空 —— 不许出现「正文没画、卡片也没了」",
);

// ⑮' 真的跨段了怎么办(人为构造的 trace、历史落盘里仍有):改写不了的那一处,**附件必须
// 留在卡片里**。「认领」的唯一后果就是把卡片从排里拿掉,所以只能在改写真的落下去之后认
// —— 先认领后改写的那一版两头都空:正文留着碎片,卡片也没了。
const straddling = [
  {
    id: "sp:0",
    markdown: "真实截图：![真实",
    events: [],
    attachments: [uploads("1111aaaa0000-shot.png"), uploads("2222bbbb0000-shot.png")],
    attachmentSources: [
      { source: "output/shot.png", ref: 0, path: uploads("1111aaaa0000-shot.png") },
      { source: "output/shot.png", ref: 1, path: uploads("2222bbbb0000-shot.png") },
    ],
  },
  { id: "sp:1", markdown: "截图](output/shot.png)\n\n另一张：![另一张](output/shot.png)\n", events: [], attachments: [] },
];
const stayed = turnImages(straddling, "t4");
assert.match(
  stayed.map((segment) => segment.markdown).join(""),
  /!\[另一张\]\(\/api\/uploads\/2222bbbb0000-shot\.png\)/,
  "段内那一处照旧改写",
);
assert.deepEqual(
  stayed.flatMap((segment) => segment.attachments),
  [uploads("1111aaaa0000-shot.png")],
  "跨段改不了的那一处,拷贝照旧挂在卡片上(画出来的那一份才撤卡片)",
);

// ⑯ 服务端说**字节丢了**(当时读到了、写盘失败了)→ 显式作废。文件后来可能已经被重拍,
// 拿「现在的文件」去画就是把后来的画面当成旧结论(审查第 3 轮 R1 同类位置)。
const lostBytes = [{
  id: "lost:0",
  markdown: "![存不下](output/lost.png)",
  events: [],
  attachments: [],
  attachmentSources: [{ source: "output/lost.png", ref: 0, lost: true }],
}];
assert.match(
  turnImages(lostBytes, "C0ojRgeQnMsa")[0].markdown,
  /#ash-image-unavailable:/,
  "字节丢了就显式作废,不退到当前文件",
);

console.log("回合图片配对(trace → 分段 → 正文)回归通过");
