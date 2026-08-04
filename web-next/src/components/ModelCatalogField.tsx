import { useMemo } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { useAgentModelCatalog, useProviders, type ModelGroup } from "../lib/modelCatalog.ts";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";
import { EffortPicker } from "./EffortPicker.tsx";

/**
 * 「选模型」的两个通用控件：把 lib/modelCatalog.ts 的分块目录接到表单里，于是
 * 供应商页面那个「每次调 API / 固定模型」开关能一次管住所有选模型的地方。
 *
 * ModelCatalogField 是带标题的表单项，允许手填目录之外的模型（新建/派生面板的
 * 「高级配置」）。需要「连执行器一起选」的地方用的是另一颗胶囊，见
 * components/ExecutorModelPicker.tsx。
 *
 * 传了 `effort` 就在模型旁边并排摆一颗**独立**的思考强度胶囊（EffortPicker），而
 * 不是塞进同一个下拉的第二步：模型和档位是两件事，换模型不该顺手改档位，改档位也
 * 不该重走一遍选模型。两边对不上时由 EffortPicker 自己出提示——供应商的 /v1/models
 * 只返回模型 id，「这个模型支持哪些档位」拿不到，只能靠 shared 里的实测规则表。
 */

/** 模型旁边那颗思考强度胶囊的受控接口。 */
export type EffortStep = {
  value: string;
  onChange: (value: string) => void;
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
  executorId = null,
  disabled = false,
  effort,
  onChange,
}: {
  label: string;
  value: string;
  type: AgentType;
  profiles: AgentExecutorProfile[];
  /** 当前执行器：它挂的供应商在候选里排最前。 */
  executorId?: string | null;
  disabled?: boolean;
  /** 传了就在模型旁边并排一颗思考强度胶囊。 */
  effort?: EffortStep;
  onChange: (value: string) => void;
}) {
  const providers = useProviders();
  const groups = useAgentModelCatalog(type, profiles, providers, executorId);
  const options = useMemo(() => catalogOptions(groups, value), [groups, value]);
  const note = catalogNote(groups);
  return (
    <div className="composer-field">
      <span>{effort ? `${label}与思考强度` : label}</span>
      <div className="model-effort-row">
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
          onClear={value ? () => onChange("") : undefined}
          clearLabel="清空（跟随执行器）"
          onChange={onChange}
        />
        {effort && (
          <EffortPicker
            type={type}
            model={value}
            value={effort.value}
            disabled={disabled}
            onChange={effort.onChange}
          />
        )}
      </div>
      {note && <small>{note}</small>}
    </div>
  );
}
