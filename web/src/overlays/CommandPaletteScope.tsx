import type { MouseEvent as ReactMouseEvent } from "react";
import type { ProjectView } from "@ash/shared";
import { Check, X } from "@phosphor-icons/react";

export type SearchScopeType = "tasks" | "notes" | null;

export type SearchScope = {
  projectId: string | null;
  type: SearchScopeType;
};

export const SCOPE_TYPE_OPTIONS: { value: SearchScopeType; label: string; description: string }[] = [
  { value: null, label: "不限类型", description: "同时搜索任务和随手记" },
  { value: "tasks", label: "任务", description: "任务标题、正文与会话记录" },
  { value: "notes", label: "随手记", description: "只搜索随手记正文" },
];

function scopeProjectName(scope: SearchScope, projects: ProjectView[]): string {
  if (!scope.projectId) return "不限项目";
  return projects.find((project) => project.id === scope.projectId)?.name ?? "未知项目";
}

function scopeTypeName(type: SearchScopeType): string {
  return SCOPE_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? "不限类型";
}

export function ScopeToken({
  scope,
  projects,
  onEdit,
  onRemove,
}: {
  scope: SearchScope;
  projects: ProjectView[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center overflow-hidden rounded-md border border-accent/25 bg-accent/10 text-[11px] text-accent">
      <button type="button" className="px-2 py-1 font-medium outline-none hover:bg-accent/10 focus-visible:bg-accent/15" onClick={onEdit}>
        {scopeProjectName(scope, projects)} <span className="mx-0.5 opacity-50">/</span> {scopeTypeName(scope.type)}
      </button>
      <button
        type="button"
        aria-label="清除搜索范围"
        className="self-stretch border-l border-accent/20 px-1.5 outline-none hover:bg-accent/15 focus-visible:bg-accent/20"
        onClick={onRemove}
      >
        <X size={10} weight="bold" />
      </button>
    </span>
  );
}

function ChoiceRow({
  active,
  selected,
  label,
  description,
  onChoose,
  onHover,
}: {
  active: boolean;
  selected: boolean;
  label: string;
  description: string;
  onChoose: () => void;
  onHover: (event: ReactMouseEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-selected={active}
      onMouseMove={onHover}
      onClick={onChoose}
      className="ui-selectable flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none"
    >
      <span className={`grid size-5 shrink-0 place-items-center rounded-full border ${selected ? "border-accent bg-accent text-white" : "border-line2"}`}>
        {selected && <Check size={11} weight="bold" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm text-ink">{label}</span>
        <span className="mt-0.5 block truncate text-[11px] text-faint">{description}</span>
      </span>
    </button>
  );
}

export function ScopeProjectStep({
  projects,
  active,
  selectedProjectId,
  onChoose,
  onHover,
}: {
  projects: ProjectView[];
  active: number;
  selectedProjectId: string | null;
  onChoose: (projectId: string | null) => void;
  onHover: (index: number, event: ReactMouseEvent) => void;
}) {
  const choices = [{ id: null, name: "不限项目", repoPath: "搜索所有项目" }, ...projects];
  return (
    <div className="p-1">
      <div className="palette-label">选择项目 · 1 / 2</div>
      {choices.map((project, index) => (
        <ChoiceRow
          key={project.id ?? "all"}
          active={index === active}
          selected={project.id === selectedProjectId}
          label={project.name}
          description={project.repoPath}
          onChoose={() => onChoose(project.id)}
          onHover={(event) => onHover(index, event)}
        />
      ))}
    </div>
  );
}

export function ScopeTypeStep({
  active,
  selectedType,
  onChoose,
  onHover,
}: {
  active: number;
  selectedType: SearchScopeType;
  onChoose: (type: SearchScopeType) => void;
  onHover: (index: number, event: ReactMouseEvent) => void;
}) {
  return (
    <div className="p-1">
      <div className="palette-label">选择类型 · 2 / 2</div>
      {SCOPE_TYPE_OPTIONS.map((option, index) => (
        <ChoiceRow
          key={option.value ?? "all"}
          active={index === active}
          selected={option.value === selectedType}
          label={option.label}
          description={option.description}
          onChoose={() => onChoose(option.value)}
          onHover={(event) => onHover(index, event)}
        />
      ))}
    </div>
  );
}
