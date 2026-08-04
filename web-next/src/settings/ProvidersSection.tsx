import { useEffect, useRef, useState } from "react";
import type { LlmProtocol, LlmProvider, ProviderModelListMode } from "@harness/shared";
import {
  ArrowsClockwise,
  CheckCircle,
  PencilSimple,
  Play,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { Button, Toggle } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { protocolLabel } from "./agentProviderRules.ts";
import { refreshProviders } from "../lib/modelCatalog.ts";
import { clearProviderModelCache } from "./ProviderModelInput.tsx";
import { ProviderPinnedModels } from "./ProviderPinnedModels.tsx";

type ProviderDraft = {
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocolConversionEnabled: boolean;
  modelListMode: ProviderModelListMode;
  pinnedModels: string[];
};

function ProviderModelField({
  providerId,
  protocol,
  baseUrl,
  apiKey,
  model,
  protocolConversionEnabled,
  onModelChange,
}: {
  providerId?: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocolConversionEnabled: boolean;
  onModelChange: (model: string) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probeError, setProbeError] = useState("");
  const [testResult, setTestResult] = useState("");
  const [testError, setTestError] = useState("");
  const probeRequest = useRef(0);
  const testRequest = useRef(0);
  const fieldId = `provider-${providerId ?? "new"}-model`;
  const datalistId = `provider-${providerId ?? "new"}-models`;

  useEffect(() => {
    probeRequest.current += 1;
    setModels([]);
    setProbing(false);
    setProbeError("");
  }, [apiKey, baseUrl, protocol, providerId]);

  useEffect(() => {
    testRequest.current += 1;
    setTesting(false);
    setTestResult("");
    setTestError("");
  }, [apiKey, baseUrl, model, protocol, protocolConversionEnabled, providerId]);

  const probe = async () => {
    if (!baseUrl.trim()) {
      setProbeError("先填写 base URL");
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
      setModels(result.models);
      if (!result.models.length) setProbeError("供应商未返回模型");
      else if (!model) onModelChange(result.models[0]);
    } catch (error) {
      if (probeRequest.current === request) {
        setProbeError(error instanceof Error ? error.message : "模型探测失败");
      }
    } finally {
      if (probeRequest.current === request) setProbing(false);
    }
  };

  const testModel = async () => {
    if (!baseUrl.trim()) {
      setTestError("先填写 Base URL");
      return;
    }
    if (!model.trim()) {
      setTestError("先填写要测试的模型");
      return;
    }
    const request = ++testRequest.current;
    setTesting(true);
    setTestResult("");
    setTestError("");
    try {
      const result = await api.testLlmProvider({
        id: providerId,
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        model: model.trim(),
        protocolConversionEnabled: protocol === "openai" && protocolConversionEnabled,
      });
      if (testRequest.current === request) {
        setTestResult(`${result.endpoint} · ${result.elapsedMs} ms · ${result.reply}`);
      }
    } catch (error) {
      if (testRequest.current === request) {
        setTestError(error instanceof Error ? error.message : "模型测试失败");
      }
    } finally {
      if (testRequest.current === request) setTesting(false);
    }
  };

  return (
    <div className="is-wide provider-model-field">
      <label htmlFor={fieldId}>默认模型</label>
      <div>
        <input
          id={fieldId}
          list={datalistId}
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
          placeholder="可选；Profile 的模型覆盖优先"
        />
        <Button disabled={probing} onClick={() => void probe()}>
          <ArrowsClockwise size={12} className={probing ? "provider-spin" : ""} />
          {probing ? "探测中…" : "探测模型"}
        </Button>
        <Button disabled={testing} onClick={() => void testModel()}>
          <Play size={12} weight="fill" />
          {testing ? "测试中…" : "测试模型"}
        </Button>
      </div>
      <datalist id={datalistId}>
        {models.map((candidate) => <option value={candidate} key={candidate} />)}
      </datalist>
      {(models.length > 0 || probeError) && (
        <small className={probeError ? "is-error" : ""}>
          {probeError || `已返回 ${models.length} 个完整模型名`}
        </small>
      )}
      {(testResult || testError) && (
        <small
          className={`provider-test-result${testError ? " is-error" : ""}`}
          role="status"
        >
          {testError || testResult}
        </small>
      )}
    </div>
  );
}

function ProviderForm({
  provider,
  onCancel,
  onSaved,
  notify,
}: {
  provider?: LlmProvider;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [draft, setDraft] = useState<ProviderDraft>({
    name: provider?.name ?? "",
    protocol: provider?.protocol ?? "anthropic",
    baseUrl: provider?.baseUrl ?? "",
    apiKey: "",
    model: provider?.model ?? "",
    protocolConversionEnabled: provider?.protocolConversionEnabled ?? false,
    modelListMode: provider?.modelListMode ?? "api",
    pinnedModels: provider?.pinnedModels ?? [],
  });
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => {
    setDraft((current) => ({
      ...current,
      [key]: value,
      ...(key === "protocol" && value === "anthropic" ? { protocolConversionEnabled: false } : {}),
    }));
  };

  const save = async () => {
    if (!draft.name.trim() || !draft.baseUrl.trim()) return;
    setSaving(true);
    try {
      if (provider) {
        await api.patchLlmProvider(provider.id, {
          name: draft.name.trim(),
          protocol: draft.protocol,
          baseUrl: draft.baseUrl.trim(),
          model: draft.model.trim(),
          protocolConversionEnabled: draft.protocol === "openai" && draft.protocolConversionEnabled,
          modelListMode: draft.modelListMode,
          pinnedModels: draft.pinnedModels,
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        });
        clearProviderModelCache(provider.id);
      } else {
        await api.createLlmProvider({
          name: draft.name.trim(),
          protocol: draft.protocol,
          baseUrl: draft.baseUrl.trim(),
          apiKey: draft.apiKey.trim(),
          model: draft.model.trim(),
          protocolConversionEnabled: draft.protocol === "openai" && draft.protocolConversionEnabled,
          modelListMode: draft.modelListMode,
          pinnedModels: draft.pinnedModels,
        });
      }
      // 供应商是模型目录的来源:改完要让页面上其它选模型的地方当场跟着变。
      refreshProviders();
      await onSaved();
    } catch (error) {
      notify(error instanceof Error ? error.message : "供应商保存失败");
      setSaving(false);
    }
  };

  return (
    <div className="provider-form">
      <div className="provider-form-grid">
        <label>
          <span>名称</span>
          <input value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder="例如 公司自建" />
        </label>
        <label>
          <span>协议</span>
          <select value={draft.protocol} onChange={(event) => set("protocol", event.target.value as LlmProtocol)}>
            <option value="anthropic">Anthropic 兼容</option>
            <option value="openai">OpenAI 兼容</option>
          </select>
        </label>
        <label className="is-wide">
          <span>Base URL</span>
          <input
            className="provider-mono-input"
            value={draft.baseUrl}
            onChange={(event) => set("baseUrl", event.target.value)}
            placeholder="https://provider.example.com（根地址，不含 /v1）"
          />
        </label>
        <label className="is-wide">
          <span>API Key</span>
          <input
            className="provider-mono-input"
            type="password"
            value={draft.apiKey}
            onChange={(event) => set("apiKey", event.target.value)}
            placeholder={provider?.hasKey ? "留空保持现有 Key" : "API Key"}
          />
        </label>
        {draft.protocol === "openai" && (
          <div className="is-wide provider-conversion-field">
            <div>
              <b>Responses → Chat Completions</b>
              <small>供应商只支持 /chat/completions 时开启；Codex 的 /responses 请求与流式响应会自动转换。</small>
            </div>
            <Toggle
              checked={draft.protocolConversionEnabled}
              onChange={(checked) => set("protocolConversionEnabled", checked)}
              label={draft.protocolConversionEnabled ? "协议转换已开启" : "协议转换已关闭"}
            />
          </div>
        )}
        <ProviderModelField
          providerId={provider?.id}
          protocol={draft.protocol}
          baseUrl={draft.baseUrl}
          apiKey={draft.apiKey}
          model={draft.model}
          protocolConversionEnabled={draft.protocolConversionEnabled}
          onModelChange={(model) => set("model", model)}
        />
        <ProviderPinnedModels
          providerId={provider?.id}
          protocol={draft.protocol}
          baseUrl={draft.baseUrl}
          apiKey={draft.apiKey}
          protocolConversionEnabled={draft.protocolConversionEnabled}
          mode={draft.modelListMode}
          pinned={draft.pinnedModels}
          onModeChange={(mode) => set("modelListMode", mode)}
          onPinnedChange={(models) => set("pinnedModels", models)}
        />
      </div>
      <div className="provider-form-actions">
        <Button variant="ghost" disabled={saving} onClick={onCancel}>取消</Button>
        <Button
          variant="primary"
          disabled={saving || !draft.name.trim() || !draft.baseUrl.trim()}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : provider ? "保存供应商" : "添加供应商"}
        </Button>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  onChanged,
  notify,
}: {
  provider: LlmProvider;
  onChanged: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (editing) {
    return (
      <ProviderForm
        provider={provider}
        notify={notify}
        onCancel={() => setEditing(false)}
        onSaved={async () => {
          await onChanged();
          setEditing(false);
          notify(`供应商「${provider.name}」已更新`);
        }}
      />
    );
  }

  const remove = async () => {
    setDeleting(true);
    try {
      await api.deleteLlmProvider(provider.id);
      clearProviderModelCache(provider.id);
      refreshProviders();
      await onChanged();
      notify(`供应商「${provider.name}」已删除`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "供应商删除失败");
      setDeleting(false);
    }
  };

  const testModel = async () => {
    if (!provider.model) {
      notify(`供应商「${provider.name}」还没有设置测试模型`);
      return;
    }
    setTesting(true);
    try {
      const result = await api.testLlmProvider({ id: provider.id, model: provider.model });
      notify(`「${provider.name}」测试通过 · ${result.elapsedMs} ms · ${result.reply}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "模型测试失败");
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <article className="provider-row">
        <span className={`provider-protocol is-${provider.protocol}`}>
          {provider.protocol === "anthropic" ? "A" : "O"}
        </span>
        <div className="provider-copy">
          <b>{provider.name}</b>
          <small>
            {protocolLabel(provider.protocol)} · {provider.baseUrl}
            {provider.protocolConversionEnabled ? " · Responses→Chat 已开启" : ""}
            {provider.modelListMode === "pinned"
              ? ` · 固定 ${provider.pinnedModels.length} 个模型`
              : " · 选择器实时拉取模型"}
          </small>
        </div>
        <span className={`provider-key-state${provider.hasKey ? " is-ready" : ""}`}>
          {provider.hasKey && <CheckCircle size={12} weight="fill" />}
          {provider.hasKey ? "Key 已保存" : "缺少 Key"}
        </span>
        <span className="provider-default-model">{provider.model || "未设默认模型"}</span>
        <button
          type="button"
          className="provider-test-action"
          disabled={testing}
          onClick={() => void testModel()}
          aria-label={`测试 ${provider.name} 的模型`}
        >
          <Play size={11} weight="fill" /> {testing ? "测试中" : "测试"}
        </button>
        <button type="button" className="provider-icon-action" onClick={() => setEditing(true)} aria-label={`编辑 ${provider.name}`}>
          <PencilSimple size={14} />
        </button>
        <button type="button" className="settings-icon-danger" onClick={() => setConfirmDelete(true)} aria-label={`删除 ${provider.name}`}>
          <Trash size={14} />
        </button>
      </article>
      {confirmDelete && (
        <ConfirmDialog
          title="删除供应商"
          message={`删除“${provider.name}”后，绑定它的执行器会退回 CLI 官方账号。`}
          confirmLabel="删除"
          danger
          busy={deleting}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}

export function ProvidersSection({
  providers,
  onChanged,
  notify,
}: {
  providers: LlmProvider[];
  onChanged: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="settings-section">
      <h2>模型供应商</h2>
      <div className="settings-card providers-card">
        <div className="providers-intro">
          <div>
            <b>Provider → Profile → 任务</b>
            <small>Provider 保存协议、Base URL 与 Key；绑定后的 Profile 使用它的额度和完整模型目录。</small>
          </div>
          {!adding && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus size={12} weight="bold" /> 添加供应商
            </Button>
          )}
        </div>
        {!providers.length && !adding && (
          <p className="settings-muted">还没有供应商；现有 Profile 继续使用各 CLI 的官方登录账号。</p>
        )}
        {providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            onChanged={onChanged}
            notify={notify}
          />
        ))}
        {adding && (
          <ProviderForm
            notify={notify}
            onCancel={() => setAdding(false)}
            onSaved={async () => {
              await onChanged();
              setAdding(false);
              notify("供应商已添加");
            }}
          />
        )}
      </div>
    </section>
  );
}
