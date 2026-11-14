import { useState } from "react";
import type { TaskListItem } from "@ash/shared";
import type { AcceptGateState } from "@ash/shared/accept-gate";
import { api } from "../lib/api.ts";
import { CheckAction, CheckRow, FileList } from "./CheckRow.tsx";

/**
 * 前置命令的基准挡在门禁之前的那一行：合并预览撞冲突、任务分支还没含最新的目标分支、预览做不出来。
 * 都是红的，但**不禁用主按钮**：确认层里取消「运行」（这次跳过）本来就不判基准，服务端也是这个口径。
 *
 * 冲突那一档有直达的出路「让任务解决」：和点验收被拦下时交出去的是同一份（服务端
 * accept-gate-conflict.ts）。交过之后这一行换成「任务正在解决冲突」；任务一提交，分支头变了，
 * 服务端那份登记就不再对得上，这一行自然回到重新判一次的结果。
 */
export function BaselineCheck({ task, issue, disabled, reload, notify }: {
  task: TaskListItem;
  issue: NonNullable<AcceptGateState["baselineIssue"]>;
  disabled: boolean;
  reload: () => Promise<unknown>;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const files = issue.conflictFiles.length ? <FileList files={issue.conflictFiles} /> : undefined;
  if (issue.reason === "merge_conflict" && issue.handedOffAt) {
    return <CheckRow check="baseline" tone="live" text="任务正在解决冲突" state={<code>{issue.targetBranch}</code>} detail={files} />;
  }
  if (issue.reason === "merge_conflict") {
    const handOff = async () => {
      if (busy) return;
      setBusy(true);
      try {
        await api.handOffGateConflict(task.id);
        await reload();
      } catch (reason) {
        notify(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    };
    return (
      <CheckRow check="baseline" tone="block" text={<>与 <code>{issue.targetBranch}</code> 冲突</>}
        state={issue.conflictFiles.length ? `${issue.conflictFiles.length} 个文件` : null} detail={files}
        tools={<CheckAction disabled={disabled} busy={busy} onClick={() => void handOff()}>让任务解决</CheckAction>} />
    );
  }
  return (
    <CheckRow check="baseline" tone="block"
      text={issue.reason === "accept_gate_target_behind"
        ? <>还没含有最新的 <code>{issue.targetBranch}</code></>
        : <>和 <code>{issue.targetBranch}</code> 的合并预览做不出来</>} />
  );
}
