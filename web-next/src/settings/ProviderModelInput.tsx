import { useEffect, useMemo, useState } from "react";
import type { AgentType, LlmProvider } from "@harness/shared";
import { CLI_MODEL_PRESETS } from "@harness/shared/cli-presets";
import { api } from "../lib/api.ts";

const providerModelCache = new Map<string, string[]>();
const providerModelRequests = new Map<string, Promise<string[]>>();
const providerModelVersions = new Map<string, number>();

function providerCacheKey(provider: LlmProvider) {
  const version = providerModelVersions.get(provider.id) ?? 0;
  return `${provider.id}\u0000${version}\u0000${provider.protocol}\u0000${provider.baseUrl}`;
}

export function clearProviderModelCache(providerId?: string) {
  if (providerId) {
    providerModelVersions.set(providerId, (providerModelVersions.get(providerId) ?? 0) + 1);
    const prefix = `${providerId}\u0000`;
    for (const key of providerModelCache.keys()) {
      if (key.startsWith(prefix)) providerModelCache.delete(key);
    }
    for (const key of providerModelRequests.keys()) {
      if (key.startsWith(prefix)) providerModelRequests.delete(key);
    }
    return;
  }
  providerModelCache.clear();
  providerModelRequests.clear();
  providerModelVersions.clear();
}

function loadProviderModels(provider: LlmProvider) {
  const key = providerCacheKey(provider);
  const cached = providerModelCache.get(key);
  if (cached) return Promise.resolve(cached);
  let request = providerModelRequests.get(key);
  if (!request) {
    request = api.probeModels({
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      id: provider.id,
    }).then(({ models }) => {
      providerModelCache.set(key, models);
      providerModelRequests.delete(key);
      return models;
    }, (error) => {
      providerModelRequests.delete(key);
      throw error;
    });
    providerModelRequests.set(key, request);
  }
  return request;
}

export function ProviderModelInput({
  inputId,
  type,
  provider,
  value,
  disabled,
  onChange,
  onCommit,
}: {
  inputId: string;
  type: AgentType;
  provider?: LlmProvider;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
}) {
  const cacheVersion = provider ? providerModelVersions.get(provider.id) ?? 0 : 0;
  const [models, setModels] = useState<string[]>(() => (
    provider ? providerModelCache.get(providerCacheKey(provider)) ?? [] : [...CLI_MODEL_PRESETS[type]]
  ));
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">(
    provider ? (providerModelCache.has(providerCacheKey(provider)) ? "ready" : "loading") : "idle",
  );
  const [error, setError] = useState("");

  useEffect(() => {
    if (!provider) {
      setModels([...CLI_MODEL_PRESETS[type]]);
      setStatus("idle");
      setError("");
      return;
    }
    const cached = providerModelCache.get(providerCacheKey(provider));
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
  }, [provider?.id, provider?.protocol, provider?.baseUrl, type, cacheVersion]);

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
        placeholder={provider ? provider.model || "跟随供应商默认" : "跟随 CLI"}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onCommit?.(event.target.value.trim())}
      />
      <datalist id={datalistId}>
        {options.map((model) => <option value={model} key={model} />)}
      </datalist>
      {provider && (
        <small className={status === "failed" ? "is-error" : ""}>
          {status === "loading" && `正在从「${provider.name}」探测模型…`}
          {status === "ready" && `${provider.name} · ${models.length} 个完整模型名`}
          {status === "failed" && `仍可手填模型：${error}`}
        </small>
      )}
    </div>
  );
}
