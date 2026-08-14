// 自动验证的浏览器入口必须先保护用户正在使用的 Chrome，再考虑工具便利性。
// 完整正文给首轮 prompt，短版给被打断后的续跑提醒；两份放在一起避免降级顺序漂移。
export const BROWSER_VERIFICATION_POLICY =
  `浏览器验证必须按以下顺序选择通道，不得因为某个工具更顺手就跳级：\n` +
  `1. 首选 Browser/Chrome 扩展具名分组后台标签：在用户现有 Chrome 中先命名自动化会话，再新建并保持在后台。` +
  `不得接管、复用或直连用户的普通标签（包括对用户 Chrome 使用 connectOverCDP、调试端口或 GUI 快捷键开标签），` +
  `也不得主动激活 Chrome 窗口或切到验证标签。\n` +
  `2. 扩展不可用、连接失败或无法访问验证页面时，改用独立无头浏览器（临时 profile 的 Chrome/Chromium）；` +
  `Playwright 也必须默认 headless，不得使用 --headed。把扩展不可用的具体原因写进报告。\n` +
  `3. 只有无头浏览器确实无法完成必须验证的浏览器外壳、扩展界面或系统级交互时，才允许启动独立有头浏览器；` +
  `启动前先在报告中写明无头方案为什么不够。仅仅需要截图、看布局或做页面点击，不构成使用有头浏览器的理由。\n\n`;

export const BROWSER_VERIFICATION_REMINDER =
  `浏览器验证固定按“扩展具名分组后台标签 → 独立无头浏览器 → 确有必要才独立有头浏览器”降级；` +
  `不得操作用户普通 Chrome 标签或直连其调试端口，Playwright 默认 headless，任何降级原因都要写进报告；`;

const GLOBAL_BROWSER_POLICY =
  `【全局浏览器操作规范】无论当前任务是在实现、调试、验证、审查或讨论，只要操作浏览器都必须遵守下文。` +
  `没有专门报告产物时，下文要求写进报告的降级说明改为写进本轮最终回复。\n` +
  BROWSER_VERIFICATION_POLICY;

const GLOBAL_BROWSER_REMINDER =
  `【全局浏览器操作提醒】实现、调试、验证、审查和讨论中的浏览器操作都固定按` +
  `“扩展具名分组后台标签 → 独立无头浏览器 → 确有必要才独立有头浏览器”降级；` +
  `扩展会话先命名且标签保持后台，禁止激活 Chrome、切换验证标签、接管/复用/直连普通标签；` +
  `Playwright 必须 headless，扩展失败及任何降级原因写进报告（无报告则写进最终回复）；` +
  `只有无头无法完成浏览器外壳、扩展界面或系统级交互才可独立有头，截图、布局检查或页面点击不算理由。\n\n`;

export function withGlobalBrowserPolicy(prompt: string, level: "full" | "reminder"): string {
  if (prompt.includes("浏览器验证必须按以下顺序选择通道") || prompt.includes("【全局浏览器操作")) return prompt;
  return (level === "full" ? GLOBAL_BROWSER_POLICY : GLOBAL_BROWSER_REMINDER) + prompt;
}
