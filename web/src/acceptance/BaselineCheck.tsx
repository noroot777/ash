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
 * accept-gate-conflict.ts）。交过之后这一行照服务端报回的**投递结局**说：排着、正在解决、没送到、
 * 那一轮结束了冲突还在 —— 只有「排着 / 正在解决」收起按钮，另外两档照样给「再交一次」。任务一提交，
 * 分支头变了，服务端那份登记就不再对得上，这一行自然回到重新判一次的结果。
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
  const handoff = issue.reason === "merge_conflict" ? issue.handoff : null;
  if (handoff?.state === "queued" || handoff?.state === "working") {
    return <CheckRow check="baseline" tone="live" text={handoff.state === "queued" ? "已交给任务，等它接手" : "任务正在解决冲突"}
      state={<code>{issue.targetBranch}</code>} detail={files} />;
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
        state={handoff?.state === "failed" ? "没交出去"
          : handoff?.state === "ended" ? "任务那一轮没解掉"
          : issue.conflictFiles.length ? `${issue.conflictFiles.length} 个文件` : null}
        detail={handoff?.state === "failed" && handoff.note
          ? <>{files}<p className="acc-check-more">{handoff.note}</p></> : files}
        tools={<CheckAction disabled={disabled} busy={busy} onClick={() => void handOff()}>{handoff ? "再交一次" : "让任务解决"}</CheckAction>} />
    );
  }
  return (
    <CheckRow check="baseline" tone="block"
      text={issue.reason === "accept_gate_target_behind"
        ? <>还没含有最新的 <code>{issue.targetBranch}</code></>
        : <>和 <code>{issue.targetBranch}</code> 的合并预览做不出来</>} />
  );
}
