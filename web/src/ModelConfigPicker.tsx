import { useEffect, useState, type ReactNode } from "react";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import {
  CLI_MODEL_PRESETS,
  REASONING_EFFORT_DETAIL,
  REASONING_EFFORT_VALUES,
} from "@harness/shared/cli-presets";
import { api } from "./api";
import { Menu, type MenuOption } from "./Menu";
import type { ExecutorSelection } from "./ExecutorPicker";

const providerModelCache = new Map<string, string[]>();

export function clearProviderModelCache() {
  providerModelCache.clear();
}

export function profileForSelection(
  selection: ExecutorSelection,
  profiles: AgentExecutorProfile[],
): AgentExecutorProfile | undefined {
  const selected = selection.executorId
    ? profiles.find((profile) => profile.id === selection.executorId)
    : undefined;
  return selected
    ?? profiles.find((profile) => profile.type === selection.agentType && profile.isDefault);
}

export function providerForSelection(
  selection: ExecutorSelection,
  profiles: AgentExecutorProfile[],
  providers: LlmProvider[],
): LlmProvider | undefined {
  const profile = profileForSelection(selection, profiles);
  return profile?.providerId
    ? providers.find((provider) => provider.id === profile.providerId)
    : undefined;
}

const defaultOptions = (
  values: readonly string[],
  defaultLabel: string,
  defaultDetail: string,
): MenuOption[] => [
  { value: "", label: defaultLabel, detail: defaultDetail },
  ...values.map((value) => ({
    value,
    label: value,
    detail: REASONING_EFFORT_DETAIL[value],
  })),
];

function ConfigLabel({ label, value, fallback }: { label: string; value?: string | null; fallback: string }) {
  return (
    <>
      <span className="shrink-0 text-faint">{label}</span>
      <span className="truncate">{value || fallback}</span>
    </>
  );
}

export function ModelConfigPicker({
  type,
  provider,
  value,
  onChange,
  defaultLabel = "默认",
  defaultDetail,
  fallback = "跟随执行器",
  triggerClassName,
  label = "模型",
}: {
  type: AgentType;
  provider?: LlmProvider;
  value?: string | null;
  onChange: (value: string) => void;
  defaultLabel?: string;
  defaultDetail?: string;
  fallback?: string;
  triggerClassName: string;
  label?: string;
}) {
  const [models, setModels] = useState<string[] | null>(
    provider ? providerModelCache.get(provider.id) ?? null : null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setModels(provider ? providerModelCache.get(provider.id) ?? null : null);
    setError(null);
  }, [provider?.id]);

  const listed = provider ? models ?? [] : CLI_MODEL_PRESETS[type];
  const values = value && !listed.includes(value) ? [value, ...listed] : listed;
  const followDetail = defaultDetail
    ?? (provider ? "跟随供应商默认模型" : "跟随 CLI 配置的默认模型");

  return (
    <Menu
      options={defaultOptions(values, defaultLabel, followDetail)}
      value={value ?? ""}
      onChange={onChange}
      menuWidth={provider ? 320 : 250}
      triggerClassName={triggerClassName}
      header={({ select }) => (
        <div className="flex flex-col gap-1">
          <input
            placeholder="自定义模型名，Enter 确认"
            defaultValue={value ?? ""}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                select((event.target as HTMLInputElement).value.trim());
              }
            }}
            className="w-full rounded border border-line bg-canvas px-1.5 py-1 text-[12px] outline-none placeholder:text-faint"
          />
          {provider && (
            <>
              <ProviderModels
                provider={provider}
                done={models !== null}
                onModels={setModels}
                onError={setError}
              />
              <div className={`px-0.5 text-[11px] ${error ? "text-red-600" : "text-faint"}`}>
                {error
                  ?? (models
                    ? `供应商「${provider.name}」的 ${models.length} 个模型`
                    : `正在从「${provider.name}」拉取模型…`)}
              </div>
            </>
          )}
        </div>
      )}
    >
      <ConfigLabel label={label} value={value} fallback={fallback} />
    </Menu>
  );
}

function ProviderModels({
  provider,
  done,
  onModels,
  onError,
}: {
  provider: LlmProvider;
  done: boolean;
  onModels: (models: string[]) => void;
  onError: (error: string) => void;
}) {
  useEffect(() => {
    if (done) return;
    let alive = true;
    api
      .probeModels({ protocol: provider.protocol, baseUrl: provider.baseUrl, id: provider.id })
      .then(({ models }) => {
        providerModelCache.set(provider.id, models);
        if (alive) onModels(models);
      })
      .catch((error) => {
        if (alive) onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
    };
  }, [provider, done, onModels, onError]);
  return null;
}

export function ReasoningEffortPicker({
  type,
  value,
  onChange,
  defaultLabel = "默认",
  defaultDetail = "跟随 CLI 默认",
  fallback = "跟随执行器",
  triggerClassName,
  label = "强度",
  icon,
}: {
  type: AgentType;
  value?: string | null;
  onChange: (value: string) => void;
  defaultLabel?: string;
  defaultDetail?: string;
  fallback?: string;
  triggerClassName: string;
  label?: string;
  icon?: ReactNode;
}) {
  const values = REASONING_EFFORT_VALUES[type];
  // 大多数 CLI 没有（或还没实测出）思考强度档位，`values` 是空数组。这时下拉里只剩一条
  // 「跟随执行器」，点开一个单选项没有任何意义——整个 chip 不渲染。已经设过值的仍要渲染
  // （换类型后留下的旧覆盖得有地方清掉，也得看得见现在挂着什么）。
  if (values.length === 0 && !value) return null;

  return (
    <Menu
      options={defaultOptions(values, defaultLabel, defaultDetail)}
      value={value ?? ""}
      onChange={onChange}
      menuWidth={270}
      triggerClassName={triggerClassName}
    >
      {icon}
      <ConfigLabel label={label} value={value} fallback={fallback} />
    </Menu>
  );
}
