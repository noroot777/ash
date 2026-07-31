import { useEffect, useState } from "react";
import { StatusIcon } from "./StatusIcon";
import { Kbd, submitShortcutTitle } from "./ui";

// paused 任务的「续跑指令」面板。普通任务可编辑/清空；调度者派出的执行者只读。
export function TaskResumePromptEditor({
  value,
  onSave,
  readOnly = false,
}: {
  value: string;
  onSave: (rp: string) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    onSave(draft.trim());
    setEditing(false);
  };

  if (editing && !readOnly) {
    return (
      <div className="mt-2 overflow-hidden rounded-md border border-slate-500/40 bg-slate-500/[0.06]">
        <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-600">
          <StatusIcon status="paused" size={11} />
          <span>编辑续跑指令</span>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
              setDraft(value);
            }
          }}
          rows={4}
          autoFocus
          placeholder="续跑时发送给 agent 的 user 消息，比如：「继续做 tts 这一段」"
          className="block w-full resize-y bg-transparent px-2.5 py-1.5 text-[12px] leading-snug text-ink outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-end gap-1.5 border-t border-slate-500/20 px-2 py-1.5">
          <button
            onClick={() => {
              setEditing(false);
              setDraft(value);
            }}
            className="rounded-md px-2 py-1 text-[11px] text-muted hover:text-ink"
          >
            取消
          </button>
          <button
            onClick={commit}
            title={submitShortcutTitle("保存续跑指令")}
            className="inline-flex items-center gap-1.5 rounded-md bg-slate-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-slate-500"
          >
            保存 <Kbd className="border-white/20 bg-white/10" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/rp mt-2 overflow-hidden rounded-md border border-slate-500/40 bg-slate-500/[0.06]">
      <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-600">
        <StatusIcon status="paused" size={11} />
        <span>{value ? "已到检查点 · 续跑时将发送：" : "已到检查点 · 无续跑指令（续跑用标准「继续」nudge）"}</span>
        {!readOnly && (
          <button
            onClick={() => setEditing(true)}
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate-600 opacity-0 hover:bg-slate-500/15 group-hover/rp:opacity-100"
            title={value ? "编辑续跑指令" : "添加续跑指令"}
          >
            {value ? "编辑" : "+ 添加"}
          </button>
        )}
        {!readOnly && value && (
          <button
            onClick={() => onSave("")}
            className="rounded px-1.5 py-0.5 text-[10px] text-slate-600/80 opacity-0 hover:bg-slate-500/15 hover:text-slate-600 group-hover/rp:opacity-100"
            title="清空：续跑时改用标准「继续」nudge"
          >
            清空
          </button>
        )}
      </div>
      {value && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-2.5 pb-2 text-[12px] leading-snug text-ink">{value}</pre>
      )}
    </div>
  );
}
