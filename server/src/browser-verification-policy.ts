import { normalizeBrowserCdpDomains } from "@ash/shared/project";

// 自动验证的浏览器入口必须先保护用户正在使用的 Chrome，再考虑工具便利性。
// 完整正文给首轮 prompt，短版给被打断后的续跑提醒；两份放在一起避免降级顺序漂移。
//
// 第 4 条补的是**能力**这一维(2026-10-13)。前三级只按打扰程度排序，隐含假设三条通道能力
// 等价;实际只有第 1 级在用户已登录的 Chrome 里开标签、天然带 cookie，第 2、3 级都是空
// profile。漏掉这一维的后果不是「少个功能」,而是**需要登录态的任务会一路降级到做不成的
// 方案、产出一份假的「验证失败」,而且全程合规**——agent 没有任何依据判断自己撞的是死路。
// 本机第 1 级恰好长期不可用:codex 走公司网关只能 auth_mode=apikey,而 chrome@openai-bundled
// 只认 ChatGPT 登录态,一律报 `unsupported Codex auth method: apikey`(换模型无效,是账号体系
// 级门控)。所以这里不能只写「第 1 级优先」,必须写明它不可用时该往哪走。
//
// 授权有两档,**默认是不授权**:
//   · 项目白名单(projects.browser_cdp_domains,持久) —— 无人值守任务靠它,一次设好长期有效。
//     这是用户选定的那套方案;「每次在任务里点名」解决不了他的原始诉求(「在我不明确要求
//     用我自己的浏览器的情况下」能不能自动判断),挂起等人的任务跑不成无人值守。
//   · 用户在本任务里临时点名 —— 白名单没覆盖到的一次性需求仍走这条,不必为一次抓取改配置。
// 两档都没有时**不许自行连 CDP**:危害(以用户身份写操作、顶掉会话)和成功长得一模一样,
// 错了没有声音,这正是必须留给人的那类决策。
//
// 改这几段前先看 `server/scripts/test-review-flow.ts` 与 `test-browser-policy-grant.ts`:
// 三级词序、「不得接管、复用或直连用户的普通标签」「Playwright ... headless」、默认拒绝
// 与授权态文本都有断言钉着,而去重锚点是「浏览器验证必须按以下顺序选择通道」这句原文 ——
// 改掉它就会双重注入。

/** 归一化后的项目级授权。null = 未授权(默认)。domains 非空才构造得出。 */
export type BrowserCdpGrant = { readonly domains: readonly string[] } | null;

/**
 * 从项目行取授权。空名单一律归到 null —— 让「未授权」在类型上只有一种形状，
 * 调用方不必再判断 `grant && grant.domains.length`。
 */
export function browserGrantOf(
  project: { browserCdpDomains?: string[] | null } | null | undefined,
): BrowserCdpGrant {
  const domains = normalizeBrowserCdpDomains(project?.browserCdpDomains);
  return domains.length ? { domains } : null;
}

const UNGRANTED_CLAUSE =
  `此时：用户已在本任务中明确授权使用其登录态（点名 web-access 一类 skill，或要求「用我的浏览器」「要登录态」）的，` +
  `可以用 CDP 在其 Chrome 中新建后台标签并只读取数据；没有这种授权就停下来说明缺的是登录态、交用户定夺，不要自行连接。`;

const grantedClause = (domains: readonly string[]) =>
  `**本项目已由用户预先授权**（持久配置，不需要在每个任务里重新点名）：可以用 CDP 连上用户已登录的 Chrome、` +
  `新建后台标签，只读取这些站点及其子域的数据：${domains.join("、")}。` +
  `名单之外的站点不在授权内 —— 需要它们的登录态时，停下来说明，交用户定夺。`;

const SHARED_PROHIBITIONS =
  `无论哪种授权，都禁止 attach 或导航用户已有的标签、激活窗口、切换标签，` +
  `以及任何写操作（发布、点赞、关注、改设置、发消息）；自己开的标签用完就关掉。`;

