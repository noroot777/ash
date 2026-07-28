import { ArrowsClockwise, CaretDown, Clock, Plus } from "@phosphor-icons/react";
import { Kbd, submitShortcutTitle } from "../ui";
import { Menu } from "../Menu";
import { ScheduleFields } from "../ScheduleFields";
import { LAUNCH_MODES, type LaunchMode } from "./modes";

// 面板底部的固定操作条：定时字段（只在 once/cron 两档出现）+「再建一个」+ 主按钮
// 和启动时机下拉。内容跟正文一样限宽居中，这样按钮不会被甩到宽屏的最右边。
export function ComposerFooter({
  debateOn,
  launchMode,
  at,
  cron,
  more,
  canSubmit,
  submitLabel,
  onAt,
  onCron,
  onLaunchMode,
  onMore,
  onSubmit,
  width,
}: {
  debateOn: boolean;
  launchMode: LaunchMode;
  at: string;
  cron: string;
  more: boolean;
  canSubmit: boolean;
  submitLabel: string;
  onAt: (v: string) => void;
  onCron: (v: string) => void;
  onLaunchMode: (m: LaunchMode) => void;
  onMore: () => void;
  onSubmit: () => void;
  width: string;
}) {
  const timed = !debateOn && (launchMode === "once" || launchMode === "cron");
  return (
    <div className="shrink-0 border-t border-line bg-panel">
      {timed && (
        <div className={`${width} mx-auto flex flex-wrap items-center gap-2 px-6 pt-2.5 text-[12px]`}>
          <span className="inline-flex items-center gap-1.5 text-faint">
            {launchMode === "once" ? <Clock size={13} /> : <ArrowsClockwise size={13} />}
            {launchMode === "once" ? "一次性" : "循环"}
          </span>
          <ScheduleFields kind={launchMode} at={at} cron={cron} onAt={onAt} onCron={onCron} />
        </div>
      )}
      <div className={`${width} mx-auto flex items-center gap-3 px-6 py-3`}>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-[12px] text-muted">
          <span>再建一个</span>
          <button
            type="button"
            onClick={onMore}
            className={`relative h-4 w-7 rounded-full transition-colors ${more ? "bg-accent" : "bg-line2"}`}
            aria-pressed={more}
          >
            <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-panel transition-all ${more ? "left-3.5" : "left-0.5"}`} />
          </button>
        </label>
        <div className="inline-flex items-stretch overflow-hidden rounded-md">
          <button
            disabled={!canSubmit}
            onClick={onSubmit}
            title={submitShortcutTitle(submitLabel)}
            className="inline-flex items-center gap-1.5 bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            <Plus size={14} weight="bold" /> {submitLabel} <Kbd />
          </button>
          {!debateOn && (
            <Menu
              value={launchMode}
              onChange={(v) => onLaunchMode(v as LaunchMode)}
              options={LAUNCH_MODES.map((m) => ({ value: m.key, label: m.label, icon: m.icon, detail: m.detail }))}
              align="right"
              menuWidth={232}
              triggerClassName="grid place-items-center border-l border-accent-fg/20 bg-accent px-1.5 text-accent-fg transition-colors hover:bg-accent-hover"
            >
              <CaretDown size={13} weight="bold" />
            </Menu>
          )}
        </div>
      </div>
    </div>
  );
}
