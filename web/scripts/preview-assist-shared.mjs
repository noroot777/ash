// 「AI 协助」几组浏览器回归共用的小工具。用例本身分在两个文件里：
//   · test-preview-assist-ui.mjs          —— 单页生命周期 + 同 context 多标签（①–⑬、⑱、⑲）
//   · preview-assist-fallback-cases.mjs   —— 没有 Web Locks 的降级路（⑭–⑰）

/** 读启动脚本输入框里的文字。占位行要读成空串，否则「清空」这一档比不出来。 */
export const editorText = async (editor) => editor.locator(".cm-line").evaluateAll((lines) =>
  lines.map((line) => (line.querySelector(".cm-placeholder") ? "" : line.textContent)).join("\n"));
