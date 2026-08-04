import { useMemo } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { useAgentModelCatalog, useProviders, type ModelGroup } from "../lib/modelCatalog.ts";
import { effortOptions } from "../lib/executorChoices.ts";
import { Dropdown, type DropdownOption, type DropdownStep } from "./Dropdown.tsx";

/**
 * 「选模型」的两个通用控件：把 lib/modelCatalog.ts 的分块目录接到表单里，于是
 * 供应商页面那个「每次调 API / 固定模型」开关能一次管住所有选模型的地方。
 *
 * - ModelCatalogField：带标题的表单项，允许手填目录之外的模型（新建/派生面板）。
 * - ModelCatalogSelect：光秃秃一个下拉（存量任务的信息面板）。
 *
 * 两者都用同一个 Dropdown（候选按供应商分块、可输入筛选），只在外层包装上不同；
 * 需要「连执行器一起选」的两步交互见 task-detail/AgentModelPicker.tsx。
 *
 * 传了 `effort` 就把思考强度并进同一个下拉的**第二步**：档位是跟着模型走的
 * （gpt-5.5 顶到 xhigh、haiku 根本没有档位），模型还没定就先挑档位只会挑出一个
 * 该模型不支持的值，非法组合要等 CLI 跑起来才被上游拒绝。注意档位表来自
 * shared 的 `REASONING_EFFORT_VALUES`（按 CLI 分档），**供应商的 /v1/models
 * 接口只返回模型 id，拿不到「这个模型支持哪些档位」**。
 */

/**
 * 模型 + 思考强度合成一个控件时用的第二步。
 * `options` 只在需要补候选时传（例：任务上存着的档位已不在当前类型的档位表里）。
 */
export type EffortStep = {
  value: string;
  onChange: (value: string) => void;
  options?: DropdownOption[];
};

/** 目录还没就绪时给一句可见提示；就绪了就不占地方。 */
function catalogNote(groups: ModelGroup[]): string | null {
  if (groups.some((group) => group.status === "loading")) return "正在读取模型目录…";
  const failed = groups.filter((group) => group.status === "failed");
  if (failed.length) return `${failed.map((group) => group.providerName).join("、")} 的模型目录读取失败，可手填`;
  return null;
}

/**
 * 候选按供应商分块；同名模型在多家都有时各留一行，块标题指明是哪家。
 *
 * 「跟随执行器」不占候选行——它不是一个模型，混在模型清单里既拉长列表又容易误点；
 * 回到不覆盖走浮层底部那条「清空」。
 */
function catalogOptions(groups: ModelGroup[], value: string): DropdownOption[] {
  const rows: DropdownOption[] = [];
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
    rows.unshift({ value, label: value, group: "当前设置", mono: true });
  }
  return rows;
}

/** 档位只有一条「跟随」时说明这个 CLI 压根没有档位，就别多摆一步。 */
export function effortStepOf(type: AgentType, effort: EffortStep | undefined): DropdownStep | undefined {
  if (!effort) return undefined;
  const options = effort.options ?? effortOptions(type);
  if (options.length < 2) return undefined;
  return {
    label: "思考强度",
    options,
    value: effort.value,
    onChange: effort.onChange,
    emptyText: "该执行器没有可选档位",
  };
}

/**
 * 把模型目录包成多步下拉里的**一步**，给「执行器 → 模型 → 强度」那种把模型夹在
 * 中间的场景用；单独选模型的两个控件走下面的 ModelCatalogField / ModelCatalogSelect。
 */
export function modelCatalogStep(
  groups: ModelGroup[],
  value: string,
  onChange: (value: string) => void,
): DropdownStep {
  return {
    label: "模型",
    options: catalogOptions(groups, value),
    value,
    onChange,
    filterable: true,
    allowCustom: true,
    mono: true,
    status: statusOf(groups),
    note: catalogNote(groups) ?? "",
    filterPlaceholder: "筛选或直接填写模型名",
    emptyText: "没有匹配的模型，输入完整模型名即可直接使用",
  };
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
  effort,
  onChange,
}: {
  label: string;
  value: string;
  type: AgentType;
  profiles: AgentExecutorProfile[];
  disabled?: boolean;
  /** 传了就在同一个下拉里接着选思考强度，不再另开一栏。 */
  effort?: EffortStep;
  onChange: (value: string) => void;
}) {
  const providers = useProviders();
  const groups = useAgentModelCatalog(type, profiles, providers);
  const options = useMemo(() => catalogOptions(groups, value), [groups, value]);
  const note = catalogNote(groups);
  const step2 = effortStepOf(type, effort);
  const clear = () => { onChange(""); effort?.onChange(""); };
  return (
    <div className="composer-field">
      <span>{effort ? `${label}与思考强度` : label}</span>
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
        displaySuffix={effort?.value ?? ""}
        steps={step2 ? [step2] : undefined}
        onClear={value || effort?.value ? clear : undefined}
        clearLabel="清空（跟随执行器）"
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
  effort,
  onChange,
}: {
  value: string;
  type: AgentType;
  profiles: AgentExecutorProfile[];
  disabled?: boolean;
  effort?: EffortStep;
  onChange: (value: string) => void;
}) {
  const providers = useProviders();
  const groups = useAgentModelCatalog(type, profiles, providers);
  const options = useMemo(() => catalogOptions(groups, value), [groups, value]);
  const note = catalogNote(groups);
  const step2 = effortStepOf(type, effort);
  const clear = () => { onChange(""); effort?.onChange(""); };
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
        displaySuffix={effort?.value ?? ""}
        steps={step2 ? [step2] : undefined}
        onClear={value || effort?.value ? clear : undefined}
        clearLabel="清空（跟随执行器）"
        onChange={onChange}
      />
      {note && <p className="task-inspector-note">{note}</p>}
    </>
  );
}
