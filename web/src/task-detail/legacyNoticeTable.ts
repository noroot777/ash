// 没有类型的老记录里，哪些是「要你知道 / 确实没办成」的那几句。
//
// 带类型的时间线（shared/src/timeline-notice.ts）只有这条分支以后的服务端才写；在那之前落盘的、
// 以及线上还在跑的老服务端写的，一条类型都没有。它们原先按关键词猜语气——原文里带「失败」
// 「错误」就升成常显的红字，于是「哨兵已起：<描述>（<命令>）」这种回执只因为命令里有个 fail
// 就成了一行红色感叹号。这里改成**按起头认**：照服务端标成 `alertLine(...)` 的那批调用点
// （server/src 里 `alertLine(` 的每一处），把它们写死的起头抄成一张表。表里没有的一律是回执。
//
// 认的是起头（或者那句话里写死、别处不会出现的一截），不认关键词：带进来的描述、命令、报错原文
// 什么词都可能有，不能让它们决定一条记录摆在哪儿。
//
// 另一张是结算说明（服务端带 `level:"notice"` 落的那种，「这一轮为什么落成这个状态」）。它们
// 一律没有类型，按同一个办法认：没交卷、被 ash 判失败的那几句要你知道；其余（等哨兵改落暂停、
// 以提问暂停、你自己停的）界面别处已经在说，是回执。

/** `alertLine(...)` 那批调用点的固定起头（文件名是写它的地方，便于对照）。 */
const ALERT_LEADS: readonly RegExp[] = [
  /^自由工作流审查意见修复已取消/, // free-review-manual-repair
  /^已显式确认风险并强制释放验收前置命令/, // accept-gate-release
  /^合并结果审查临时工作区清理失败/, // free-review-round
  /^已裁定维持审查意见，但这次没能自动发起修复/, // free-review-dispute
  /^旧预览回收暂缓/, // status
  /条目太多放不进指令/, // free-review-prompts
  /^统一验收暂停/, // task-branch-routes
  /^原生目标清除失败/, // task-cli-command
  /^替你提交这次合并没成功/, // task-accept-pending
  /^git commit 跑完了，但/, // task-accept-pending
  /^重新合并未完成/, // task-accept-pending
  /^持续目标因服务中断已暂停/, // task-reconcile
  /^持续目标尚未启动就遇到服务中断/, // task-reconcile
  /本次验收未执行，需明确确认仍要验收/, // task-accept
  /^验收暂缓[：:]/, // task-accept
  /^验收未完成[：:]/, // task-accept / accept-gate
  /^合并清理警告[：:]/, // task-accept
  /稍后可重新验收继续清理/, // task-accept
  /^注意[：:]/, // task-accept / accept-gate
  /^半删除工作区的剩余源码已与任务提交核对/, // task-accept
  /^验收清理未完成[：:]/, // task-accept
  /辩论已中止[；;]/, // free-review-debate
  /存着一条这一版读不出来的结束条件/, // monitors
  /^冲突交接失败/, // accept-conflict
  /派发意图没能存进库里/, // free-review-dispatch
  /^跑了一条命令：.*（没通过）/, // workflow-steps
  /^预览没起来/, // workflow-steps
  /^这条线卡在「[^」]+」这一站，停下等你处理/, // workflow-steps
  /已经打回重做 \d+ 次仍没过/, // workflow-steps
  /^想把这一站打回重做，但唤醒任务时出错/, // workflow-steps
  /^起跑预检提示/, // ash-mcp-launch-gate / ash-mcp-turn-hint
  /^⚠️ 用户在无法核验/, // handoff-routes
  /^强制通过之后想接着往下走，但出错了/, // verify-override
  /^验收前置命令未执行/, // accept-gate
  /^审查预约已取消[：:]/, // free-review-reservations
  /^预约审查启动失败/, // free-review-reservations
  /^完成后审查预约已取消[：:]/, // reviewer-profiles
  /^审查缺少持久保存的真实退出结果/, // regression-settlement
  /^通过结论的依据已失效/, // regression-settlement
  /^验证依据暂不可核验/, // regression-settlement
  /^门禁交接失败/, // accept-gate-handoff
  /^门禁交接：已叫醒该任务/, // accept-gate-handoff
  /^门禁交接：.*看一眼会话里有没有这条修复要求/, // accept-gate-handoff
  /^引导会话未执行/, // task-steer
  /^想自动开一轮验证，但没开起来/, // review
  /^这一轮改了代码，但没有确认完成/, // turn-baseline
  /^这一轮在启动前被撤回/, // turn-freeze
  /^本次启动失败，未能继续执行/, // queue-seat
  /^审查已完成，但后续工作流/, // review-finalization
  /^服务在审查输入交付期间中断/, // review-start-retry
  /^续聊未能启动/, // task-reply
  /^这一轮的审查报告可能已经写完了，只是结论没能上报到 ash/, // review-channel-gap
  /^这一轮没交卷多半不是 agent 漏了/, // review-channel-gap
  /^放行之后想接着往下走，但出错了/, // task-accept-tail
  /^合并已经做完了，卡住的是「点头之后」那一段/, // task-accept-tail
  /^验收前置命令通过了，但当初那一下验收的选择/, // accept-gate-continue
  /^验收前置命令通过后自动继续验收/, // accept-gate-continue
  /^这一轮的续跑交代\*\*可能已经\*\*交给/, // task-checkpoint-delivery
  /^验收在门禁发射前异常退出/, // task-accept-gate-launch
  /^修复执行回合异常结束，自动复审已取消/, // free-workflow
  /未发送，已取消/, // pending-messages
  /^验收前置命令尚未确认整棵进程树退出/, // accept-gate-settle
  /^验收前置命令被打断/, // accept-gate-recover
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

function head(raw: string): string {
  return raw.replace(/^〔系统〕/, "").trimStart();
}

/** 没有类型的时间线记录：是不是服务端当时会标成 `alertLine` 的那一句。 */
export function legacyAlert(raw: string): boolean {
  const text = head(raw);
  return ALERT_LEADS.some((lead) => lead.test(text));
}

/** 结算说明（`level:"notice"`）：是不是要你知道的那一句。其余是回执。 */
export function settlementAlert(raw: string): boolean {
  const text = head(raw);
  return SETTLEMENT_LEADS.some((lead) => lead.test(text));
}
