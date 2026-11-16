import type { AcceptTaskFailure } from "../lib/api.ts";
import { CheckRow, FileList } from "./CheckRow.tsx";

/**
 * 「点了验收但没做完」那一行（这一次按下去的回执，不进持久状态 —— 刷新后看到的是任务和门禁的
 * 真实状态本身）。冲突文件和挡路文件只在展开时列出来。
 *
 * 前置命令没过不在这里说：门禁那一行就是它（读不出门禁状态时才由这一行兜着）。
 */
export function FailureCheck({ failure, gateReadable }: { failure: AcceptTaskFailure; gateReadable: boolean }) {
  if (failure.reason.startsWith("accept_gate") && (failure.reason !== "accept_gate_failed" || gateReadable)) return null;
  const handedOff = failure.reason === "merge_conflict" && failure.conflictHandoff?.notified === true;
  const conflict = failure.reason === "merge_conflict";
  const [tone, text] = handedOff ? ["live", "合并冲突已交给任务处理"] as const
    : conflict ? ["block", "合并冲突，没能交给任务"] as const
      : failure.completedMerge ? ["warn", "合并已完成，清理没做完"] as const
        : failure.completedTag ? ["warn", "标签已打，清理没做完"] as const
          : failure.reason === "accept_gate_failed" ? ["failed", "前置命令没通过，没有合并"] as const
            : ["block", "验收没完成"] as const;
  const message = handedOff ? failure.conflictHandoff?.message : failure.error;
  return (
    <CheckRow
      check="failure"
      tone={tone}
      text={text}
      state={handedOff ? "它提交后再验收" : conflict ? "解决并提交后再验收" : null}
      detail={(
        <div className="acc-detail-text">
          {message && <p>{message}</p>}
          {!handedOff && failure.conflictHandoff?.message && <p>{failure.conflictHandoff.message}</p>}
          {failure.conflictFiles?.length ? <><h4>冲突文件</h4><FileList files={failure.conflictFiles} /></> : null}
          {failure.dirtyFiles?.length ? <><h4>挡路的文件</h4><FileList files={failure.dirtyFiles} /></> : null}
        </div>
      )}
    />
  );
}
