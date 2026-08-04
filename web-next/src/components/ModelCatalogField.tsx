import { useMemo } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { useAgentModelCatalog, useProviders, type ModelGroup } from "../lib/modelCatalog.ts";

/**
 * 「选模型」的两个通用控件：把 lib/modelCatalog.ts 的分块目录接到表单里，于是
 * 供应商页面那个「每次调 API / 固定模型」开关能一次管住所有选模型的地方。
 *
 * - ModelCatalogField：输入框 + datalist，允许手填目录之外的模型（新建/派生面板）。
 * - ModelCatalogSelect：下拉框 + 按供应商分组的 optgroup（存量任务的信息面板）。
 *
 * 两者都只改「模型」这一项，不动执行器 —— 需要「连执行器一起选」的两步交互见
 * task-detail/AgentModelPicker.tsx。
 */

/** 目录还没就绪时给一句可见提示；就绪了就不占地方。 */
function catalogNote(groups: ModelGroup[]): string | null {
  if (groups.some((group) => group.status === "loading")) return "正在读取模型目录…";
  const failed = groups.filter((group) => group.status === "failed");
  if (failed.length) return `${failed.map((group) => group.providerName).join("、")} 的模型目录读取失败，可手填`;
  return null;
}

/** 同名模型在多家供应商都有时合并成一行，副标题列出这几家。 */
function labelledModels(groups: ModelGroup[]): { model: string; hint: string }[] {
  const hints = new Map<string, string[]>();
  for (const group of groups) {
    for (const model of group.models) {
      const names = hints.get(model);
      if (!names) hints.set(model, [group.providerName]);
      else if (!names.includes(group.providerName)) names.push(group.providerName);
    }
  }
  return [...hints].map(([model, names]) => ({ model, hint: names.join(" · ") }));
}

export function ModelCatalogField({
  listId,
  label,
  value,
  type,
  profiles,
  disabled = false,
  onChange,
}: {
  listId: string;
  label: string;
  value: string;
  type: AgentType;
  profiles: AgentExecutorProfile[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const providers = useProviders();
  const groups = useAgentModelCatalog(type, profiles, providers);
  const options = useMemo(() => labelledModels(groups), [groups]);
  const note = catalogNote(groups);
  return (
    <label className="composer-field">
      <span>{label}</span>
      <input
        value={value}
        list={listId}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="跟随执行器"
      />
      <datalist id={listId}>
        {options.map((option) => <option value={option.model} label={option.hint} key={option.model} />)}
      </datalist>
      {note && <small>{note}</small>}
    </label>
  );
}

export function ModelCatalogSelect({
  value,
  type,
  profiles,
  disabled = false,
  onChange,
}: {
  value: string;
  type: AgentType;
  profiles: AgentExecutorProfile[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const providers = useProviders();
  const groups = useAgentModelCatalog(type, profiles, providers);
  const note = catalogNote(groups);
  // 当前设置的模型可能不在任何一块里（供应商改过、或是早先手填的）：单独列一块，
  // 否则下拉会显示成空白,看起来像「没设过模型」。
  const orphan = value && !groups.some((group) => group.models.includes(value)) ? value : null;
  return (
    <>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">跟随执行器</option>
        {orphan && <optgroup label="当前设置"><option value={orphan}>{orphan}</option></optgroup>}
        {groups.map((group) => (
          group.models.length ? (
            <optgroup label={group.providerName} key={group.key}>
              {group.models.map((model) => <option value={model} key={model}>{model}</option>)}
            </optgroup>
          ) : null
        ))}
      </select>
      {note && <p className="task-inspector-note">{note}</p>}
    </>
  );
}
