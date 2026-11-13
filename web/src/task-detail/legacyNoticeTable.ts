// 没有类型的老记录里，哪些是「要你知道 / 确实没办成」的那几句。
//
// 带类型的时间线（shared/src/timeline-notice.ts）只有这条分支以后的服务端才写；在那之前落盘的、
// 以及线上还在跑的老服务端写的，一条类型都没有。它们原先按关键词猜语气——原文里带「失败」
// 「错误」就升成常显的红字，于是「哨兵已起：<描述>（<命令>）」这种回执只因为命令里有个 fail
// 就成了一行红色感叹号。这里改成**按起头认**：照服务端标成 `alertLine(...)` 的那批调用点
// （server/src 里 `alertLine(` 的每一处），把它们写死的起头抄成一张表。表里没有的一律是回执。
//
// 认的是**整条记录的外层写法**：每一条都钉在行首（起头本身是变量的，比如「第 3 轮审查的任务书…」
// 「重跑上一回合未能启动…」，就限定那段变量里没有冒号，或者钉住整句结尾），不在全文里找子串。
// 带进来的描述、命令、报错原文什么话都可能有——「哨兵已起：检查条目太多放不进指令时的恢复行为」
// 里引的那半句不能让一条回执升成警报。起头是变量拼出来的（门禁摘要、归因、预览回收没成……）就
// 沿着生成它的函数把每一种起头都抄进来，不只抄调用点那一行。
//
// 另一张是结算说明（服务端带 `level:"notice"` 落的那种，「这一轮为什么落成这个状态」）。它们
// 一律没有类型，按同一个办法认：没交卷、被 ash 判失败的那几句要你知道；其余（等哨兵改落暂停、
// 以提问暂停、你自己停的）界面别处已经在说，是回执。

/** `alertLine(...)` 那批调用点的固定写法（注释是写它的文件，便于对照）。 */
const ALERT_LEADS: readonly RegExp[] = [
  // 验收
  /^验收暂缓[：:]/, // task-accept
  /^验收未完成[：:]/, // task-accept / accept-gate
  /^验收清理未完成[：:]/, // task-accept
  /^合并清理警告[：:]/, // task-accept
  /^注意[：:]/, // task-accept / accept-gate（目标分支漂移）
  /^半删除工作区的剩余源码已与任务提交核对/, // task-accept
  /^(合并已完成但按你的选择没有提交：|合并已完成：成果已合入|验收标签已创建)[\s\S]*清理尚未完成。/, // task-accept 清理那一段
  /^(合并已完成，结果已保留。|标签已保留。)?[\s\S]*验收收尾暂缓，处理后可再次验收。$/, // task-accept-finalize（预览回收）
  /^(合并已完成，结果已保留。)?验收途中团队(又跑出了新的结果|加进了新的执行者)/, // task-accept-finalize / team-acceptance-hold
  /^(以下团队执行者的)?独立验证尚未执行：/, // task-accept（需明确确认仍要验收）
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
  // 验收前置命令（门禁）
  /^验收前置命令 `[\s\S]*` (未通过|被打断|已取消)：/, // accept-gate-settle（summarizeAcceptGate 没跑绿的那几档）
  /^这条命令点名要跑的/, // accept-gate-miss（单独一条的归因）
  /^起跑前在 [\s\S]* 里没找到 /, // accept-gate-miss
  /^日志里说 [\s\S]* 没解析出来，而这条命令点名要跑的也叫这个名字/, // accept-gate-miss
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
  /^门禁交接：(已叫醒该任务|[\s\S]*看一眼会话里有没有这条修复要求)/, // accept-gate-handoff（已叫醒去修 / 交接不明；已入队等投递是回执）
  // 审查
  /^自由工作流审查意见修复已取消/, // free-review-manual-repair
  /^合并结果审查临时工作区清理失败/, // free-review-round
  /^已裁定维持审查意见，但这次没能自动发起修复/, // free-review-dispute
  /^同类问题熔断的完整清单写不进证据目录/, // free-review-prompts
  /^[^：:\n]{1,40}的任务书正在等一个空闲回合窗口，但这一轮的派发意图没能存进库里/, // free-review-dispatch（起头是「第 N 轮审查」这种标签）
  /^(辩论第 \d+ 段没能起跑|辩论找不到正在发言的那一段|辩论的被辩对象已经不在了|服务重启时这一段辩论已经没有回合在跑|(审查者|执行者)这一(段被停止或异常结束|回合结束时没有调用 debate_reply 交卷))/, // free-review-debate
  /^审查预约已取消[：:]/, // free-review-reservations
  /^预约审查启动失败/, // free-review-reservations
  /^完成后审查预约已取消[：:]/, // reviewer-profiles
  /^修复执行回合异常结束，自动复审已取消/, // free-workflow
  /^[^：:\n]{0,30}审查(回合已结束，但任务书有没有送进审查者手里|的任务书被协议层明确拒收|的任务书有没有送进审查者手里，已经确认不了)/, // review-input-verdict
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
  // 工作流的站
  /^跑了一条命令：`[\s\S]*`（没通过）/, // workflow-steps
  /^预览没起来/, // workflow-steps
  /^这条线卡在「[^」]+」这一站，停下等你处理/, // workflow-steps
  /^「[^」]+」已经打回重做 \d+ 次仍没过/, // workflow-steps
  /^想把这一站打回重做，但唤醒任务时出错/, // workflow-steps
  /^这条线停在「[^」]+」这一站：自动复审轮数已经用完/, // workflow-advance
  /^想在「[^」]+」这一站开一轮验证，但没开起来/, // workflow-advance
  // 预览
  /^预览异常[：:]/, // preview-start
  /^预览清理暂缓[：:]/, // preview
  /^预览进程已自行退出/, // preview
  /^旧预览回收暂缓/, // status
  /^(预览启动正在退出，请稍后重试|预览已被另一趟启动替换|预览依赖仍被其他预览进程使用|预览停止记录暂时无法读写|已请求停止预览，但仍有进程未退出|预览进程仍存活，但暂时无法确认启动身份)/, // preview / preview-process-stop（回收没成）
  // 起跑与回合
  /^这一轮没能起跑[：:]/, // turn-failure（含刚发的消息没送达）
  /^任务登记的基线分支 [\s\S]* 已不存在/, // base-fallback-notice
  /^起跑预检提示/, // ash-mcp-launch-gate / ash-mcp-turn-hint
  /^本次启动失败，未能继续执行/, // queue-seat
  /^续聊未能启动/, // task-reply
  /^[^：:\n]{1,20}未能启动：回合被其它执行抢占/, // task-retry-turn（「重跑上一回合」这种标签起头）
  /^[^：:\n]{1,20}启动失败：[\s\S]*；可以再试一次。$/, // task-retry-turn
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
  /^哨兵「[\s\S]*」存着一条这一版读不出来的结束条件「/, // monitors
  /^(⚠️ 用户在无法核验|🔁 用户安全撤销了本次移回|🔁 对端确认未收到任务并登记撤销后)/, // handoff-routes
];

