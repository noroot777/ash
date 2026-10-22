// 「扫描器认的那几处引用，跟渲染器真画出来的 `<img>` 是同一批吗」——两边共用的用例表。
//
// 必要性：服务端按扫描器决定「存哪几张、标成正文哪一处引用的」，展示端按它决定「正文哪
// 一处改写成站内地址、哪一张附件被领走」。可这两件事都不是**用户看到的那一步** —— 真正
// 画出来的是 `react-markdown`。扫描器跟它对不上就是审查第 1 轮 F2 那两幕：带括号的文件名
// 被截断（存 0 张、画 0 张），四空格缩进的写法示例被当成真图（改写代码原文、还把工具刚
// 交上来的那张卡片领走，最后一张图都没有）。
//
// 所以回归不能只比「两次调用同一个扫描器」：`scripts/test-markdown-images.mjs` 在 Node 里
// 数 `markdownImageRefs(markdown).length`，在浏览器里数同一段正文渲染出来的 `<img>`，两个
// 数字必须相等。扫描器现在用的就是渲染器内部那颗解析树，所以这张表是它们的**契约**。
export type ImageShape = {
  /** DOM 里那一节的 class 后缀（`.shape-<key>`）。 */
  key: string;
  /** 这种写法想说清什么。 */
  about: string;
  markdown: string;
};

export const IMAGE_SHAPES: ImageShape[] = [
  { key: "paren", about: "文件名里有括号（合法图片，正则那一版截成 output/result(1）", markdown: "![截图](output/result(1).svg)" },
  { key: "escaped-paren", about: "文件名里的括号被转义（解析器要解开它）", markdown: "![截图](output/result\\(1\\).svg)" },
  { key: "indented", about: "四空格缩进的写法示例（渲染器只画代码）", markdown: "写法像这样：\n\n    ![示例](output/shot.svg)\n" },
  { key: "escaped-bang", about: "转义的感叹号（压根不是图）", markdown: "\\![不是图](output/shot.svg)" },
  { key: "reference", about: "引用式图片（渲染器照样画，漏掉它就是「显示得出图、服务端没存过」）", markdown: "![截图][ref]\n\n[ref]: output/ref.svg" },
  { key: "inline-code", about: "行内代码里的写法示例", markdown: "行内 `![示例](output/shot.svg)` 不算" },
  { key: "fenced", about: "围栏代码块里的写法示例", markdown: "```md\n![示例](output/shot.svg)\n```" },
  { key: "title", about: "带 title 的图（title 本应用不读，但不能因此漏掉这张图）", markdown: "![a](output/shot.svg \"标题\")" },
  { key: "angle", about: "`<>` 包起来的带空格中文名", markdown: "![a](<output/结果 图.svg>)" },
  { key: "alt-brackets", about: "alt 里有成对方括号（按字符位置找目的地会在 alt 内部就对上）", markdown: "![a[b]c](output/shot.svg)" },
  { key: "table", about: "GFM 表格里的图（核心语法把它当段落，渲染器当表格——两种解析下都得是同一张图）", markdown: "| 图 |\n|---|\n| ![t](output/t.svg) |" },
  { key: "multiline", about: "括号内换行（逐行扫描看不见它）", markdown: "![跨行](\noutput/shot.svg\n)" },
  // ↓ 这两种是 GFM 扩展**独有**的分歧：核心语法与 GFM 对同一段正文给出不同的图片节点集合。
  // 扫描器少挂 remark-gfm 的那一版在这里两头都错（审查第 2 轮 F2 实测）。
  {
    key: "footnote",
    about: "脚注里的真截图（核心语法当成四空格缩进代码 → 0 张；GFM 当成脚注正文 → 1 张）",
    markdown: "结论见脚注[^a]。\n\n[^a]: 证据：\n\n    ![脚注截图](output/foot.svg)\n",
  },
  {
    key: "orphan-footnote",
    about: "没人引用的脚注定义里的图(定义整节不渲染 → 0 张;解析树里却是真图片节点)",
    markdown: "正文一个字都没引用它。\n\n[^a]: 证据：![孤儿脚注图](output/orphan.svg)\n",
  },
  {
    key: "table-pipe",
    about: "表格单元里有未转义的 `|`（GFM 按它切单元，图片语法被切断 → 0 张；核心语法 → 1 张）",
    markdown: "| 名 | 图 |\n| --- | --- |\n| a | ![示例](output/a|b.svg) |\n",
  },
];
