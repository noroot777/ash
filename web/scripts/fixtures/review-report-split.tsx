// 审查报告摘要/明细折叠的 DOM fixture。四份并排挂出来：合契约的、存量格式的，
// 以及两份「在同一个位置换轮次」的（正文不同 / 正文一字不差）。
//
// 并排是必须的：这个改动真正的风险不是「折叠不灵」，而是**对不上契约的报告被误拆、
// 内容被藏进折叠里还没人发现**。两种形态同屏才能一眼看出降级行为是「整篇铺开」。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReviewReportBody } from "../../src/components/MarkdownBody.tsx";
import "../../src/styles/global.css";

// 照 `NG0arezydQ2e` 第 4 轮那份的骨架，按新契约重写开头那一节。
const conforming = `# 第 4 轮自动验证报告

## 结论

**能不能验收**：不能 —— 有 1 条必须先修

**现在什么能用了**：项目中心的卡片在深色主题下不再出现一块亮紫白的空位。

**必须修的问题**

### 烧录出来的成片用的是你改之前的字幕

你会遇到：改完字幕立刻点烧录，导出的视频里还是上一版字幕，界面上没有任何提示。
为什么：保存请求还在服务端处理时，另一个标签页的一次拉取会把「有改动待落盘」的标记提前消费掉。
建议怎么修：标记推迟到服务端确认提交之后再发。

**不拦验收、但你该知道的**

- 删除项目后整个网格会闪一下「正在加载项目…」。

## 被审范围与基线

- 工作树：\`/Users/fjh/code/ascut/.worktrees/LqhF7g_rqANy\`
- 被审 HEAD：\`d7ee0b07\`，比较基线 \`8e428641\`
- \`git diff HEAD^ HEAD --check\` 通过

## 实际验证

\`\`\`text
npm run build
npm test
\`\`\`

## 清场

- 已停止本轮启动的 Vite 服务，\`lsof -nP -iTCP:5175 -sTCP:LISTEN\` 无输出。
`;

// 第二轮的报告：内容跟第一轮不同，明细里塞一条第一轮没有的独有串，测试靠它判断
// 屏幕上显示的是哪一轮。
const conformingRound2 = `# 第 5 轮自动验证报告

## 结论

**能不能验收**：可以

**现在什么能用了**：烧录前会先等字幕落盘，导出的成片用的一定是你看到的那一版。

**必须修的问题**

没有发现问题

**不拦验收、但你该知道的**：没有。

## 实际验证

\`\`\`text
ROUND2_ONLY_MARKER
\`\`\`
`;

// 存量形态，取自真实报告 `yz74LehaZzwl/H1MQnmqKzCSl/round-1`：首节标题含「结论」二字，
// 意思却正相反（「先说**结论之外的**」），两条【高】在它后面。按标题判契约的那一版会把
// 这两条折叠进写着「验证过程、证据、清场记录」的按钮里，首屏只剩「做对的部分」。
const legacy = `# 自由工作流 · 第 1 轮逻辑审查报告

- 被审提交：\`711d78f\`
- 结论：**verify_failed** —— 有 2 个可复现的高优先级问题

## 0. 先说结论之外的：这轮做对的部分

核心流程已跑通，新增回归测试全部通过。

## 1. 【高】身份页高内容屏：顶部被裁，而且滚不回去

复现：窗口高度 ≤ 600 时打开身份页。

## 2. 【高】设置页 ≤640px 的新单列断点把导航切断
`;

// 第三、四块：在**同一个位置**换报告，模拟侧栏抽屉切换轮次。展开状态如果是独立 state，
// 换一轮就会串过去——下一份报告一打开就是满屏命令输出，恰好是这个改动要消灭的东西。
//
// `identical` 那一份是边界：**两轮报告一字不差**（同一处没修好、原样重报一遍）。按正文
// 判「换了没有」在这里认不出来，所以复位判据必须是报告身份 `reportKey`。
function SwitchableReport({ identical = false }: { identical?: boolean }) {
  const [second, setSecond] = useState(false);
  return (
    <>
      <button type="button" className="switch-round" onClick={() => setSecond((value) => !value)}>
        切换轮次
      </button>
      <ReviewReportBody
        text={!second || identical ? conforming : conformingRound2}
        reportKey={`run-1:${second ? 2 : 1}`}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="conforming-fixture markdown-report-body">
      <ReviewReportBody text={conforming} reportKey="run-1:4" />
    </div>
    <div className="legacy-fixture markdown-report-body">
      <ReviewReportBody text={legacy} reportKey="run-2:1" />
    </div>
    {/* Windows 上生成的同一份报告：换行是 CRLF，屏幕上该长得一模一样。 */}
    <div className="crlf-fixture markdown-report-body">
      <ReviewReportBody text={conforming.replace(/\n/g, "\r\n")} reportKey="run-3:1" />
    </div>
    <div className="switch-fixture markdown-report-body">
      <SwitchableReport />
    </div>
    <div className="identical-fixture markdown-report-body">
      <SwitchableReport identical />
    </div>
  </StrictMode>,
);