export function browserVerificationPolicy(grant: BrowserCdpGrant = null): string {
  return `浏览器验证必须按以下顺序选择通道，不得因为某个工具更顺手就跳级：\n` +
    `1. 首选 Browser/Chrome 扩展具名分组后台标签：在用户现有 Chrome 中先命名自动化会话，再新建并保持在后台。` +
    `不得接管、复用或直连用户的普通标签（未获第 4 条授权时，这包括对用户 Chrome 使用 connectOverCDP、调试端口或 GUI 快捷键开标签），` +
    `也不得主动激活 Chrome 窗口或切到验证标签。\n` +
    `2. 扩展不可用、连接失败或无法访问验证页面时，改用独立无头浏览器（临时 profile 的 Chrome/Chromium）；` +
    `Playwright 也必须默认 headless，不得使用 --headed。把扩展不可用的具体原因写进报告。\n` +
    `3. 只有无头浏览器确实无法完成必须验证的浏览器外壳、扩展界面或系统级交互时，才允许启动独立有头浏览器；` +
    `启动前先在报告中写明无头方案为什么不够。仅仅需要截图、看布局或做页面点击，不构成使用有头浏览器的理由。\n` +
    `4. 这三级的能力并不等价：只有第 1 级带用户登录态，第 2、3 级是全新临时 profile、没有任何 cookie。` +
    `任务需要登录后才可见的内容时（抓取私域数据、验证登录态相关行为），第 1 级不可用**不得默默降级**——` +
    `空 profile 撞上登录墙，只会产出一份假的「验证失败」。` +
    (grant ? grantedClause(grant.domains) : UNGRANTED_CLAUSE) +
    SHARED_PROHIBITIONS + `\n\n`;
}

/** 历史名字:未授权态的完整正文。审查/验证 prompt 直接拼它。 */
export const BROWSER_VERIFICATION_POLICY = browserVerificationPolicy(null);

export function browserVerificationReminder(grant: BrowserCdpGrant = null): string {
  return `浏览器验证固定按“扩展具名分组后台标签 → 独立无头浏览器 → 确有必要才独立有头浏览器”降级；` +
    `不得操作用户普通 Chrome 标签（接管、复用、导航、激活、切换一律不行），Playwright 默认 headless，任何降级原因都要写进报告；` +
    `但只有第 1 级带登录态，需要登录后才可见的内容时降级到空 profile 等于做不成——` +
    (grant
      ? `本项目已预先授权用 CDP 连用户 Chrome、新建后台标签只读这些站点及其子域：${grant.domains.join("、")}，名单外的仍要停下来问；`
      : `未经用户在本任务显式授权不得自行连 CDP；`) +
    `无论哪种情况都只许新建后台标签、只读取，禁止 attach 已有标签和一切写操作；`;
}

/** 历史名字:未授权态的短版。 */
export const BROWSER_VERIFICATION_REMINDER = browserVerificationReminder(null);

const globalPolicy = (grant: BrowserCdpGrant) =>
  `【全局浏览器操作规范】无论当前任务是在实现、调试、验证、审查或讨论，只要操作浏览器都必须遵守下文。` +
  `没有专门报告产物时，下文要求写进报告的降级说明改为写进本轮最终回复。\n` +
  browserVerificationPolicy(grant);

const globalReminder = (grant: BrowserCdpGrant) =>
  `【全局浏览器操作提醒】实现、调试、验证、审查和讨论中的浏览器操作都固定按` +
  `“扩展具名分组后台标签 → 独立无头浏览器 → 确有必要才独立有头浏览器”降级；` +
  `扩展会话先命名且标签保持后台，禁止激活 Chrome、切换验证标签、接管/复用/导航普通标签；` +
  `Playwright 必须 headless，扩展失败及任何降级原因写进报告（无报告则写进最终回复）；` +
  `只有无头无法完成浏览器外壳、扩展界面或系统级交互才可独立有头，截图、布局检查或页面点击不算理由。` +
  `需要登录态的任务是唯一例外：只有第 1 级带 cookie，降级到空 profile 等于做不成——` +
  (grant
    ? `本项目已预先授权用 CDP 新建后台标签、只读这些站点及其子域：${grant.domains.join("、")}（名单外仍要停下来问）；`
    : `未经用户在本任务显式授权（点名 web-access 一类 skill，或要求用自己的浏览器）不得自行连 CDP；`) +
  `已授权也只许新建后台标签、只读取，禁止 attach 已有标签、激活窗口和一切写操作。\n\n`;

export function withGlobalBrowserPolicy(
  prompt: string,
  level: "full" | "reminder",
  grant: BrowserCdpGrant = null,
): string {
  if (prompt.includes("浏览器验证必须按以下顺序选择通道") || prompt.includes("【全局浏览器操作")) return prompt;
  return (level === "full" ? globalPolicy(grant) : globalReminder(grant)) + prompt;
}
