// 没有类型的老记录里，哪些是「要你知道 / 确实没办成」的那几句。
//
// 带类型的时间线（shared/src/timeline-notice.ts）只有这条分支以后的服务端才写；在那之前落盘的、
// 以及线上还在跑的老服务端写的，一条类型都没有。它们原先按关键词猜语气——原文里带「失败」
// 「错误」就升成常显的红字，于是「哨兵已起：<描述>（<命令>）」这种回执只因为命令里有个 fail
// 就成了一行红色感叹号。这里改成**按起头认**：照服务端标成 `alertLine(...)` 的那批调用点
// （server/src 里 `alertLine(` 的每一处），把它们写死的起头抄成一张表。表里没有的一律是回执。
//
// 认的是**整条记录的外层写法**，判据只许落在服务端自己写的字上，不许落在它引进来的那一截上——
// 描述、命令、分支名、标题、报错原文什么话都可能有（「哨兵已起：检查条目太多放不进指令时的恢复
// 行为」、成功的命令里恰好有一句「` 未通过：」）。所以每一条只用下面三种判法之一：
//   1. **开头**（`ALERT_LEADS`）：从第一个字起就是服务端写死的、只有提醒才这么起头的那几个字。
//      起头里带变量的，变量只能是服务端的封闭取值（「自由工作流第 N 轮审查」「审查者 / 执行者」），
//      不许是任意文字；开头之后不再往下匹配——判据已经在开头了，后面引了什么都不改变它。
//   2. **结尾**（`ALERT_ENDINGS`）：开头跟回执共用（「独立验证尚未执行：…」既有「需明确确认」的
//      提醒，也有「已显式确认继续」的回执），就认整句最后那几个服务端写死的字（`$` 钉住）。引进来
//      的那一截都夹在中间，够不着结尾。
//   3. **结构**：成败写在引文**紧后面**、开头又跟回执共用的那两种，各有一个解码函数——
//      门禁摘要（`gateVerdict`）照样能从结尾认；工作流里跑的命令（`commandVerdict`）前后都夹着
//      引文，从字面上**不一定**认得出，认不出就说认不出（`unknown`），不替它猜。
//
// 判据由此有一条不变量：引进来的那一截改成什么，都不会把一条记录从回执翻成提醒、或者反过来；
// 最多让它从「认得出」变成「认不出」。
// 另一张是结算说明（服务端带 `level:"notice"` 落的那种，「这一轮为什么落成这个状态」）。它们
// 一律没有类型，按同一个办法认：没交卷、被 ash 判失败的那几句要你知道；其余（等哨兵改落暂停、
// 以提问暂停、你自己停的）界面别处已经在说，是回执。

import { ACCEPT_GATE_FAILURE_LABELS } from "@ash/shared/accept-gate";
import { COMMAND_NOTE_HEAD } from "@ash/shared/command-note";

