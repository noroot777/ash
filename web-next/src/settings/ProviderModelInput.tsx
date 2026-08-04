import { useEffect, useMemo, useState } from "react";
import type { AgentType, LlmProvider } from "@harness/shared";
import { CLI_MODEL_PRESETS } from "@harness/shared/cli-presets";
import {
  cachedProviderModels,
  loadProviderModels,
  pinnedModelsOf,
  providerCacheVersion,
} from "../lib/modelCatalog.ts";

// 缓存与探测都住在 lib/modelCatalog.ts（对话框的 @ 选择器共用同一份）；这里保留
// 转发，是因为几个设置页早就 `import { clearProviderModelCache } from "./ProviderModelInput.tsx"`。
export { clearProviderModelCache } from "../lib/modelCatalog.ts";

export function ProviderModelInput({
  inputId,
  type,
  provider,
  value,
  disabled,
  compact = false,
  onChange,
  onCommit,
}: {
  inputId: string;
  type: AgentType;
  provider?: LlmProvider;
  value: string;
  disabled?: boolean;
  compact?: boolean;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
}) {
  const cacheVersion = provider ? providerCacheVersion(provider.id) : 0;
  const [models, setModels] = useState<string[]>(() => (
    provider ? cachedProviderModels(provider) ?? [] : [...CLI_MODEL_PRESETS[type]]
  ));
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">(
    provider ? (cachedProviderModels(provider) ? "ready" : "loading") : "idle",
  );
  const [error, setError] = useState("");

  const pinnedMode = provider?.modelListMode === "pinned";

  useEffect(() => {
    if (!provider) {
      setModels([...CLI_MODEL_PRESETS[type]]);
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

  const options = useMemo(() => Array.from(new Set([
    ...(provider?.model ? [provider.model] : []),
    ...models,
    ...(value ? [value] : []),
  ])), [models, provider?.model, value]);
  const datalistId = `${inputId}-models`;

  return (
    <div className="agent-model-control">
      <input
        id={inputId}
        list={datalistId}
        value={value}
        disabled={disabled}
        aria-label={provider && compact
          ? `模型 · ${provider.name} · ${status === "loading" ? "正在探测模型" : status === "failed" ? `探测失败：${error}` : `${models.length} 个模型`}`
          : undefined}
        placeholder={provider ? provider.model || "跟随供应商默认" : "跟随 CLI"}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onCommit?.(event.target.value.trim())}
      />
      <datalist id={datalistId}>
        {options.map((model) => <option value={model} key={model} />)}
      </datalist>
      {provider && !compact && (
        <small className={status === "failed" ? "is-error" : ""}>
          {status === "loading" && `正在从「${provider.name}」探测模型…`}
          {status === "ready" && (pinnedMode
            ? `${provider.name} · 固定 ${models.length} 个模型`
            : `${provider.name} · ${models.length} 个完整模型名`)}
          {status === "failed" && `仍可手填模型：${error}`}
        </small>
      )}
    </div>
  );
}
