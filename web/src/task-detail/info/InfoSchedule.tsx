// 「信息」格里的调度：平时只是一行「调度 不定时」；选了一次性或循环 Cron，底下多一行填时间，
// 改过了才出「保存」。读写、校验、立即触发和任务页别处那颗表单是同一份（useScheduleDraft）。
import { Lightning } from "@phosphor-icons/react";
import { Dropdown } from "../../components/Dropdown.tsx";
import { ScheduleFields, scheduleSummary, useScheduleDraft, type ScheduleDraftKind } from "../../components/ScheduleControl.tsx";
import { InspButton, InspRow } from "../../inspector/parts.tsx";

const KIND_OPTIONS = [
  { value: "none", label: "不定时" },
  { value: "once", label: "一次性" },
  { value: "cron", label: "循环 Cron" },
];

export function InfoSchedule({ taskId, notify, disabled }: { taskId: string; notify: (message: string) => void; disabled: boolean }) {
  const draft = useScheduleDraft(taskId, notify);
  const { schedule, kind, at, cron, loading, saving, firing, loadError, dirty } = draft;
  const unavailable = disabled || loading || saving || firing;
  // 存着的定时有话要说（几点跑、停用了、上次几点跑的）才写一行灰字；「未设置」不必再说一遍。
  const summary = loadError || (schedule ? scheduleSummary(schedule) : "");
  return (
    <>
      <InspRow label="调度">
        <Dropdown
          className="insp-dropdown"
          label="调度"
          value={kind}
          options={KIND_OPTIONS}
          disabled={unavailable}
          filterable={false}
          onChange={(value) => draft.changeKind(value as ScheduleDraftKind)}
        />
      </InspRow>
      {(kind !== "none" || dirty || !!summary) && (
        <InspRow wide>
          {kind !== "none" && (
            <ScheduleFields kind={kind} at={at} cron={cron} disabled={unavailable} onAtChange={draft.setAt} onCronChange={draft.setCron} />
          )}
          {(summary || dirty || kind === "cron") && (
            <div className="insp-inline-acts">
              {summary && <span className={`insp-cut${loadError ? " insp-bad" : " insp-faint"}`}>{summary}</span>}
              {kind === "cron" && (
                <InspButton variant="quiet" size="sm" disabled={unavailable} onClick={() => void draft.fire()}>
                  <Lightning weight="fill" aria-hidden="true" />{firing ? "触发中…" : "立即触发"}
                </InspButton>
              )}
              {dirty && (
                <InspButton variant="pri" size="sm" disabled={unavailable} onClick={() => void draft.save()}>
                  {saving ? "保存中…" : kind === "none" ? "清除定时" : schedule?.enabled === false ? "重新启用" : "保存"}
                </InspButton>
              )}
            </div>
          )}
        </InspRow>
      )}
    </>
  );
}
