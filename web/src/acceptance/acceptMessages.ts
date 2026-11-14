import { acceptanceAutoCommitMessage } from "@ash/shared/accept-workspace";
import type { AcceptTaskFailure, AcceptTaskSuccess } from "../lib/apiTypes.ts";

/**
 * 验收按下去之后那一句提示。合并成了、但「点头之后」那一段挂了，是两件事得分开说；「不提交」那一档
 * 必须在提示里就说破，否则用户看见「验收通过」就以为合完了，改动其实还躺在工作区里没提交。
 */
export function acceptMessage(result: AcceptTaskSuccess): string {
  const head = result.kind === "gate_released"
    // 放行之后线没能走过去，服务端带回 tail.ok=false：照实说停住了，别说「继续往下走」。
    ? result.tail && !result.tail.ok
      ? result.tail.movedOn
        ? `已放行，但下一站「${result.tail.step ?? "验证"}」没开起来，线停在那一站，详情见任务时间线`
        : `已放行，但线没能接着往下走${result.tail.step ? `：「${result.tail.step}」没跑过` : ""}，停在这一道上，详情见任务时间线`
      : "已放行，这条线继续往下走"
    : result.tail && !result.tail.ok
      ? `已合并，但「${result.tail.step ?? "点头之后那一段"}」没跑过，详情见任务时间线`
      : result.merge === "no_commit"
        ? "验收通过：改动已合进目标分支工作区并暂存，还没提交"
        : result.warnings?.length ? `验收通过，但有 ${result.warnings.length} 条清理警告` : "验收通过";
  return head + (result.autoCommit ? `；${acceptanceAutoCommitMessage(result.autoCommit)}` : "");
}

/** 前置命令那几种「没合并」各说一句。 */
export function gateNotice(result: AcceptTaskFailure): string {
  if (result.reason === "accept_gate_running") return "验收前置命令已开跑；绿了这次验收会自动做完，不用再点";
  if (result.reason === "accept_gate_failed") return "验收前置命令没通过，没有合并";
  return result.error;
}
