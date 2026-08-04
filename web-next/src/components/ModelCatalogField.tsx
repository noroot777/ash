import { useMemo } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { useAgentModelCatalog, useProviders, type ModelGroup } from "../lib/modelCatalog.ts";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";

/**
 * 「选模型」的两个通用控件：把 lib/modelCatalog.ts 的分块目录接到表单里，于是
 * 供应商页面那个「每次调 API / 固定模型」开关能一次管住所有选模型的地方。
 *
 * - ModelCatalogField：带标题的表单项，允许手填目录之外的模型（新建/派生面板）。
 * - ModelCatalogSelect：光秃秃一个下拉（存量任务的信息面板）。
 *
 * 两者都用同一个 Dropdown（候选按供应商分块、可输入筛选），只在外层包装上不同；
 * 需要「连执行器一起选」的两步交互见 task-detail/AgentModelPicker.tsx。
 */

/** 目录还没就绪时给一句可见提示；就绪了就不占地方。 */
function catalogNote(groups: ModelGroup[]): string | null {
  if (groups.some((group) => group.status === "loading")) return "正在读取模型目录…";
  const failed = groups.filter((group) => group.status === "failed");
  if (failed.length) return `${failed.map((group) => group.providerName).join("、")} 的模型目录读取失败，可手填`;
  return null;
}

/** 候选按供应商分块；同名模型在多家都有时各留一行，块标题指明是哪家。 */
function catalogOptions(groups: ModelGroup[], value: string): DropdownOption[] {
  const rows: DropdownOption[] = [{ value: "", label: "跟随执行器" }];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const model of group.models) {
      rows.push({ value: model, label: model, group: group.providerName, mono: true });
      seen.add(model);
    }
  }
  // 当前模型可能不在任何一块里（供应商改过、或早先手填过）：单独列一块，否则下拉
  // 显示成空白，看起来像「没设过模型」。
  if (value && !seen.has(value)) {
    rows.splice(1, 0, { value, label: value, group: "当前设置", mono: true });
  }
  return rows;
}

function statusOf(groups: ModelGroup[]): "loading" | "failed" | "ready" {
  if (groups.some((group) => group.status === "loading")) return "loading";
  if (groups.some((group) => group.status === "failed")) return "failed";
  return "ready";
}

export function ModelCatalogField({
  label,
  value,
  type,
  profiles,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  type: AgentType;
  profiles: AgentExecutorProfile[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const providers = useProviders();
  const groups = useAgentModelCatalog(type, profiles, providers);
  const options = useMemo(() => catalogOptions(groups, value), [groups, value]);
  const note = catalogNote(groups);
  return (
    <div className="composer-field">
      <span>{label}</span>
      <Dropdown
        label={label}
        value={value}
        options={options}
        disabled={disabled}
        status={statusOf(groups)}
        note={note ?? ""}
        allowCustom
        mono
        placeholder="跟随执行器"
        filterPlaceholder="筛选或直接填写模型名"
        emptyText="没有匹配的模型，输入完整模型名即可直接使用"
        onChange={onChange}
      />
      {note && <small>{note}</small>}
    </div>
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
  const options = useMemo(() => catalogOptions(groups, value), [groups, value]);
  const note = catalogNote(groups);
  return (
    <>
      <Dropdown
        label="模型"
        value={value}
        options={options}
        disabled={disabled}
        status={statusOf(groups)}
        note={note ?? ""}
        allowCustom
        mono
        placeholder="跟随执行器"
        filterPlaceholder="筛选或直接填写模型名"
        emptyText="没有匹配的模型，输入完整模型名即可直接使用"
        onChange={onChange}
      />
      {note && <p className="task-inspector-note">{note}</p>}
    </>
  );
}
