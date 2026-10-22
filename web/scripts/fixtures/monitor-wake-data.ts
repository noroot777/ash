import { appendMonitorWake, type MonitorWakeData, type MonitorWakeEvent } from "@ash/shared/monitor-wake";

export const outputEvent: MonitorWakeEvent = {
  kind: "output", source: "全量回归（补完第六处闸之后）", monitorId: "monitor-new",
  body: "Ran 3471 tests in 719.547s\nOK (skipped=1)\nSWEEP_EXIT=0\n全文在 /tmp/kb-sweep5.log",
};
export const endEvent: MonitorWakeEvent = {
  kind: "ended", source: "全量回归（清静机器上的提交前那一遍）", monitorId: "monitor-old",
  body: "退出码 0。命令自己跑完了",
};

export function wakePayload(events: MonitorWakeEvent[], checkpoint?: string) {
  const text = events.map((event) => `【哨兵${event.kind === "output" ? "事件" : "结束"}】${event.source}（monitorId=${event.monitorId}）${event.kind === "output" ? "\n" : "，"}${event.body}`).join("\n\n")
    + (checkpoint ? `\n\n【你当初留下的续跑交代】${checkpoint}` : "");
  const data = events.reduce<MonitorWakeData | null>((previous, event) => appendMonitorWake(previous, event), null)!;
  return { text, monitorWake: { ...data, ...(checkpoint ? { checkpoint } : {}) } };
}
