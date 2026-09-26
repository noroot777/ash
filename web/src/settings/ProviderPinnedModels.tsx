import { useEffect, useMemo, useRef, useState } from "react";
import type { LlmProtocol, ProviderModelListMode } from "@ash/shared";
import { ArrowsClockwise, Play, X } from "@phosphor-icons/react";
import { Button, PillTabs } from "../components/ui.tsx";
import { Dropdown, type DropdownOption } from "../components/Dropdown.tsx";
import { api } from "../lib/api.ts";

/**
 * 「对话框里弹出这家供应商的模型时，列什么」的设置。
 *
 * - `api`：每次打开选择器都现调它的 /models，拿到什么列什么（总是最新，但慢、且供应商挂了就空）。
 * - `pinned`：只列用户在这里钉下的那几个（离线、稳定、可控）。
 *
 * 两者随时可切，且**切模式不动已钉的列表** —— 切去 api 看一眼再切回来，钉的还在。
 */
const MODE_TABS = [
  { value: "api" as const, label: "每次调用 API" },
  { value: "pinned" as const, label: "固定模型" },
];

export function ProviderPinnedModels({
  providerId,
  protocol,
  baseUrl,
  apiKey,
  protocolConversionEnabled,
  mode,
  pinned,
  onModeChange,
  onPinnedChange,
}: {
  providerId?: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  protocolConversionEnabled: boolean;
  mode: ProviderModelListMode;
  pinned: string[];
  onModeChange: (mode: ProviderModelListMode) => void;
  onPinnedChange: (models: string[]) => void;
}) {
  const [catalog, setCatalog] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState("");
  const [probed, setProbed] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const probeRequest = useRef(0);

  // 连的还是不是同一家供应商变了，之前探到的目录和测试结论就都不作数了。
  useEffect(() => {
    probeRequest.current += 1;
    setCatalog([]);
    setProbed(false);
    setProbing(false);
    setProbeError("");
    setResults({});
  }, [apiKey, baseUrl, protocol, providerId]);

  const probe = async () => {
    if (!baseUrl.trim()) {
      setProbeError("先填写 Base URL");
      return;
    }
    const request = ++probeRequest.current;
    setProbing(true);
    setProbeError("");
    try {
      const result = await api.probeModels({
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        id: providerId,
      });
      if (probeRequest.current !== request) return;
      setCatalog(result.models);
      setProbed(true);
      if (!result.models.length) setProbeError("供应商未返回模型");
    } catch (error) {
      if (probeRequest.current === request) {
        setProbeError(error instanceof Error ? error.message : "模型探测失败");
      }
    } finally {
      if (probeRequest.current === request) setProbing(false);
    }
  };

  const testModel = async (model: string) => {
    setTesting(model);
    try {
      const result = await api.testLlmProvider({
        id: providerId,
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        model,
        protocolConversionEnabled: protocol === "openai" && protocolConversionEnabled,
      });
      setResults((current) => ({
        ...current,
        [model]: { ok: true, text: `${result.elapsedMs} ms · ${result.reply}` },
      }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [model]: { ok: false, text: error instanceof Error ? error.message : "模型测试失败" },
      }));
    } finally {
      setTesting(null);
    }
  };

  // 探测过就在目录里挑（已钉的不再重复列），没探过（或探失败）也能在筛选框里
  // 直接手打模型名当自由值加进去。
  const candidates = useMemo<DropdownOption[]>(() => catalog
    .filter((model) => !pinned.includes(model))
    .map((model) => ({ value: model, label: model, mono: true, group: "探测到的模型" })),
  [catalog, pinned]);

  const add = (model: string) => {
    const value = model.trim();
    if (!value || pinned.includes(value)) return;
    onPinnedChange([...pinned, value]);
  };

  const remove = (model: string) => {
    onPinnedChange(pinned.filter((item) => item !== model));
    setResults((current) => {
      const next = { ...current };
      delete next[model];
      return next;
    });
  };

  return (
    <div className="is-wide provider-pinned-field">
      <div className="provider-pinned-head">
        <div className="provider-pinned-copy">
          <b>选择器里的模型列表</b>
          <small>
            {mode === "api"
              ? "对话框每次弹出这家供应商时都现调 /models，列出最新的完整目录。"
              : "对话框只列下面固定的模型，不再调 /models —— 供应商没有目录接口或响应太慢时用它。"}
          </small>
        </div>
        <PillTabs
          items={MODE_TABS}
          value={mode}
          onChange={onModeChange}
          label="模型列表来源"
        />
      </div>

      {mode === "pinned" && (
        <div className="provider-pinned-body">
          <div className="provider-pinned-add">
            <Dropdown
              label="添加固定模型"
              value=""
              options={candidates}
              status={probing ? "loading" : probeError ? "failed" : catalog.length ? "ready" : "idle"}
              note={probeError ? `探测失败：${probeError}（仍可直接填写模型名）` : ""}
              allowCustom
              mono
              keepOpenOnSelect
              filterPlaceholder={probed ? "筛选或直接填写模型名" : "填写模型名，或先探测再筛选"}
              emptyText={probed
                ? "没有匹配的模型，输入完整模型名即可直接使用"
                : "还没探测目录，输入完整模型名即可直接添加"}
              placeholder="添加模型"
              onChange={add}
            />
            <Button disabled={probing} onClick={() => void probe()}>
              <ArrowsClockwise size={12} className={probing ? "provider-spin" : ""} />
              {probing ? "探测中…" : "探测模型"}
            </Button>
          </div>

          {(catalog.length > 0 || probeError) && (
            <small className={probeError ? "is-error" : ""}>
              {probeError || `已返回 ${catalog.length} 个完整模型名`}
            </small>
          )}

          {pinned.length ? (
            <ul className="provider-pinned-list">
              {pinned.map((model) => {
                const result = results[model];
                return (
                  <li key={model}>
                    <code>{model}</code>
                    {result && (
                      <small className={result.ok ? "is-ok" : "is-error"}>{result.text}</small>
                    )}
                    <button
                      type="button"
                      className="provider-test-action"
                      disabled={testing === model || !baseUrl.trim()}
                      onClick={() => void testModel(model)}
                      aria-label={`测试模型 ${model}`}
                    >
                      <Play size={10} weight="fill" /> {testing === model ? "测试中" : "测试"}
                    </button>
                    <button
                      type="button"
                      className="settings-icon-danger"
                      onClick={() => remove(model)}
                      aria-label={`移除模型 ${model}`}
                    >
                      <X size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <small className="settings-muted">
              还没固定模型。选择器会退回这家供应商的默认模型，建议至少钉一个。
            </small>
          )}
        </div>
      )}
    </div>
  );
}
