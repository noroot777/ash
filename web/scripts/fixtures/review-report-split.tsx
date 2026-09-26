// 审查报告摘要/明细折叠的 DOM fixture。四份并排挂出来：合契约的、存量格式的，
// 以及两份「在同一个位置换轮次」的（正文不同 / 正文一字不差）。
//
// 并排是必须的：这个改动真正的风险不是「折叠不灵」，而是**对不上契约的报告被误拆、
// 内容被藏进一个宣称里面只有合规证明的按钮里**。两种形态同屏才能一眼看出降级行为——
// 存量报告拆在第一个 `##` 之前、按钮只写「展开完整报告」，连引子都没有的整篇铺开。
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
//
// 现在它走降级那一档：开头两行引子（含 `verify_failed` 和「2 个可复现的高优先级问题」）
// 留在首屏，第一个 `##` 起全部收进「展开完整报告」——按钮什么都不宣称，这是它跟上面那种
// 误拆的分界线。抽查的 7 份 ascut 存量报告全是这个形状：开头 7~12 行写明判定，后面
// 118~169 行是范围、命令、清场记录。
const legacy = `# 自由工作流 · 第 1 轮逻辑审查报告

- 被审提交：\`711d78f\`
- 结论：**verify_failed** —— 有 2 个可复现的高优先级问题

## 0. 先说结论之外的：这轮做对的部分

核心流程已跑通，新增回归测试全部通过。

## 1. 【高】身份页高内容屏：顶部被裁，而且滚不回去

复现：窗口高度 ≤ 600 时打开身份页。

## 2. 【高】设置页 ≤640px 的新单列断点把导航切断
`;

// 结论里贴了代码示例的报告：示例**内容**里有一行以三个反引号打头（CommonMark 里那不是
// 闭合围栏），后面还跟着 `##`。围栏开闭共用一条判据时，报告会从代码中间被腰斩——首屏只
// 剩半截代码加一个按钮，真正的问题折在里面，还被当成代码渲染。
const fenced = `# 第 6 轮自动验证报告

## 结论

**能不能验收**：不能 —— 有 1 条必须先修

**现在什么能用了**：项目中心的卡片在深色主题下不再出现亮紫白空位。

**必须修的问题**

### 保存后你刚改的内容会全部消失

你会遇到：点保存回到列表，刚写的东西没了，界面上没有任何提示。

**不拦验收、但你该知道的**

执行者贴的报错原文如下：

\`\`\`text
\`\`\`这一行仍是代码内容，不是闭合围栏
## 命令输出里的井号
\`\`\`

- 删除项目后整个网格还会闪一下。

## 被审范围与基线

- 被审 HEAD：\`d7ee0b07\`
`;

// 结论里夹了一段 HTML 注释，注释后面还有内容。只数字符的扫描器会把注释里的 `##` 当成
// 第二个二级标题，摘要断在一个孤零零的 `<!--` 上，后面那条要点开按钮才出现——注释内容
// 还被当成标题渲染出来。
const commented = `# 第 7 轮自动验证报告

## 结论

**能不能验收**：不能 —— 有 2 条必须先修

**现在什么能用了**：项目中心的卡片在深色主题下不再出现亮紫白空位。

**必须修的问题**

### 1. 烧录出来的成片用的是你改之前的字幕

你会遇到：改完字幕立刻点烧录，导出的视频里还是上一版。

### 2. 保存后你刚改的内容会全部消失

你会遇到：点保存回到列表，刚写的东西没了，界面上没有任何提示。

**不拦验收、但你该知道的**

<!--
## 这一段不会当成标题，下面那条才是不拦项
-->

- 删除项目后整个网格还会闪一下。

## 被审范围与基线

- 被审 HEAD：\`d7ee0b07\`
`;

// 先引用上一轮的栏目格式、后面才写真实问题。引用段落的后续行可以省掉 `>`，源码看着顶格，
// 解析树里整段在 blockquote 里——按源码逐行认标签就会拿这四行凑齐签名，首屏只剩「可以 /
// 没有问题」，这一份真正的问题被折进「展开技术明细」。
const quoted = `# 第 8 轮自动验证报告

## 前言

> 下面引用上一轮的结论格式：
**能不能验收**：可以
**现在什么能用了**：略
**必须修的问题**：没有
**不拦验收、但你该知道的**：没有

## 真正的问题

### 保存后你刚改的内容会全部消失

你会遇到：点保存回到列表，刚写的东西没了，界面上没有任何提示。
`;

// 两份「像契约、其实是抄件」的报告。上面那份把四栏抄在一个说明段里，下面那份四栏齐全
// 但整个倒着写——按「这四个词都出现过」算都能凑齐签名，于是真正的问题被折进明细。
const proseCopy = `# 第 9 轮自动验证报告

## 前言

下面抄的是上一轮结论，不是本轮：
**能不能验收**：可以
**现在什么能用了**：略
**必须修的问题**：没有
**不拦验收、但你该知道的**：没有

## 真正的问题

### 保存后你刚改的内容会全部消失

你会遇到：点保存回到列表，刚写的东西没了，界面上没有任何提示。
`;

