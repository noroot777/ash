import { useRef, useState, type ReactNode } from "react";
import type { Task, Group, AgentType, Priority, TaskStatus } from "@harness/shared";
import { X, ArrowsOut, ArrowsIn, Robot, Stack, Tag, Plus } from "@phosphor-icons/react";
import { api } from "./api";
import { STATUSES, PRIORITIES } from "./constants";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./ui";
import { useEscape } from "./useEscape";

const AGENTS: AgentType[] = ["claude", "codex", "antigravity"];

// Linear-style "New issue" composer: breadcrumb, large borderless title +
// description, a row of property pills, and a Create-more / Create footer.
export function CreateTask({
  projectId,
  projectName,
  groups,
  onClose,
  onCreated,
}: {
  projectId: string;
  projectName: string;
  groups: Group[];
  onClose: () => void;
  onCreated: (t: Task) => void;
}) {
  useEscape(onClose);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<TaskStatus>("backlog");
  const [priority, setPriority] = useState<Priority>("none");
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const [groupId, setGroupId] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const t = await api.createTask({
        projectId,
        title: title.trim(),
        body,
        mode: "single",
        agentType,
        priority,
        status,
        labels,
        groupId: groupId || null,
      });
      onCreated(t);
      if (more) {
        setTitle("");
        setBody("");
        setLabels([]);
        titleRef.current?.focus();
      } else {
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  const addLabel = () => {
    const l = prompt("标签？")?.trim();
    if (l && !labels.includes(l)) setLabels((ls) => [...ls, l]);
  };

  const groupLabel = groups.find((g) => g.id === groupId)?.name ?? "分组";
  const prioLabel = priority === "none" ? "优先级" : PRIORITIES.find((p) => p.key === priority)!.label;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onClick={onClose}>
      <div
        className={`flex flex-col overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl transition-all ${
          expanded ? "h-[78vh] w-[920px]" : "w-[640px]"
        } max-w-[94vw]`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      >
        {/* Header / breadcrumb */}
        <div className="flex items-center gap-2 px-4 pt-3.5">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-raised px-1.5 py-0.5 text-[12px] font-medium text-ink">
            <span className="grid h-4 w-4 place-items-center rounded bg-accent text-[9px] font-semibold text-accent-fg">
              {projectName.slice(0, 1).toUpperCase()}
            </span>
            {projectName}
          </span>
          <span className="text-faint">›</span>
          <span className="text-[13px] font-medium text-muted">新建任务</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
              title={expanded ? "收起" : "展开"}
            >
              {expanded ? <ArrowsIn size={15} /> : <ArrowsOut size={15} />}
            </button>
            <button
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
              title="关闭 Esc"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Title + description */}
        <div className={`flex min-h-0 flex-col gap-1 px-4 pt-2 ${expanded ? "flex-1" : ""}`}>
          <textarea
            ref={titleRef}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) e.preventDefault();
            }}
            rows={1}
            placeholder="任务标题"
            className="resize-none bg-transparent text-[17px] font-medium leading-snug text-ink outline-none placeholder:text-faint"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="添加描述 / 给 agent 的目标…"
            className={`resize-none bg-transparent text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint ${
              expanded ? "flex-1" : "min-h-[64px]"
            }`}
          />
        </div>

        {/* Property pills */}
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
          <Pill icon={<StatusIcon status={status} size={14} />} label={STATUSES.find((s) => s.key === status)!.label}
            value={status} onChange={(v) => setStatus(v as TaskStatus)}
            options={STATUSES.map((s) => ({ value: s.key, label: s.label }))} />
          <Pill icon={<PriorityIcon p={priority} />} label={prioLabel}
            value={priority} onChange={(v) => setPriority(v as Priority)}
            options={PRIORITIES.map((p) => ({ value: p.key, label: p.label }))} />
          <Pill icon={<Robot size={14} />} label={`@${agentType}`}
            value={agentType} onChange={(v) => setAgentType(v as AgentType)}
            options={AGENTS.map((a) => ({ value: a, label: `@${a}` }))} />
          <Pill icon={<Stack size={14} />} label={groupLabel}
            value={groupId} onChange={(v) => setGroupId(v)}
            options={[{ value: "", label: "无分组" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
          {labels.map((l) => (
            <button key={l} onClick={() => setLabels((ls) => ls.filter((x) => x !== l))}
              className="rounded-full bg-overlay px-2 py-1 text-[12px] text-ink hover:line-through" title="移除">
              {l}
            </button>
          ))}
          <button onClick={addLabel}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[12px] text-ink hover:bg-raised">
            <Tag size={14} /> 标签
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-line px-4 py-2.5">
          <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-[12px] text-muted">
            <span>再建一个</span>
            <button
              type="button"
              onClick={() => setMore((v) => !v)}
              className={`relative h-4 w-7 rounded-full transition-colors ${more ? "bg-accent" : "bg-line2"}`}
              aria-pressed={more}
            >
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-panel transition-all ${more ? "left-3.5" : "left-0.5"}`} />
            </button>
          </label>
          <button
            disabled={!title.trim() || busy}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            <Plus size={14} weight="bold" /> 创建任务
          </button>
        </div>
      </div>
    </div>
  );
}

// Linear-style property pill: rounded-full, leading icon + label, invisible
// native <select> overlay for behavior.
function Pill({
  icon,
  label,
  value,
  onChange,
  options,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="relative inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-raised">
      {icon}
      <span className="whitespace-nowrap">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