/** 判法 1：只有提醒才这么起头（注释是写它的文件，便于对照）。 */
const ALERT_LEADS: readonly RegExp[] = [
  // 验收
  /^验收暂缓[：:]/, // task-accept
  /^验收未完成[：:]/, // task-accept / accept-gate
  /^验收清理未完成[：:]/, // task-accept
  /^合并清理警告[：:]/, // task-accept
  /^注意[：:]/, // task-accept / accept-gate（目标分支漂移）
  /^半删除工作区的剩余源码已与任务提交核对/, // task-accept
  /^(合并已完成但按你的选择没有提交：|合并已完成：成果已合入 |验收标签已创建)/, // task-accept 清理那一段（「…清理尚未完成。」）
  /^(合并已完成，结果已保留。|标签已保留。)?(预览启动正在退出，请稍后重试|预览已被另一趟启动替换|预览依赖仍被其他预览进程使用|预览停止记录暂时无法读写|已请求停止预览，但仍有进程未退出|预览进程仍存活，但暂时无法确认启动身份)/, // task-accept-finalize / preview / preview-process-stop（回收没成）
  /^(合并已完成，结果已保留。)?验收途中团队(又跑出了新的结果|加进了新的执行者)/, // task-accept-finalize / team-acceptance-hold
  /^验收没有执行：点验收时看到的那一版之后/, // task-human-gate
  /^这一下没有执行：点的是这条线上一段的卡/, // task-human-gate
  /^替你提交这次合并没成功/, // task-accept-pending
  /^git commit 跑完了，但/, // task-accept-pending
  /^重新合并未完成/, // task-accept-pending
  /^统一验收暂停/, // task-branch-routes
  /^放行之后想接着往下走，但出错了/, // task-accept-tail
  /^合并已经做完了，卡住的是「点头之后」那一段/, // task-accept-tail
  /^验收在门禁发射前异常退出/, // task-accept-gate-launch
  /^更新基线发生冲突或 rebase 失败/, // task-base-update
  /^升级迁移：上一版(验收停在「合并进行中」|「合并&清理」失败)/, // db/migrations（要你重新验收的那两条；补上标记的那条是回执）
  /^冲突交接失败/, // accept-conflict
  // 验收前置命令（门禁）。摘要那一句的成败在命令后面，见 gateVerdict。
  /^这条命令点名要跑的/, // accept-gate-miss（单独一条的归因）
  /^起跑前在 /, // accept-gate-miss
  /^日志里说 /, // accept-gate-miss
  /^这一次红的原因看起来是有东西没解析出来/, // accept-gate-miss
  /^验收前置命令未执行/, // accept-gate
  /^验收前置命令尚未确认整棵进程树退出/, // accept-gate-settle
  /^验收前置命令被打断/, // accept-gate-recover
  /^ash 重启后继续核对验收前置命令/, // accept-gate-recover
  /^验收前置命令接管降级/, // accept-gate-recover
  /^已显式确认风险并强制释放验收前置命令/, // accept-gate-release
  /^验收前置命令通过了，但当初那一下验收的选择/, // accept-gate-continue
  /^验收前置命令通过后自动继续验收/, // accept-gate-continue
  /^门禁交接失败/, // accept-gate-handoff
  /^门禁交接：已叫醒该任务/, // accept-gate-handoff（「交接不明」那一句见 ALERT_ENDINGS）
  // 审查
  /^自由工作流审查意见修复已取消/, // free-review-manual-repair
  /^合并结果审查临时工作区清理失败/, // free-review-round
  /^已裁定维持审查意见，但这次没能自动发起修复/, // free-review-dispute
  /^同类问题熔断的完整清单写不进证据目录/, // free-review-prompts
  /^(合并结果审查|自由工作流第 \d+ 轮审查)的任务书正在等一个空闲回合窗口，但这一轮的派发意图没能存进库里/, // free-review-dispatch
  /^(辩论第 \d+ 段没能起跑|辩论找不到正在发言的那一段|辩论的被辩对象已经不在了|服务重启时这一段辩论已经没有回合在跑|(审查者|执行者)这一(段被停止或异常结束|回合结束时没有调用 debate_reply 交卷))/, // free-review-debate
  /^审查预约已取消[：:]/, // free-review-reservations
  /^预约审查启动失败/, // free-review-reservations
  /^完成后审查预约已取消[：:]/, // reviewer-profiles
  /^修复执行回合异常结束，自动复审已取消/, // free-workflow
  /^(合并结果|自由工作流第 \d+ 轮)审查(回合已结束，但任务书有没有送进审查者手里|的任务书被协议层明确拒收|的任务书有没有送进审查者手里，已经确认不了)/, // review-input-verdict
  /^服务在审查输入交付期间中断/, // review-start-retry
  /^审查已完成，但后续工作流/, // review-finalization
  /^这一轮的审查报告可能已经写完了，只是结论没能上报到 ash/, // review-channel-gap
  /^这一轮没交卷多半不是 agent 漏了/, // review-channel-gap
  /^想自动开一轮验证，但没开起来/, // review
  /^审查缺少持久保存的真实退出结果/, // regression-settlement
  /^通过结论的依据已失效/, // regression-settlement
  /^验证依据暂不可核验/, // regression-settlement
  /^本次验收明确补跑原审查尚未完成的尾段/, // regression-finalization
  /^强制通过之后想接着往下走，但出错了/, // verify-override
  // 工作流的站。跑一条命令那一句的成败夹在引文中间，见 commandVerdict。
  /^预览没起来/, // workflow-steps
  /^想把这一站打回重做，但唤醒任务时出错/, // workflow-steps
  /^这条线停在「[^」]+」这一站：自动复审轮数已经用完/, // workflow-advance（站名是内置的那几个）
  /^想在「[^」]+」这一站开一轮验证，但没开起来/, // workflow-advance
  // 预览
  /^预览异常[：:]/, // preview-start
  /^预览清理暂缓[：:]/, // preview
  /^预览进程已自行退出/, // preview
  /^旧预览回收暂缓/, // status
  // 起跑与回合
  /^这一轮没能起跑[：:]/, // turn-failure（含刚发的消息没送达）
  /^任务登记的基线分支 /, // base-fallback-notice
  /^起跑预检提示/, // ash-mcp-launch-gate / ash-mcp-turn-hint
  /^本次启动失败，未能继续执行/, // queue-seat
  /^续聊未能启动/, // task-reply
  /^(重试这一回合|重跑上一回合)(未能启动：回合被其它执行抢占|启动失败：)/, // task-retry-turn（「重跑上一回合」是老记录的说法）
  /^这一轮在启动前被撤回/, // turn-freeze
  /^这一轮改了代码，但没有确认完成/, // turn-baseline
  /^〔上游停滞·(重启后按失败收尾|上一次运行的结局核实不了)〕/, // turn-stall-text（重启对账）
  /^引导会话未执行/, // task-steer
  /^这一轮的续跑交代\*\*可能已经\*\*交给/, // task-checkpoint-delivery
  /^(排队消息|等前置任务的消息|定时消息)未发送，已取消/, // pending-messages
  // 持续目标、哨兵、接力
  /^持续目标因服务中断已暂停/, // task-reconcile
  /^持续目标尚未启动就遇到服务中断/, // task-reconcile
  /^原生目标清除失败/, // task-cli-command
  /^哨兵没能开工：/, // monitor-create-abort
  /^(⚠️ 用户在无法核验|🔁 用户安全撤销了本次移回|🔁 对端确认未收到任务并登记撤销后)/, // handoff-routes
];

