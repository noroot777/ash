// 「agent 说的那张图，用户看不看得到」的 DOM fixture。
//
// 挂的每一组都是同一个毛病的一张脸（用户 2026-10-21 报的「结论里的文件总是读不到」，
// 以及审查第 1 轮按它复现出来的那几种）：
//   ① 审查报告 `![](shot.png)` —— 截图跟 report.md 同在证据目录，审查 prompt 就这么交代；
//   ② 对话结论 `![](output/x.png)` —— agent 站在工作目录里，写相对路径最自然；
//   ③ 同一个路径被重拍过 —— 「结论说修改后、画出来是修改前」比不画更坏，这是 F1 的要害；
//   ④ 站外地址、同名别名、围栏代码块里的例子、带空格中文名、`file://` —— 一处都不许配串；
//   ⑤ 配不上任何来源的本机路径 —— 必须**一个字都不画**，而不是留一个裂开的图标。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentTurnBody } from "../../src/components/AgentTurnBody.tsx";
import { ReviewReportBody } from "../../src/components/MarkdownBody.tsx";
import { siblingFileResolver } from "../../src/components/markdownPolicy.ts";
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
  "子目录那张服务端取不到，不画：",
  "",
  "![子目录](shots/deep.png)",
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

// 存量消息：那时相对路径根本没被复制进 uploads，配不上任何来源。
const ORPHAN = [segment("orphan:0", "当时的截图：\n\n![旧截图](output/playwright/gone.png)\n")];

// 同一条存量消息，但这一回知道它是哪个任务说的：退一档「现在去那个工作目录里取」。
// 文件还在的那张要真画出来（夹具服务端吐真字节），已经没了的那张**一个 img 都不许留**。
const LIVE = [segment("live:0", "当时的截图：\n\n![旧截图](output/live.svg)\n")];
const GONE = [segment("gone:0", "当时的截图：\n\n![没了](output/gone.svg)\n")];

const TURNS: [string, AgentContentSegment[]][] = [
  ["conclusion", CONCLUSION],
  ["single", SINGLE],
  ["retake", RETAKE],
  ["alias", ALIAS],
  ["fenced", FENCED],
  ["awkward", AWKWARD],
  ["orphan", ORPHAN],
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <section className="report-fixture">
      <ReviewReportBody
        text={REPORT}
        reportKey="run-1:1"
        conclusion="verify_failed"
        resolveFile={siblingFileResolver((name) =>
          `/api/tasks/T1/free-workflow/review-file?run=R1&round=1&name=${encodeURIComponent(name)}`)}
      />
    </section>
    {TURNS.map(([name, segments]) => (
      <section className={`${name}-fixture`} key={name}>
        <AgentTurnBody segments={segments} running={false} />
      </section>
    ))}
    {([["live", LIVE], ["gone", GONE]] as [string, AgentContentSegment[]][]).map(([name, segments]) => (
      <section className={`${name}-fixture`} key={name}>
        <AgentTurnBody segments={segments} running={false} taskId="T1" />
      </section>
    ))}
  </StrictMode>,
);
