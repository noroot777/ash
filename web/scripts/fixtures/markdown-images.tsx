// 「agent 说的那张图，用户看不看得到」的 DOM fixture。
//
// 三种写法并排挂着，因为它们恰好是同一个毛病的三张脸（用户 2026-10-21 报的「结论里的
// 文件总是读不到」）：
//   ① 审查报告里 `![](shot.png)` —— 截图跟 report.md 同在证据目录，这是审查 prompt
//      交代的写法，也是实际报告里的绝对主流；
//   ② 对话结论里 `![](output/x.png)` —— agent 站在工作目录里，写相对路径最自然；
//   ③ 配不上任何来源的本机路径 —— 必须**一个字都不画**，而不是留一个裂开的图标。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentTurnBody } from "../../src/components/AgentTurnBody.tsx";
import { ReviewReportBody } from "../../src/components/MarkdownBody.tsx";
import { siblingFileResolver } from "../../src/components/markdownPolicy.ts";
import type { AgentContentSegment } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const REPORT = [
  "## 结论",
  "",
  "不能 —— 有 1 条必须先修。",
  "",
  "### 1. 列表加载后第一屏是空的",
  "",
  "![复现截图](shot.png)",
  "",
  "另一张放在子目录里，服务端取不到：",
  "",
  "![子目录](shots/deep.png)",
].join("\n");

function segment(id: string, markdown: string, attachments: string[]): AgentContentSegment {
  return { id, markdown, events: [], attachments };
}

// 服务端落盘时留住了源文件的名字（`<12 位 id>-<原名>`），配对就是靠它。
const UPLOADS = "/Users/demo/code/ash/data/uploads";

// **分成两段是真实形状，不是为了凑测试**：事件流里 attachment 恒在它那段 text 之后，
// 而分段遇到附件就另起一段（conversationSegments.ts）。按段配对的实现在这里必然失败。
const CONCLUSION = [
  segment(
    "segment:0",
    [
      "Demo 做好了，推荐这一版：",
      "",
      "![推荐方案预览](output/playwright/wake-input-desktop.png)",
      "",
      "顺手留了一张手机版：",
      "",
      "![手机版](/Users/demo/code/ash/.worktrees/x/output/playwright/wake-input-mobile.png)",
    ].join("\n"),
    [],
  ),
  segment("segment:1", "", [
    `${UPLOADS}/aaaaaaaaaaaa-wake-input-desktop.png`,
    `${UPLOADS}/bbbbbbbbbbbb-wake-input-mobile.png`,
    // 正文里没提它（工具结果截图之类），照旧铺成卡片。
    `${UPLOADS}/cccccccccccc-tool-screenshot.png`,
  ]),
];

// 只有一张图的回合：那一段的附件被正文全部领走后变成空段。空段也占 7px 间距、会把正在
// 读的人往下拽（见 segmentHasVisibleContent），所以它不该再出 section。
const SINGLE = [
  segment("single:0", "改完了，截图在这儿：\n\n![结果](output/result.png)\n", []),
  segment("single:1", "", [`${UPLOADS}/dddddddddddd-result.png`]),
];

// 存量消息：那时相对路径根本没被复制进 uploads，配不上任何附件。
const ORPHAN = [segment("orphan:0", "当时的截图：\n\n![旧截图](output/playwright/gone.png)\n", [])];

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
    <section className="conclusion-fixture">
      <AgentTurnBody segments={CONCLUSION} running={false} />
    </section>
    <section className="single-fixture">
      <AgentTurnBody segments={SINGLE} running={false} />
    </section>
    <section className="orphan-fixture">
      <AgentTurnBody segments={ORPHAN} running={false} />
    </section>
  </StrictMode>,
);