/** 判法 2：开头跟回执共用、只有结尾分得开的那几句。 */
const ALERT_ENDINGS: readonly RegExp[] = [
  // task-accept：「以下团队执行者的独立验证尚未执行：<标题…>」后面接「需明确确认」是提醒，接「已显式确认继续」是回执。
  /^(以下团队执行者的)?独立验证尚未执行：[\s\S]*本次验收未执行，需明确确认仍要验收。$/,
  // accept-gate-handoff：交接不明（「门禁交接：修复输入已持久入队…」是回执）。
  /^门禁交接：[\s\S]*看一眼会话里有没有这条修复要求，没有的话在验收台上点「再交一次」（日志 [^\n]*）。$/,
  // workflow-steps：站名是线上自己写的；「这条线卡在「X」这一站；线上写的是「问我一句」…」「…打回给 AI 重做（第 N 次）」是回执。
  /^这条线卡在「[\s\S]+」这一站，停下等你处理。$/,
  /^「[\s\S]+」已经打回重做 \d+ 次仍没过，按线上写的上限停下等你处理。$/,
  // monitors：描述和结束条件都是原样引的。
  /^哨兵「[\s\S]+」存着一条这一版读不出来的结束条件「[\s\S]*」（结束条件不是正则，是字样）。它不会提前收工，只会盯到到期——要让它早点收工，用改得对的条件另起一个。$/,
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 门禁没跑绿时摘要里的原因（shared/accept-gate 的标签；查不到标签的旧类别照实写「未通过」）。 */
const GATE_WHY = [...Object.values(ACCEPT_GATE_FAILURE_LABELS), "未通过"].map(escape).join("|");
/** 摘要里紧跟在命令后面、没跑绿的那个成败：「` 未通过：<原因>（rc=N）」，后面是句号、空白或结尾。 */
const GATE_FAILED = new RegExp(`\` (?:未通过|被打断|已取消)：(?:${GATE_WHY})(?:（rc=-?\\d+）)?(?=。|\\s|$)`);

/**
 * accept-gate-settle：「验收前置命令 `<命令>` <成败>。<服务端补的说明>」。命令是你写的，补的说明里也会
 * 引命令最后吐的那一行（超时那种「停在 `<最后一行>`」），两头都可能有一段像成败的字，所以不在中间找。
 * 跑绿了的那一句后面**什么都不补**（补的说明只有超时、被收掉时才有），整句一定以「` 通过（rc=0）。」收尾；
 * 没跑绿的结尾不是成败本身，就是服务端写死的说明。所以认结尾：结尾是跑绿了的就是回执，否则是提醒。
 */
const GATE_HEAD = "验收前置命令 `";

function gateVerdict(text: string): "passed" | "failed" | null {
  if (!text.startsWith(GATE_HEAD)) return null;
  if (/` 通过（rc=0）。?\s*$/.test(text)) return "passed";
  return GATE_FAILED.test(text) ? "failed" : null;
}

export type CommandVerdict = "passed" | "failed" | "unknown";

/**
 * workflow-steps：「跑了一条命令：`<命令>`（通过|没通过）」，后面换行接命令的输出（生成那一头在
 * @ash/shared/command-note，格式以它为准）。命令和输出都是任意文字（命令可以跨行、可以引一段
 * 「`（没通过）」），开头结尾都夹着引文，单看字面切不准命令在哪儿结束。
 *
 * 所以把每一种切法都列出来：命令在某个「`（通过）/（没通过）」之前结束、后面是换行或者整句到头。真的
 * 那一种一定在里面——各种切法给的成败一样，那就是它；不一样，再拿任务工作流里写的那几条命令（`commands`）
 * 逐字对一遍，对得上唯一一种切法就是它；还定不了、或者一种切法都列不出来，就是认不出。
 *
 * 切法只认「换行或到头」，不要求换行后面还有字：没通过的原因可以是空串（命令只吐了空白，裁完就空了），
 * 那句话以「（没通过）\n」结尾，展示前再裁一道空白就只剩「（没通过）」。要求后面非空，真的那一种切法
 * 就会掉出去，剩下引文里那段「`（通过）」说了算——把失败认成回执。多列几种切法只会多一些认不出，
 * 少列真的那一种就会认反。
 */
export function commandVerdict(text: string, commands: readonly string[] = []): CommandVerdict | null {
  if (!text.startsWith(COMMAND_NOTE_HEAD)) return null;
  const rest = text.slice(COMMAND_NOTE_HEAD.length);
  const verdictAt = (end: number): "passed" | "failed" | null => {
    const tail = rest.slice(end);
    if (/^`（没通过）(?:\n|$)/.test(tail)) return "failed";
    return /^`（通过）(?:\n|$)/.test(tail) ? "passed" : null;
  };
  const cuts = new Map<number, "passed" | "failed">();
  for (let end = rest.indexOf("`（"); end >= 0; end = rest.indexOf("`（", end + 1)) {
    const verdict = verdictAt(end);
    if (verdict) cuts.set(end, verdict);
  }
  const verdicts = new Set(cuts.values());
  if (verdicts.size === 1) return [...verdicts][0]!;
  const known = new Set([...new Set(commands)].flatMap((cmd) => cuts.has(cmd.length) && rest.startsWith(cmd) ? [cuts.get(cmd.length)!] : []));
  return known.size === 1 ? [...known][0]! : "unknown";
}

/** 结算说明里要你知道的那几句（server/src/settle-status.ts 的落位说明）。 */
const SETTLEMENT_LEADS: readonly RegExp[] = [
  /^本回合没有交卷/, // 没调 complete_task，记未完成
  /^本回合被 ash 主动终止/, // 熔断
  /^本回合是上次 ash 中断时留下的/, // 读不出熔断判决
  /^后台工作流\/子代理(等到时限还没跑完|还没跑完[,，]智能体进程就退出了)/, // 后台活没跑完
  /^ash 重启接管时读不出这个进程之前的输出/,
  /^持续目标已停止，尚未收到完成确认/,
  /^续聊回合(因上游连不上|是上次中断留下的|等后台工作|的后台工作|异常结束)/, // 续聊这一轮没办成（你自己停的、以提问结束的是回执）
  /^持续目标已(暂停|清除)；/, // 你那条 /goal pause、/goal clear 的结果：怎么续跑写在里面
];

/** 回执里最常引别人原话的那几种：不管后面引了什么，一律是回执。 */
const RECEIPT_LEADS: readonly RegExp[] = [
  /^哨兵(已起|结束)[：:]/, // monitors：描述和命令原样跟在后面
];

function head(raw: string): string {
  return raw.replace(/^〔系统〕/, "").trimStart();
}

/**
 * 整句是服务端的固定格式、中间原样夹着你写的字（命令、命令的输出、哨兵的描述）的那几种。它们只能按
 * 格式认（commandVerdict / gateVerdict / RECEIPT_LEADS），**不能**再拿去全文找字：命令里写一句
 * 「第 2 轮审查通过」「现在由你裁定：」，全文找字的那几处（待裁定、工作区恢复…；审查轮起止已改成按起头认，见 REVIEW_ROUND_LEADS）就把
 * 一条没通过的命令认成了别的事。认老记录的各处先问它一声，是就只交给 legacyTier。
 */
export function quotesUserText(raw: string): boolean {
  const text = head(raw);
  return text.startsWith(COMMAND_NOTE_HEAD) || text.startsWith(GATE_HEAD) || RECEIPT_LEADS.some((lead) => lead.test(text));
}

/**
 * 审查轮的起止（没有类型的老记录；带类型的按类型认，见 conversationNotes 的 verifyMark）。同样**只认开头**：
 * 全部会话记录里量过，真是一轮审查起止的那几句，服务端写死的说法都在句首；在全文里找「第 N 轮审查」，
 * 引了哨兵描述、命令、审查意见的那些（「本回合要落的终态被拦下，改为检查点暂停：…（第 1 轮审查修复后重跑…）」
 * 「你裁定把第 2 轮里超出本任务边界的…」「不再等哨兵「…第 4 轮审查…」…」）都会被认成一轮的起止，
 * 把审查段和哨兵叫醒的并回一起切碎。
 *
 * `word` 是紧跟在开头后面的那个词，开区间还是收口看它（`ROUND_OPENERS`）。
 */
const REVIEW_ROUND_LEADS: readonly { kind: "inline" | "free" | "merge"; lead: RegExp }[] = [
  // free-review-round / free-review-finalization
  { kind: "free", lead: /^自由工作流第\s*(?<round>\d+)\s*轮审查(?<word>开始|重跑上一回合|从中断处继续|通过|未通过|未能正常给出结论|启动失败|已终止)/ },
  // free-review-manual-repair（「完成修复」是更早的服务端写的）
  { kind: "free", lead: /^已按自由工作流第\s*(?<round>\d+)\s*轮审查意见(?<word>发起修复|完成修复)/ },
  // 收尾时不带轮号的那几条：复审次数用完、验证打回本身报错。
  { kind: "free", lead: /^(?<word>自由工作流审查仍未通过|验证打回)/ },
  // review / review-finalization / verify-override（就地验证）
  { kind: "inline", lead: /^第\s*(?<round>\d+)\s*轮验证(?<word>开始|结束时|已结束|未通过|仍未通过|以|启动失败|已终止|没有给出结论)/ },
  // 更早的服务端：就地验证叫「审查」的那几年，以及独立审查任务收尾的那一句。
  { kind: "inline", lead: /^第\s*(?<round>\d+)\s*轮审查(?<word>未通过|仍未通过|任务\s*\S+\s*以)/ },
  // post-merge-review：跑在验收后的只读快照上，从头到尾没有轮号。同前缀的杂音（「合并结果审查临时工作区清理
  // 失败」）不在这张表里。
  { kind: "merge", lead: /^合并结果审查(?<word>开始|重跑上一回合|从中断处继续|通过|未通过|未能正常给出结论|启动失败)/ },
];
// 开区间的词：「开始」，以及重跑那两句（「重跑上一回合」＝重发任务书从头跑，「从中断处继续」＝接着上一回合做）
// ——它们开的都是同一轮的新回合，判成收口的话，重跑后审查者的发言会整段掉出区间。
const ROUND_OPENERS = new Set(["开始", "重跑上一回合", "从中断处继续"]);

export type LegacyReviewMark = { kind: "inline" | "free" | "merge"; round: number | null; phase: "start" | "end" };

/** 没有类型的老记录是不是一轮审查的起止（按起头认，见 REVIEW_ROUND_LEADS）。 */
export function legacyReviewMark(raw: string): LegacyReviewMark | null {
  const text = head(raw);
  for (const { kind, lead } of REVIEW_ROUND_LEADS) {
    const groups = lead.exec(text)?.groups;
    if (!groups) continue;
    const round = groups.round === undefined ? null : Number(groups.round);
    return { kind, round: Number.isFinite(round) ? round : null, phase: ROUND_OPENERS.has(groups.word ?? "") ? "start" : "end" };
  }
  return null;
}

function alertShape(text: string): boolean {
  return ALERT_LEADS.some((lead) => lead.test(text)) || ALERT_ENDINGS.some((ending) => ending.test(text));
}

export type LegacyTier = "alert" | "receipt" | "unknown";

/**
 * 没有类型的时间线记录摆在哪一档：服务端当时会标成 `alertLine` 的是 `alert`，其余是回执；
 * 工作流里跑的那条命令从字面上认不出成败的是 `unknown`（见 commandVerdict）。
 * `settlement`：这是一条结算说明（`level:"notice"`），多认 SETTLEMENT_LEADS 那几句。
 * `commands`：这个任务的工作流里写的那几条命令，认命令那一句时拿来对。
 * `source`：落盘的原话（没裁空白、没换预览地址）。命令那一句和门禁摘要按格式切，切点靠的是原话里
 * 的每一个字——展示前那几道归一会改掉命令里的地址、裁掉结尾的换行，拿改过的字去对工作流里的命令就对不上。
 */
export function legacyTier(raw: string, options: { settlement?: boolean; commands?: readonly string[]; source?: string } = {}): LegacyTier {
  const text = head(raw);
  if (RECEIPT_LEADS.some((lead) => lead.test(text))) return "receipt";
  const said = head(options.source ?? raw);
  const command = commandVerdict(said, options.commands);
  if (command) return command === "failed" ? "alert" : command === "passed" ? "receipt" : "unknown";
  const gate = gateVerdict(said);
  if (gate) return gate === "failed" ? "alert" : "receipt";
  if (options.settlement && SETTLEMENT_LEADS.some((lead) => lead.test(text))) return "alert";
  return alertShape(text) ? "alert" : "receipt";
}
