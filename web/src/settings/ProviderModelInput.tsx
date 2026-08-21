import { useEffect, useMemo, useState } from "react";
import type { AgentType, LlmProvider } from "@ash/shared";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { Dropdown, type DropdownOption } from "../components/Dropdown.tsx";
import { EffortPicker } from "../components/EffortPicker.tsx";
import { cliCatalogNote, useCliModelCatalog } from "../lib/cliModelCatalog.ts";
import {
  cachedProviderModels,
  loadProviderModels,
  pinnedModelsOf,
  providerCacheVersion,
} from "../lib/modelCatalog.ts";

// 缓存与探测都住在 lib/modelCatalog.ts（对话框的 @ 选择器共用同一份）；这里保留
// 转发，是因为几个设置页早就 `import { clearProviderModelCache } from "./ProviderModelInput.tsx"`。
export { clearProviderModelCache } from "../lib/modelCatalog.ts";

/**
 * 「这个执行器跑哪个模型」的选择器。
 *
 * 以前是 `input + datalist`：Chrome 会按输入框里已有的值过滤候选，于是设好模型后
 * 再点下拉**只剩当前这一个**，看着就是坏的。现在走统一的 Dropdown —— 候选永远是
 * 完整一份，筛选是浮层里另一个输入框的事，手填目录之外的模型名也仍然支持。
 *
 * 传了 `effort` 就在旁边并排一颗独立的智能水平胶囊（EffortPicker）：模型和档位是
 * 两件事，换模型不顺手把档位改掉，但选定模型后会向右打开档位；新模型不支持已选值
 * 时由那颗胶囊出提示，让用户自己决定改哪一边。
 */