const reordered = `# 第 9 轮自动验证报告

## 结论

**必须修的问题**：没有

**不拦验收、但你该知道的**：没有

**现在什么能用了**：略

**能不能验收**：可以

## 真正的问题

### 导出的视频仍然使用旧字幕

你会遇到：改完字幕立刻点烧录，导出的视频里还是上一版。
`;

// 两份「四栏写对了、结构却没证明问题在摘要里」的报告。上面那份首节写成「前言」，里面整段
// 抄着上一轮四项结论；下面那份首节是对的，但那条问题误用了 `##`，于是首屏只剩「见下方」。
const wrongHeading = `# 第 10 轮自动验证报告

## 前言

下面完整抄录上一轮结论：

**能不能验收**：可以

**现在什么能用了**：略

**必须修的问题**：没有

**不拦验收、但你该知道的**：没有

## 真正的问题

### 保存后你刚改的内容会全部消失

你会遇到：点保存回到列表，刚写的东西没了，界面上没有任何提示。
`;

const problemAsHeading = `# 第 10 轮自动验证报告

## 结论

**能不能验收**：不能 —— 有 1 条必须先修

**现在什么能用了**：略

**必须修的问题**：见下方

**不拦验收、但你该知道的**：没有

## 保存后你刚改的内容会全部消失

你会遇到：点保存回到列表，刚写的东西没了，界面上没有任何提示。
`;

// 旧格式的另一种主力形态（取自真实报告 `x3Jj_JW5SoXk/udvEI_K-2YiL/round-1`，全库同形态
// 21 份）：一级标题 + 任务/日期/审查者三行 + `## 结论` + `verified` + `## 被审范围`。
// 判定写在 `## 结论` 那一节里——按「折在第一个 `##` 之前」处理，首屏就只剩三行元数据，
// 「它到底过没过」得点一下才知道。这一档从**第二个** `##` 起折。
const legacyConclusion = `# 自由工作流第 1 轮审查报告

任务：x3Jj_JW5SoXk / Grok 模型接入与刷新
审查时间：2026-08-13
审查者：独立逻辑审查（旁路回合）

## 结论

**verified。** 本轮固化需求已落地：本机 \`grok models\` 的 \`grok-4.6\` 能进入系统候选；设置页与新建任务选择器都有可用的「刷新」按钮。本轮未再复现会让验收失败的行为错误。

## 被审范围

工作树 \`/Users/fjh/code/harness/.worktrees/x3Jj_JW5SoXk\`，分支 \`harness/x3Jj_JW5\`，HEAD \`45b8a02\`。

## 清场

已停掉本轮起的服务。
`;

// 四栏写成 `###` 小标题、每条问题写成 `####` 的真实形态（`MiBg8G40scWo` 的四轮报告和本
// 任务 `dB45LYOzuxnx/round-2` 都长这样）。只认加粗标签那一版时，这份会整篇铺开——首屏
// 紧跟着结论就是仓库状态、命令和清场记录，连展开按钮都没有。
const headingColumns = `## 结论

### 能不能验收

不能 —— 有 1 条必须先修。

### 现在什么能用了

旧报告把通过或失败写在「结论」一节时，这一节现在会默认显示。

### 必须修的问题

#### 1. 四个栏目写成小标题时，整份报告又全部展开

**你会遇到**：打开报告后，结论下面立刻接着整页仓库状态、测试命令和清场记录。
**为什么**：签名只认加粗段落，小标题写法凑不出 \`marked\`。

### 不拦验收、但你该知道的

没有额外的不拦验收问题。

## 被审范围与仓库状态

- 被审 HEAD：\`abc1234\`

## 测试与验证

\`\`\`text
npm test
\`\`\`

## 清场

临时服务已停止。
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
    <div className="fence-fixture markdown-report-body">
      <ReviewReportBody text={fenced} reportKey="run-4:6" />
    </div>
    <div className="comment-fixture markdown-report-body">
      <ReviewReportBody text={commented} reportKey="run-5:7" />
    </div>
    <div className="quoted-fixture markdown-report-body">
      <ReviewReportBody text={quoted} reportKey="run-6:8" />
    </div>
    <div className="prose-copy-fixture markdown-report-body">
      <ReviewReportBody text={proseCopy} reportKey="run-7:9" />
    </div>
    <div className="reordered-fixture markdown-report-body">
      <ReviewReportBody text={reordered} reportKey="run-8:9" />
    </div>
    <div className="wrong-heading-fixture markdown-report-body">
      <ReviewReportBody text={wrongHeading} reportKey="run-9:10" />
    </div>
    <div className="problem-heading-fixture markdown-report-body">
      <ReviewReportBody text={problemAsHeading} reportKey="run-10:10" />
    </div>
    <div className="legacy-conclusion-fixture markdown-report-body">
      <ReviewReportBody text={legacyConclusion} reportKey="run-11:1" />
    </div>
    <div className="heading-columns-fixture markdown-report-body">
      <ReviewReportBody text={headingColumns} reportKey="run-12:3" />
    </div>
    <div className="switch-fixture markdown-report-body">
      <SwitchableReport />
    </div>
    <div className="identical-fixture markdown-report-body">
      <SwitchableReport identical />
    </div>
  </StrictMode>,
);