/** 结算说明里要你知道的那几句（server/src/settle-status.ts 的落位说明）。 */
const SETTLEMENT_LEADS: readonly RegExp[] = [
  /^本回合没有交卷/, // 没调 complete_task，记未完成
  /^本回合被 ash 主动终止/, // 熔断
  /^本回合是上次 ash 中断时留下的/, // 读不出熔断判决
  /^后台工作流\/子代理.*按未完成结算/, // 后台活没跑完
  /^ash 重启接管时读不出这个进程之前的输出/,
  /^持续目标已停止，尚未收到完成确认/,
  /^续聊回合(因上游连不上|是上次中断留下的|等后台工作|的后台工作|异常结束)/, // 续聊这一轮没办成（你自己停的、以提问结束的是回执）
  /^持续目标已(暂停|清除)；/, // 你那条 /goal pause、/goal clear 的结果：怎么续跑写在里面
  ...ALERT_LEADS,
];

/** 回执里最常引别人原话的那几种：不管后面引了什么，一律是回执。 */
const RECEIPT_LEADS: readonly RegExp[] = [
  /^哨兵(已起|结束)[：:]/, // monitors：描述和命令原样跟在后面
];

function head(raw: string): string {
  return raw.replace(/^〔系统〕/, "").trimStart();
}

/** 没有类型的时间线记录：是不是服务端当时会标成 `alertLine` 的那一句。 */
export function legacyAlert(raw: string): boolean {
  const text = head(raw);
  return !RECEIPT_LEADS.some((lead) => lead.test(text)) && ALERT_LEADS.some((lead) => lead.test(text));
}

/** 结算说明（`level:"notice"`）：是不是要你知道的那一句。其余是回执。 */
export function settlementAlert(raw: string): boolean {
  const text = head(raw);
  return !RECEIPT_LEADS.some((lead) => lead.test(text)) && SETTLEMENT_LEADS.some((lead) => lead.test(text));
}
