// 「agent 说的那张图，用户看不看得到」的 DOM fixture。
//
// 挂的每一组都是同一个毛病的一张脸（用户 2026-10-21 报的「结论里的文件总是读不到」，
// 以及审查第 1 轮按它复现出来的那几种）：
//   ① 审查报告 `![](shot.png)` —— 截图跟 report.md 同在证据目录，审查 prompt 就这么交代；
//      相对路径恒按这份文档自己那个目录解，取不到也不许换成另一个根下同名的文件；
//   ② 对话结论 `![](output/x.png)` —— agent 站在工作目录里，写相对路径最自然；
//   ③ 同一个路径被重拍过 —— 「结论说修改后、画出来是修改前」比不画更坏，这是 F1 的要害；
//   ④ 站外地址、同名别名、围栏代码块里的例子、带空格中文名、`file://` —— 一处都不许配串；
//   ⑤ 配不上任何来源的本机路径 —— 不许留裂开的图标，但要留一行「图取不到 + 那个地址」。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentTurnBody } from "../../src/components/AgentTurnBody.tsx";
import { ReviewReportBody } from "../../src/components/MarkdownBody.tsx";
import { MarkdownBody } from "../../src/components/MarkdownBody.tsx";
import { reportFileResolver } from "../../src/components/markdownPolicy.ts";
import { IMAGE_SHAPES } from "./markdown-shapes.ts";
import type { AgentContentSegment, AttachmentSource } from "../../src/task-detail/conversationSegments.ts";
import "../../src/styles/global.css";

const REPORT = [
  "## 结论",
  "",
  "不能 —— 有 1 条必须先修。",
  "",
  "![复现截图](shot.png)",
  "",
  "带空格和中文的名字也得解出来：",
  "",
  "![中文名](<第一屏 空.png>)",
  "",
  "归到子目录里的那张也要解出来（证据接口服务得了子路径）：",
  "",
  "![子目录](shots/deep.png)",
  "",
  "证据目录里**没有**的那个相对路径 —— 只能留一行「图取不到」。工作目录里刚好有个同名的",
  "别的文件时，把它端上来比不画更坏（审查第 3 轮 R3 第 1 条）：",
  "",
  "![证据丢了](missing.png)",
  "",
  "报告里提被审任务工作目录里那一份时写的是**绝对路径** —— 那是显式归属，不是猜的：",
  "",
  "![工作目录](/Users/demo/code/ash/.worktrees/x/output/shot.svg)",
].join("\n");

/**
 * 结论里引用、**定义写在技术明细里** —— 报告分栏那一路的 R2(审查第 4 轮)。
 *
 * 分栏各建一份 `MarkdownDocument` 的那一版:明细那一份没有引用它的正文,结论那一份没有
 * 定义,于是点开「展开完整报告」照样 0 张图、脚注一节都不建(实测;同一份内容整篇交给
 * 渲染器是 2 张图)。定义是**整篇文档的**,折叠只是展示分组,所以折着的时候结论里这张图
 * 就该在屏幕上。
 */
const CROSSREF_REPORT = [
  "## 结论",
  "",
  "不能 —— 有 1 条必须先修。",
  "",
  "定义写在技术明细里的那张图：![复现截图][shot]",
  "",
  "脚注的正文也写在那边[^proof]。",
  "",
  "## 技术明细",
  "",
  "[shot]: shot.png",
  "",
  "[^proof]: 证据在 shot.png 里。",
  "",
  "清场记录见脚注[^cleanup]。",
  "",
  "[^cleanup]: 已停掉本轮启动的 Vite 服务。",
].join("\n");

// 服务端落盘时留住了源文件的名字（`<12 位 id>-<原名>`）；配对**不靠**它，靠 source 标注。
const UPLOADS = "/Users/demo/code/ash/data/uploads";
const up = (name: string) => `${UPLOADS}/${name}`;

