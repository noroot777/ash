import { eq } from "drizzle-orm";
import { normalizeBrowserCdpDomains } from "@ash/shared/project";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";

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
// 「只读 + 不接管」这组禁令是**默认态而不是硬禁令**(用户 2026-10-17 拍板):他自己要的活
// 本来就可能是写(「帮我在 x.com 发个帖」),一条绝对禁令只会让 agent 把他的明确指令当违规
// 挡回去。例外的边界必须写进正文:**按项点名、不是一颗总开关** —— 否则「用户说可以写」会被
// 读成「attach 已有标签也一起开了」,而接管标签正是会顶掉他会话的那一项。同理「不许从他大
// 概不介意推出授权」:默许和明确允许的区别一旦模糊,这档例外就等于把上面整节作废。
//
// **策略只在投递点贴**(withGlobalBrowserPolicy),审查/验证正文一律不内嵌。正文是提前生成
// 的,内嵌进去的只能是一份「默认未授权」文本,而且会把下面的去重锚点提前占掉 —— 投递时真读
// 到了项目授权也会被原样挡回,已经授权过的站点照样停下来等人点头(第 6 链第 1 轮审查 P2)。
// 这也是这里不再导出 `BROWSER_VERIFICATION_POLICY`/`_REMINDER` 两个 null 常量的原因:它们
// 存在本身就是那条错路的入口。
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

/**
 * 按项目现读一次授权。**投递消息时用这个,不要用回合启动时捕获的快照** —— 用户在任务
 * 跑着的时候收回授权,后续每一条插话都必须立刻按新授权走;拿旧快照等于撤销对活动任务
 * 无效(第 2 轮审查 P1)。当前回合已经发出去的那部分收不回来,这是 prompt 注入的固有限制。
 */
export async function browserGrantForProject(projectId: string | null | undefined): Promise<BrowserCdpGrant> {
  if (!projectId) return null;
  const row = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
  return browserGrantOf(row);
}

/** 同上,但手里只有 taskId(团队常驻投递、duet 各轮)。查不到任务一律按未授权。 */
export async function browserGrantForTask(taskId: string): Promise<BrowserCdpGrant> {
  const task = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  return browserGrantForProject(task?.projectId);
}

const UNGRANTED_CLAUSE =
  `此时：用户已在本任务中明确授权使用其登录态（点名 web-access 一类 skill，或要求「用我的浏览器」「要登录态」）的，` +
  `可以用 CDP 在其 Chrome 中新建后台标签并只读取数据；没有这种授权就停下来说明缺的是登录态、交用户定夺，不要自行连接。`;

const grantedClause = (domains: readonly string[]) =>
  `**本项目已由用户预先授权**（持久配置，不必每个任务重新点名）：可以用 CDP 连上用户已登录的 Chrome、` +
  `新建后台标签，只读取这些站点及其子域：${domains.join("、")}。` +
  `名单之外不在授权内 —— 需要它们的登录态时停下来说明，交用户定夺。`;

const SHARED_PROHIBITIONS =
  `无论哪种授权，默认都禁止 attach 或导航用户已有的标签、激活窗口、切换标签，` +
  `以及任何写操作（发布、点赞、关注、改设置、发消息）；自己开的标签用完就关。` +
  `唯一的例外是用户明确允许（上面各级同类禁令同口径）：只放开他点名的那一项 —— ` +
  `允许写操作不等于允许接管标签，反之亦然；没点名的仍然禁止，不许从「他大概不介意」推出授权。`;

export function browserVerificationPolicy(grant: BrowserCdpGrant = null): string {
  return `浏览器验证必须按以下顺序选择通道，不得因为某个工具更顺手就跳级：\n` +
    `1. 首选 Browser/Chrome 扩展具名分组后台标签：先命名自动化会话，再在用户现有 Chrome 里新建并保持后台。` +
    `不得接管、复用或直连用户的普通标签（未获第 4 条授权时，connectOverCDP、调试端口、GUI 快捷键开标签都算），` +
    `也不得激活 Chrome 窗口或切到验证标签。\n` +
    `2. 扩展不可用、连接失败或打不开验证页面时，改用独立无头浏览器（临时 profile 的 Chrome/Chromium）；` +
    `Playwright 也必须默认 headless，不得 --headed。扩展不可用的具体原因写进报告。\n` +
    `3. 只有无头确实做不到的浏览器外壳、扩展界面或系统级交互，才允许独立有头浏览器，` +
    `启动前先在报告里写明无头为什么不够；仅仅要截图、看布局或点页面，不构成理由。\n` +
    `4. 三级能力并不等价：只有第 1 级带用户登录态，第 2、3 级是全新临时 profile、没有 cookie。` +
    `任务需要登录后才可见的内容时（抓私域数据、验证登录态相关行为），第 1 级不可用**不得默默降级**——` +
    `空 profile 撞上登录墙只会产出一份假的「验证失败」。` +
    (grant ? grantedClause(grant.domains) : UNGRANTED_CLAUSE) +
    SHARED_PROHIBITIONS + `\n\n`;
}

const globalPolicy = (grant: BrowserCdpGrant) =>
  `【全局浏览器操作规范】实现、调试、验证、审查、讨论中只要操作浏览器都按下文。` +
  `没有专门报告产物时，下文要求写进报告的降级说明改为写进本轮最终回复。\n` +
  browserVerificationPolicy(grant);

const globalReminder = (grant: BrowserCdpGrant) =>
  `【全局浏览器操作提醒】浏览器操作固定按` +
  `“扩展具名分组后台标签 → 独立无头浏览器 → 确有必要才独立有头浏览器”降级；` +
  `扩展会话先命名且标签保持后台，禁止激活 Chrome、切换验证标签、接管/复用/导航普通标签；` +
  `Playwright 必须 headless，扩展失败及任何降级原因写进报告（无报告则写进最终回复）；` +
  `只有无头做不到的浏览器外壳、扩展界面或系统级交互才可独立有头，截图、布局检查或页面点击不算理由。` +
  `需要登录态的任务是唯一例外：只有第 1 级带 cookie，降级到空 profile 等于做不成——` +
  (grant
    ? `本项目已预先授权用 CDP 新建后台标签、只读这些站点及其子域：${grant.domains.join("、")}（名单外仍要停下来问）；`
    : `未经用户在本任务显式授权（点名 web-access 一类 skill，或要求用自己的浏览器）不得自行连 CDP；`) +
  `已授权也只许新建后台标签、只读取，默认禁止 attach 已有标签、激活窗口和一切写操作；` +
  `只有用户明确允许才放开他点名的那一项（上面同类禁令同口径），没点名的照旧禁止，不许自行推断。\n\n`;

export function withGlobalBrowserPolicy(
  prompt: string,
  level: "full" | "reminder",
  grant: BrowserCdpGrant = null,
): string {
  if (prompt.includes("浏览器验证必须按以下顺序选择通道") || prompt.includes("【全局浏览器操作")) return prompt;
  return (level === "full" ? globalPolicy(grant) : globalReminder(grant)) + prompt;
}
