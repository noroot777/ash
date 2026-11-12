import type { ReactNode } from "react";
import {
  ScheduleFields,
  type ScheduleKind,
} from "../components/ScheduleControl.tsx";
import { SendKey, type SendKeyGlyph } from "../components/SendKey.tsx";
import { useRovingChoice } from "../lib/useRovingChoice.ts";

// "queue" = 创建并排队:建完入队不起跑,等所选目标任务跑完由队列自动拉起。
// 目标选择器由面板经 queueSlot 递进来(候选要任务列表,这个纯展示组件不该自己去取)。
export type LaunchMode = "create" | "run" | "queue" | ScheduleKind;

// 档位、名字、键上的字（空 = 只画箭头）、尖角的图标、一句说明。
const LAUNCH_OPTIONS: { value: LaunchMode; label: string; text: string; glyph: SendKeyGlyph; say: string }[] = [
  { value: "run", label: "创建并运行", text: "", glyph: "caret", say: "创建后立即开始执行" },
  { value: "queue", label: "创建并排队", text: "创建并排队", glyph: "sand", say: "入队不起跑，轮到它时自动开始" },
  { value: "create", label: "仅创建", text: "创建任务", glyph: "caret", say: "先放入待办，需要时再运行" },
  { value: "once", label: "一次性定时", text: "创建并定时", glyph: "clock", say: "在指定的时间运行一次" },
  { value: "cron", label: "循环 Cron", text: "创建并定时", glyph: "clock", say: "按 Cron 表达式循环运行" },
];
const LAUNCH_MODES = LAUNCH_OPTIONS.map((option) => option.value);

/**
 * 新建任务的发送键：一颗共用发送键（components/SendKey.tsx），尖角点开是「启动设置」五档。
 * 默认那一档只画箭头，「创建并运行」和它的快捷键在悬停提示里；选了别的档键上才写字。
 * `blocked` 是此刻发不出去的原因（面板算好，提交函数里还会再判一次）。
 */
export function ComposerLaunchControl({
  mode,
  at,
  cron,
  busy,
  blocked,
  uploading,
  error,
  onModeChange,
  onAtChange,
  onCronChange,
  onSubmit,
  queueSlot,
  queueUnavailable,
}: {
  mode: LaunchMode;
  at: string;
  cron: string;
  busy: boolean;
  blocked: string | null;
  /** 正在传附件时键上写的进度（「上传中 37%」）。 */
  uploading?: string | null;
  /** 这一档自己没配好（定时没填、排队没选目标）的那一句，浮层底部也写着。 */
  error?: string | null;
  onModeChange: (mode: LaunchMode) => void;
  onAtChange: (value: string) => void;
  onCronChange: (value: string) => void;
  onSubmit: () => void;
  /** mode="queue" 时的目标任务选择器(由面板构造,这里只负责摆进浮层)。 */
  queueSlot?: ReactNode;
  /** 非空 = 当前任务模式不支持排队(如团队任务),选项置灰并附上原因。 */
  queueUnavailable?: string | null;
}) {
  const launchGroup = useRovingChoice(LAUNCH_MODES, mode, onModeChange);
  const current = LAUNCH_OPTIONS.find((option) => option.value === mode) ?? LAUNCH_OPTIONS[0]!;
  return (
    <SendKey
      size="md"
      action="创建并运行"
      text={uploading || current.text}
      tip={current.text ? current.say : null}
      blocked={blocked}
      busy={busy}
      onSend={onSubmit}
      settings={{
        label: "启动设置",
        value: current.label,
        glyph: uploading ? "sand" : current.glyph,
        disabled: busy,
        children: <>
          <div className="send-key-choices" {...launchGroup.groupProps} aria-label="启动方式">
            {LAUNCH_OPTIONS.map((option) => {
              const unavailable = option.value === "queue" ? queueUnavailable : null;
              return (
                <button key={option.value} type="button" {...launchGroup.itemProps(option.value)}
                  disabled={busy || !!unavailable}
                  aria-label={unavailable ? `${option.label}（${unavailable}）` : option.label}
                  onClick={() => onModeChange(option.value)}>
                  <span>{option.label}</span><em>{unavailable ?? option.say}</em>
                </button>
              );
            })}
          </div>
          <div className="send-key-body">
            {mode === "queue" && queueSlot}
            {(mode === "once" || mode === "cron") && (
              <ScheduleFields kind={mode} at={at} cron={cron} disabled={busy} onAtChange={onAtChange} onCronChange={onCronChange} />
            )}
            {error && <p className="is-error" role="status">{error}</p>}
          </div>
        </>,
      }}
    />
  );
}