function segment(id: string, markdown: string, sources: AttachmentSource[] = []): AgentContentSegment {
  return {
    id,
    markdown,
    events: [],
    attachments: [...new Set(sources.map((item) => item.path))],
    ...(sources.length ? { attachmentSources: sources } : {}),
  };
}

function turn(id: string, markdown: string, sources: AttachmentSource[], extra: string[] = []) {
  // **分成两段是真实形状**：事件流里 attachment 恒在它那段 text 之后，而分段遇到附件就另
  // 起一段（conversationSegments.ts）。按段配对的实现在这里必然失败。
  const carrier = segment(`${id}:1`, "", sources);
  carrier.attachments.push(...extra);
  return [segment(`${id}:0`, markdown), carrier];
}

const CONCLUSION = turn(
  "conclusion",
  [
    "Demo 做好了，推荐这一版：",
    "",
    "![推荐方案预览](output/playwright/wake-input-desktop.svg)",
    "",
    "顺手留了一张手机版：",
    "",
    "![手机版](/Users/demo/code/ash/.worktrees/x/output/playwright/wake-input-mobile.svg)",
  ].join("\n"),
  [
    { path: up("aaaaaaaaaaaa-wake-input-desktop.svg"), source: "output/playwright/wake-input-desktop.svg" },
    {
      path: up("bbbbbbbbbbbb-wake-input-mobile.svg"),
      source: "/Users/demo/code/ash/.worktrees/x/output/playwright/wake-input-mobile.svg",
    },
  ],
  // 正文里没提它（工具结果截图之类），照旧铺成卡片。
  [up("cccccccccccc-tool-screenshot.svg")],
);

// 只有一张图的回合：那一段的附件被正文全部领走后变成空段。空段也占 7px 间距、会把正在
// 读的人往下拽（见 segmentHasVisibleContent），所以它不该再出 section。
const SINGLE = turn("single", "改完了，截图在这儿：\n\n![结果](output/result.svg)\n", [
  { path: up("dddddddddddd-result.svg"), source: "output/result.svg" },
]);

// F1 的要害：同一个路径先后截了两次。两处引用必须各自拿到**自己那一次**的字节。
const RETAKE = turn(
  "retake",
  ["修改前：", "", "![修改前](output/shot.svg)", "", "修改后：", "", "![修改后](output/shot.svg)"].join("\n"),
  [
    { path: up("eeeeeeeeeeee-shot.svg"), source: "output/shot.svg" },
    { path: up("ffffffffffff-shot.svg"), source: "output/shot.svg" },
  ],
);

// 站外同名图不许被本地附件顶掉；同一份字节的两个名字都要能画出来。
const ALIAS = turn(
  "alias",
  [
    "站外那张照旧走网络：",
    "",
    "![站外](https://example.invalid/remote.svg)",
    "",
    "本机这两个名字其实是同一份字节：",
    "",
    "![甲](output/same-a.svg)",
    "",
    "![乙](output/same-b.svg)",
  ].join("\n"),
  [
    { path: up("gggggggggggg-same-a.svg"), source: "output/same-a.svg" },
    { path: up("gggggggggggg-same-a.svg"), source: "output/same-b.svg" },
  ],
);

// 围栏代码块里的例子不是图：既不许画，也不许把那张附件卡片吃掉。
const FENCED = turn(
  "fenced",
  ["示例写法：", "", "```md", "![示例](output/fenced.svg)", "```", ""].join("\n"),
  [{ path: up("hhhhhhhhhhhh-fenced.svg"), source: "output/fenced.svg" }],
);

// 带空格中文名 + file:// —— 前者会被 react-markdown 转义，后者会被它整个清空。
const AWKWARD = turn(
  "awkward",
  [
    "![中文](<output/结果 图.svg>)",
    "",
    "![file](file:///Users/demo/code/ash/output/by-url.svg)",
    "",
    "![没来源](file:///Users/demo/code/ash/output/gone.svg)",
  ].join("\n"),
  [
    { path: up("iiiiiiiiiiii-结果-图.svg"), source: "output/结果 图.svg" },
    { path: up("jjjjjjjjjjjj-by-url.svg"), source: "file:///Users/demo/code/ash/output/by-url.svg" },
  ],
);

