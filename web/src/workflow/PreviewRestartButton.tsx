// 「打开预览」那一站底下的一颗按钮：**重启预览**。
//
// 为什么非得有一颗手动的（哪条洼地让预览有去无回）写在 `server/src/workflow-steps.ts`
// 的 `restartTaskPreview` 上，这里只交代界面上的两条口径：
//
// ① **等它真起来才算数**。请求可能挂两分钟（预览的就绪超时），按钮全程转着，绝不提前
//    报一句「已开始」——起没起来正是按这颗按钮唯一想知道的事，提前返回等于让用户点开
//    一个打不开的地址才发现。
// ② **任务在跑时灰掉**。那一刻代码改到一半，起出来的页面既不是上一版也不是下一版；
//    何况下一次状态切换会立刻把它收掉（`stopPreviewOnRerun`），按了也白按。
import { useState } from "react";
import type { Task } from "@ash/shared";
import type { WorkflowStep } from "@ash/shared/workflow";
import { ArrowClockwise, SpinnerGap } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";

export function PreviewRestartButton({
  task,
  step,
  notify,
}: {
  task: Task;
  step: Extract<WorkflowStep, { kind: "preview" }>;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const inFlight = task.status === "running" || task.status === "queued";
  // 接力出去的任务在本机只是历史存档,重启预览会往它的工作区里跑启动命令,后端已 409。
  const handedOff = task.handoff?.direction === "out";

  const restart = async () => {
    setBusy(true);
    try {
      const result = await api.restartPreview(task.id, step.id);
      notify(result.url ? `预览已起：${result.url}` : `预览已起（端口 ${result.port ?? "未知"}）`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="wf-vactions">
        <button type="button" disabled={inFlight || busy || handedOff} onClick={() => void restart()}>
          {busy ? <SpinnerGap size={13} className="is-spinning" /> : <ArrowClockwise size={13} />}
          <span>{busy ? "启动中" : "重启预览"}</span>
        </button>
      </div>
      <p className="wf-vnote">
        {handedOff
          ? "任务已接力到别的机器，本机这份是历史存档，不再起预览。"
          : inFlight
            ? "任务正在跑，跑完再重启——这会儿代码改到一半，起出来的页面谁也代表不了。"
            : busy
              ? "正在跑这一站的命令，等它打印出地址；起不来的话最多两分钟后报错。"
              : "按原样再跑一次这一站，地址照常写进时间线（端口每次现借，跟上次不一样）。"}
      </p>
    </>
  );
}