export function ProviderModelInput({
  type,
  provider,
  value,
  disabled,
  compact = false,
  effort,
  onChange,
  onCommit,
}: {
  type: AgentType;
  provider?: LlmProvider;
  value: string;
  disabled?: boolean;
  compact?: boolean;
  /** 传了就在模型旁边并排一颗智能水平胶囊。 */
  effort?: { value: string; onChange: (value: string) => void };
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
}) {
  const cacheVersion = provider ? providerCacheVersion(provider.id) : 0;
  // 没挂供应商 = 走 CLI 官方账号,候选由服务端现问 CLI(`grok models` 之类)。
  // 挂了供应商就传 null:这个 hook 不发请求,免得每个设置页白探一次。
  const cli = useCliModelCatalog(provider ? null : type);
  const [models, setModels] = useState<string[]>(() => (provider ? cachedProviderModels(provider) ?? [] : []));
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">(
    provider ? (cachedProviderModels(provider) ? "ready" : "loading") : "idle",
  );
  const [error, setError] = useState("");
  const [effortOpen, setEffortOpen] = useState(false);

  const pinnedMode = provider?.modelListMode === "pinned";

  useEffect(() => {
    if (!provider) {
      setStatus("idle");
      setError("");
      return;
    }
    // 固定模式：候选就是用户在供应商页面钉下的那几个，一个探测请求都不发。
    if (provider.modelListMode === "pinned") {
      setModels(pinnedModelsOf(provider));
      setStatus("ready");
      setError("");
      return;
    }
    const cached = cachedProviderModels(provider);
    if (cached) {
      setModels(cached);
      setStatus("ready");
      setError("");
      return;
    }
    let alive = true;
    setModels([]);
    setStatus("loading");
    setError("");
    void loadProviderModels(provider).then(
      (nextModels) => {
        if (!alive) return;
        setModels(nextModels);
        setStatus("ready");
      },
      (nextError) => {
        if (!alive) return;
        setStatus("failed");
        setError(nextError instanceof Error ? nextError.message : "模型探测失败");
      },
    );
    return () => { alive = false; };
  }, [provider?.id, provider?.protocol, provider?.baseUrl, provider?.modelListMode, provider?.pinnedModels, type, cacheVersion]);

  const groupName = provider ? provider.name : `${type} 预设`;
  // 供应商那条走探测状态,CLI 那条走服务端现问的结果。
  const candidates = provider ? models : cli.catalog ? [...cli.catalog.models] : [];
  // 「默认」两边都有:供应商是用户自己配的,CLI 是它自己报的(`Default model:` 那行)。
  const defaultModel = provider ? provider.model : cli.catalog?.defaultModel ?? "";
  const defaultDetail = provider ? "供应商默认" : "CLI 默认";
  const followLabel = provider
    ? `跟随供应商默认${provider.model ? `（${provider.model}）` : ""}`
    : "跟随 CLI";
  // 「跟随」不占候选行：它不是一个模型，混在模型里既拉长列表又容易误点。回到不覆盖
  // 走浮层底部那条「清空」。
  const options = useMemo<DropdownOption[]>(() => {
    const seen = new Set<string>();
    const rows: DropdownOption[] = [];
    for (const model of [...(defaultModel ? [defaultModel] : []), ...candidates, ...(value ? [value] : [])]) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      rows.push({
        value: model,
        label: model,
        group: groupName,
        mono: true,
        detail: model === defaultModel ? defaultDetail : "",
      });
    }
    return rows;
  }, [candidates, defaultDetail, defaultModel, groupName, value]);

  const note = status === "loading"
    ? `正在从「${provider?.name ?? type}」探测模型…`
    : status === "failed"
      ? `探测失败：${error}（仍可手填模型名）`
      : "";

  // 这个执行器钉着的模型不是 CLI 现在的默认(比如还钉在 grok-4.5,而 CLI 已经默认 4.6)。
  // 只在**实时清单**里成立:拿滞后的内置快照去说「默认已是」会反过来误导人。
  const behindDefault =
    !provider && cli.catalog?.source === "probe" && !!cli.catalog.defaultModel && !!value && value !== cli.catalog.defaultModel;

  // 换模型不动档位：新模型支不支持已选档位由旁边那颗胶囊如实提示，静默改掉会让
  // 用户下次打开时看见一个自己没设过的值。
  const commit = (next: string) => {
    onChange(next);
    onCommit?.(next);
    if (effort) setEffortOpen(true);
  };

  const clear = () => commit("");

  return (
    <div className="agent-model-control">
      <div className="model-effort-row">
        <Dropdown
          label={provider ? `模型 · ${provider.name}` : "模型"}
          value={value}
          options={options}
          status={status}
          note={note}
          disabled={disabled}
          allowCustom
          mono
          filterPlaceholder="筛选或直接填写模型名"
          emptyText="没有匹配的模型，输入完整模型名即可直接使用"
          placeholder={provider ? provider.model || "跟随供应商默认" : "跟随 CLI"}
          onChange={commit}
          onClear={value ? clear : undefined}
          clearLabel={followLabel}
        />
        {effort && (
          <EffortPicker
            type={type}
            model={value || provider?.model || null}
            value={effort.value}
            disabled={disabled}
            open={effortOpen}
            onOpenChange={setEffortOpen}
            onChange={effort.onChange}
          />
        )}
      </div>
      {provider && !compact && (
        <small className={status === "failed" ? "is-error" : ""}>
          {status === "loading" && `正在从「${provider.name}」探测模型…`}
          {status === "ready" && (pinnedMode
            ? `${provider.name} · 固定 ${models.length} 个模型`
            : `${provider.name} · ${models.length} 个完整模型名`)}
          {status === "failed" && `仍可手填模型：${error}`}
        </small>
      )}
      {/* CLI 官方账号:来源说明 + 刷新。执行器表用 compact 藏供应商状态行,但这条不能藏 ——
          设置页唯一入口就是 AgentProfileRow(compact),藏掉等于按钮根本不存在。 */}
      {!provider && (
        <small className={cli.catalog?.error ? "is-error" : ""}>
          <span>{cliCatalogNote(cli.catalog)}</span>
          {/* 「能选到新模型」不等于「这个执行器已经在用它」:钉死的旧模型会一直跑下去,
              而清单刷新得再勤也不会去改用户的配置。差异只如实说一句,改不改由用户定。 */}
          {behindDefault && <span className="model-behind-default">· CLI 默认已是 {cli.catalog?.defaultModel}</span>}
          {cli.catalog?.probeSupported && (
            <button
              type="button"
              className="model-refresh"
              aria-label={`刷新 ${type} 的模型清单`}
              disabled={cli.refreshing || disabled}
              onClick={cli.refresh}
            >
              <ArrowsClockwise size={11} className={cli.refreshing ? "is-spinning" : ""} aria-hidden="true" />
              刷新
            </button>
          )}
        </small>
      )}
    </div>
  );
}