// ── F2：扫描器认的那几处 vs 渲染器画出来的那几个 ──────────────────────────────
// 每种写法单独一节，`test-markdown-images.mjs` 两边数数对比（见 markdown-shapes.ts）。
// 解析器**认得出的目的地**一律给一个真吐字节的地址，这样「画了几张」就只取决于渲染器
// 认不认这处引用，不受路径形状影响。
const anyLocalFile = (destination: string) => {
  const name = destination.split("/").pop() ?? destination;
  return /\.svg$/i.test(name) ? { name, url: "/api/uploads/shape.svg" } : null;
};

// ── F1：没有副本 / 配不上的两种交代 ────────────────────────────────────────────
// 「明确没有副本」(带 source、带 ref、没有 path) → 现在去工作目录取,取到了就真画出来。
const NOCOPY = [segment("nocopy:0", "服务端没存下这张：\n\n![没副本](output/live.svg)\n")];
NOCOPY[0]!.attachmentSources = [{ source: "output/live.svg", ref: 0 }];

// 配不上(队列取空)、而契约保证过「每处引用恒有一条」→ 第二处**什么都不画**,绝不顶一份
// 别的拷贝(审查第 1 轮 F1:猜出来的恰好是错的那张)。第一处领走的那张不再挂卡片。
const SHORT = turn(
  "short",
  ["第一次：", "", "![一](output/short.svg)", "", "又提一次：", "", "![二](output/short.svg)"].join("\n"),
  [{ path: up("kkkkkkkkkkkk-short.svg"), source: "output/short.svg", ref: 0 }],
);

// ── R2：**文档级的定义**跨过一个执行步骤 ──────────────────────────────────────
// 脚注定义、链接引用定义是**整篇文档**的属性,不是某一段的。按段各渲染一次的那一版两头
// 落空:前一段的 `[^shot]` / `![图][ref]` 找不到定义(画成字面量),后一段的定义没人引用
// (GFM 直接丢掉),于是那两张截图谁都画不出来 —— 而附件卡片已经被认领走,两头都没了
// (审查第 3 轮 R2 实测 footnoteAgentImages=0、footnoteAgentCards=0,同一份正文整篇渲染
// 则有 1 张图)。
const CROSSDEF: AgentContentSegment[] = [
  segment("crossdef:0", "引用式那张：![图][ref]\n\n结论在脚注里[^shot]。\n\n"),
  segment(
    "crossdef:1",
    "[ref]: output/ref.svg\n\n[^shot]: 复现截图：![脚注图](output/foot.svg)\n",
    [
      { path: up("llllllllllll-ref.svg"), source: "output/ref.svg", ref: 0 },
      { path: up("mmmmmmmmmmmm-foot.svg"), source: "output/foot.svg", ref: 1 },
    ],
  ),
];

// 存量消息：那时相对路径根本没被复制进 uploads，配不上任何来源。
const ORPHAN = [segment("orphan:0", "当时的截图：\n\n![旧截图](output/playwright/gone.png)\n")];

// 同一条存量消息，但这一回知道它是哪个任务说的：退一档「现在去那个工作目录里取」。
// 文件还在的那张要真画出来（夹具服务端吐真字节），已经没了的那张**一个 img 都不许留**。
const LIVE = [segment("live:0", "当时的截图：\n\n![旧截图](output/live.svg)\n")];
const GONE = [segment("gone:0", "当时的截图：\n\n![没了](output/gone.svg)\n")];

