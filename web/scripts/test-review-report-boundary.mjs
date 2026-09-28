// **哪个 `##` 是分界**——拆点判据。签名那一类在 `test-review-report-sections.mjs`。
//
// 一条**别再走回头路**的判据：别把这件事改回自己数字符。手写扫描器连错三轮（围栏闭合、
// HTML 注释、列表里的缩进标题），每轮都是同一种形状：我们以为那行是标题、渲染器不这么
// 认，拆点落在一段不存在的边界上，必须修的问题被折进明细。下面这一批「不是顶层标题」的
// 用例现在由解析器保证（`mdast-util-from-markdown` + GFM，跟 `MarkdownBody.tsx` 同一套），
// 改判据前先想清楚要怎么重新保证它们。
import assert from "node:assert/strict";
import { splitReviewReport } from "../src/components/reviewReportSections.ts";

// 切点跟权威结论无关，所以这份文件统一按「这一轮通过了」调用——那是唯一会走到
// 「展开技术明细」那句话的组合，切偏了最容易看出来。按钮说什么由
// `test-review-report-claim.mjs` 单独钉。
const split = (text, conclusion = "verified") => splitReviewReport(text, conclusion);
import { contract, conforming } from "./fixtures/review-report-contract.mjs";

// 围栏里的 `## xxx` 是被审代码或命令输出，不是小节标题——拿它当分界会把摘要腰斩。
{
  const fenced = [
    "# 报告",
    "",
    "## 结论",
    "",
    contract,
    "",
    "执行者贴的原文如下：",
    "",
    "```md",
    "## 这是被审文件里的标题",
    "```",
    "",
    "继续写结论。",
    "",
    "## 真正的明细",
    "",
    "略",
  ].join("\n");
  const { summary, detail } = split(fenced);
  assert.match(summary, /这是被审文件里的标题/);
  assert.match(summary, /继续写结论。/);
  assert.match(detail, /^## 真正的明细/);
}

// 围栏用同种记号配对：``` 块里贴的 ~~~ 不能把围栏提前关掉。
{
  const nested = `# 报告\n\n## 结论\n\n${contract}\n\n\`\`\`\n~~~\n## 输出里的井号\n~~~\n\`\`\`\n\n## 明细\n\n略\n`;
  assert.match(split(nested).detail, /^## 明细/);
}

// 闭合判据必须比开头严（第 6 轮审查报告的反例）。CommonMark 里开头允许跟信息串
// （```text），闭合却只允许同种记号加空白；共用一条宽松正则时，代码块里**任何一行以
// 三个反引号打头的内容**都会把围栏提前关掉，于是代码里的 `## xxx` 成了第二个 `##`——
// 报告从那里腰斩，真正的问题被折进明细，还被当成代码渲染。
for (const [kind, mark] of [["反引号", "```"], ["波浪线", "~~~"]]) {
  const report = [
    "# 报告",
    "",
    "## 结论",
    "",
    contract,
    "",
    "执行者贴的报错原文如下：",
    "",
    `${mark}text`,
    `${mark}这一行仍是代码内容，不是闭合围栏`,
    "## 命令输出里的井号",
    mark,
    "",
    "- 删除项目后整个网格还会闪一下。",
    "",
    "## 明细",
    "",
    "略",
  ].join("\n");
  const { summary, detail } = split(report);
  assert.match(summary, /删除项目后整个网格还会闪一下/, `${kind}：代码块后面的正文必须留在首屏`);
  assert.match(summary, /命令输出里的井号/, `${kind}：代码内容里的 \`##\` 不是小节标题`);
  assert.match(detail, /^## 明细/, `${kind}：拆点是那个真的二级标题`);
}

// 真闭合还是要认：同种记号、不短于开头、后面只有空白（更长、带尾随空格都算）。
// 认不出闭合会把后面整篇都吞进围栏，`## 明细` 也就成了代码——这一档同样不许漂。
{
  const closed = `# 报告\n\n## 结论\n\n${contract}\n\n\`\`\`text\n略\n\`\`\`\`   \n\n## 明细\n\n略\n`;
  assert.match(split(closed).detail, /^## 明细/, "更长的闭合记号加尾随空格仍是闭合");
}

// Markdown 允许 ATX 标题前有 0–3 个空格，认不出只是白白丢掉折叠收益（不藏内容）。
// 样本里把契约末尾那条列表换成普通段落——紧跟在 `- ` 列表后面、又缩进 2 格的行属于
// 列表项内容，那种形态在下一段单独钉。
for (const pad of ["", " ", "  ", "   "]) {
  const flat = contract.replace("- 删除项目后整个网格会闪一下。", "删除项目后整个网格会闪一下。");
  const padded = `# 报告\n\n${pad}## 结论\n\n${flat}\n\n${pad}## 明细\n\n略\n`;
  assert.match(
    split(padded).detail,
    /^\s{0,3}## 明细/,
    `标题前 ${pad.length} 个空格仍是标题`,
  );
}

// 4 个空格起就是缩进代码块，不是标题——认成标题就可能拆在代码中间。
{
  const indented = `# 报告\n\n    ## 结论\n\n${contract}\n\n    ## 明细\n\n略\n`;
  assert.equal(split(indented).detail, "", "4 空格缩进的是代码块，不构成分界");
}

// 列表项里缩进出来的 `##` 不是顶层标题（第 6 轮补缩进容忍时带出来的洞，本轮自查发现）。
// 只数缩进字符的扫描器会把它当成第二个 `##`，于是它后面的第二条问题被折进明细。
{
  const inList = [
    "# 报告",
    "",
    "## 结论",
    "",
    contract,
    "",
    "### 1. 烧录用了旧字幕",
    "",
    "- 复现步骤：",
    "  ## 这一行在列表项里，不是顶层标题",
    "",
    "### 2. 保存后你刚改的内容会全部消失",
    "",
    "## 明细",
    "",
    "略",
  ].join("\n");
  const { summary, detail } = split(inList);
  assert.match(summary, /保存后你刚改的内容会全部消失/, "第二条问题必须留在首屏");
  assert.match(detail, /^## 明细/, "拆点是那个真的顶层标题");
}

// 引用里的 `##` 同理：贴一段别人的报告当证据，不能拆在它身上。
{
  const quoted = `# 报告\n\n## 结论\n\n${contract}\n\n> ## 上一轮报告里的标题\n\n## 明细\n\n略\n`;
  assert.match(split(quoted).detail, /^## 明细/, "引用里的 `##` 不是分界");
}

// HTML 块里的 `##` 同样不是标题（第 7 轮审查报告的反例）。注释根本不会显示，用户看到的
// 是：首屏写着「有 2 条必须先修」却只列了第一条，摘要断在一个孤零零的 `<!--` 上，第二条
// 要点开「展开技术明细」才出现——还被当成标题渲染。
for (const [kind, open, close] of [
  ["HTML 注释", "<!--", "-->"],
  ["details 块", "<details>", "</details>"],
  ["pre 块", "<pre>", "</pre>"],
]) {
  const hidden = [
    "# 报告",
    "",
    "## 结论",
    "",
    contract,
    "",
    "### 1. 烧录用了旧字幕",
    "",
    open,
    "## 这一段不会当成标题",
    close,
    "",
    "### 2. 保存后你刚改的内容会全部消失",
    "",
    "## 明细",
    "",
    "略",
  ].join("\n");
  const { summary, detail } = split(hidden);
  assert.match(summary, /保存后你刚改的内容会全部消失/, `${kind}：第二条问题必须留在首屏`);
  assert.match(detail, /^## 明细/, `${kind}：拆点是那个真的顶层标题`);
}

// 别矫枉过正：单行注释后面紧跟的真标题还是标题，该拆照拆。
{
  const inline = `# 报告\n\n## 结论\n\n${contract}\n\n<!-- 一行注释 -->\n\n## 明细\n\n略\n`;
  assert.match(split(inline).detail, /^## 明细/, "注释闭合了，后面的 `##` 仍是标题");
}

// 孤立的 `\r`（老式 Mac 换行）：解析器把它当换行、我们按 `\n` 切片，行号对不上。
// 这种时候一律整篇铺开——按错的行号拆就是把内容藏掉。
{
  const cr = `# 报告\r\n\r\n## 结论\r\n\r\n${contract}\r\n\r\n## 明细\r\r略\r\n`;
  const { summary, detail } = split(cr);
  assert.equal(summary, cr, "行号对不上时原样返回，一个字节都不动");
  assert.equal(detail, "");
}

// `###` 是小节内部结构（「必须修的问题」下面每条问题一个小标题），不构成明细分界。
{
  const { summary, detail } = split(`# 报告\n\n## 结论\n\n${contract}\n\n## 明细\n\n略\n`);
  assert.match(summary, /### 烧录出来的成片/);
  assert.match(summary, /改完字幕立刻点烧录/);
  assert.match(detail, /^## 明细/);
}

// Windows 上生成的报告（CRLF）必须一视同仁。踩过的坑不在换行本身，而在正则：`\r` 是
// 行终结符，`.` 不匹配它、不带 `m` 的 `$` 只认串尾，于是 `## 结论\r` 一个标题都认不出，
// 整份合规报告掉进「认不出契约」那条降级路径——首屏全是基线和命令输出，连按钮都没有。
{
  const crlf = conforming.replace(/\n/g, "\r\n");
  const { summary, detail } = split(crlf);
  assert.match(summary, /## 结论/, "CRLF 报告同样要拆出摘要");
  assert.match(summary, /烧录出来的成片/, "问题留在摘要里");
  assert.doesNotMatch(summary, /被审范围|d7ee0b07|清场/, "技术记录不该留在摘要里");
  assert.match(detail, /^## 被审范围与基线/, "明细从第二个 `##` 起");
  // 返回的正文跟入参逐字节一致：认 CRLF 不等于替换用户的换行。
  assert.ok(detail.includes("\r\n"), "切片必须用原始行，别把 CRLF 悄悄改成 LF");
  assert.equal(`${summary}\r\n\r\n${detail}`.replace(/\s+/g, ""), crlf.replace(/\s+/g, ""));
}

// 开头除了标题什么都没写的 CRLF 报告：连引子都没有，整篇铺开。
{
  const legacyCrlf = "# 第 1 轮\r\n\r\n## 一、改动范围\r\n\r\n27 个文件。\r\n\r\n## 三、发现的缺陷\r\n\r\n缺陷 1……\r\n";
  const { summary, detail } = split(legacyCrlf);
  assert.equal(summary, legacyCrlf, "拆不动时原样返回，一个字节都不动");
  assert.equal(detail, "");
}

// 有引子的 CRLF 存量报告走第二档：换行同样不许被悄悄改掉。
{
  const leadCrlf = "# 第 1 轮\r\n\r\n结论：**verify_failed**。\r\n\r\n## 一、改动范围\r\n\r\n27 个文件。\r\n";
  const { summary, detail, kind } = split(leadCrlf);
  assert.equal(kind, "lead");
  assert.ok(summary.includes("\r\n"), "引子也得留着 CRLF");
  assert.ok(detail.includes("\r\n"), "切片必须用原始行");
  assert.match(detail, /^## 一、改动范围/);
  assert.equal(`${summary}\r\n\r\n${detail}`.replace(/\s+/g, ""), leadCrlf.replace(/\s+/g, ""));
}


console.log("review report boundary ok");