// 协议相对网址(`//host/x.png`):沿用当前页面的 http/https,**不是**本机路径。只问「有没
// 有协议」的那一版把它改写成「去任务工作目录取」,于是这张站外图永远画不出来(审查第 2 轮
// F3)。`file:` 那条反过来:它是本机文件,解不出来时要留下小字而不是被 react-markdown 清成
// 空串后无声消失(同轮 F2 的失败分支)。
const PROTOCOL = [segment("protocol:0", [
  "站外那张沿用当前页面的协议：",
  "",
  "![协议相对](//cdn.example.invalid/remote.svg)",
  "",
  "这张是本机文件、没有副本也不在工作目录里：",
  "",
  "![没了](file:///Users/demo/code/ash/output/vanished.svg)",
].join("\n"))];

/**
 * 送达那一下:先只能退到「去工作目录取」(夹具里恒 404 → 一行「图取不到」),按一下按钮
 * 把服务端落完盘的那条结果递上来,同一处引用的地址随即换成 `/api/uploads/…`。
 *
 * 钉的是审查第 4 轮 R1:地址换了就得重新加载一次。失败状态记成布尔的那一版在这里仍写着
 * 「图取不到」,而附件卡片已经被正文认领走 —— 用户两头都看不到,必须手点「再试一次」。
 */
function Delivered() {
  const [sources, setSources] = useState<AttachmentSource[]>([]);
  const segments = [segment("delivered:0", "截图在这儿：\n\n![结果](output/gone-later-saved.svg)\n", sources)];
  return (
    <section className="delivered-fixture">
      <AgentTurnBody segments={segments} running={false} taskId="T1" />
      <button
        type="button"
        data-testid="deliver"
        onClick={() => setSources([
          { path: up("abcdefghijkl-saved.svg"), source: "output/gone-later-saved.svg", ref: 0 },
        ])}
      >
        送达那份拷贝
      </button>
    </section>
  );
}

const TURNS: [string, AgentContentSegment[]][] = [
  ["protocol", PROTOCOL],
  ["conclusion", CONCLUSION],
  ["single", SINGLE],
  ["retake", RETAKE],
  ["alias", ALIAS],
  ["fenced", FENCED],
  ["awkward", AWKWARD],
  ["orphan", ORPHAN],
  ["short", SHORT],
  ["crossdef", CROSSDEF],
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <section className="report-fixture">
      <ReviewReportBody
        text={REPORT}
        reportKey="run-1:1"
        conclusion="verify_failed"
        // 真实表面用的就是 reportFileResolver（相对路径 → 证据目录，绝对路径 → 工作目录）。
        resolveFile={reportFileResolver((name) =>
          `/api/tasks/T1/free-workflow/review-file?run=R1&round=1&name=${encodeURIComponent(name)}`, "T1")}
      />
    </section>
    <section className="crossref-report-fixture">
      <ReviewReportBody
        text={CROSSREF_REPORT}
        reportKey="run-2:1"
        conclusion="verify_failed"
        resolveFile={reportFileResolver((name) =>
          `/api/tasks/T1/free-workflow/review-file?run=R1&round=1&name=${encodeURIComponent(name)}`, "T1")}
      />
    </section>
    {TURNS.map(([name, segments]) => (
      <section className={`${name}-fixture`} key={name}>
        <AgentTurnBody segments={segments} running={false} />
      </section>
    ))}
    {IMAGE_SHAPES.map((shape) => (
      <section className={`shape-${shape.key}`} key={shape.key} title={shape.about}>
        <MarkdownBody text={shape.markdown} resolveFile={anyLocalFile} />
      </section>
    ))}
    <Delivered />
    {([["live", LIVE], ["gone", GONE], ["nocopy", NOCOPY]] as [string, AgentContentSegment[]][]).map(([name, segments]) => (
      <section className={`${name}-fixture`} key={name}>
        <AgentTurnBody segments={segments} running={false} taskId="T1" />
      </section>
    ))}
  </StrictMode>,
);
