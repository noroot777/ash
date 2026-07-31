import { useState } from "react";
import type { LlmProtocol, LlmProvider } from "@harness/shared";
import {
  ArrowsClockwise,
  CheckCircle,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { protocolLabel } from "./agentProviderRules.ts";
import { clearProviderModelCache } from "./ProviderModelInput.tsx";

type ProviderDraft = {
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
};

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
  });
  const [models, setModels] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probeError, setProbeError] = useState("");

  const set = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (key === "protocol" || key === "baseUrl" || key === "apiKey") {
      setModels([]);
      setProbeError("");
    }
  };

  const probe = async () => {
    if (!draft.baseUrl.trim()) {
      setProbeError("先填写 base URL");
      return;
    }
    setProbing(true);
    setProbeError("");
    try {
      const result = await api.probeModels({
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim() || undefined,
        id: provider?.id,
      });
      setModels(result.models);
      if (!result.models.length) setProbeError("供应商未返回模型");
      else if (!draft.model) set("model", result.models[0]);
    } catch (error) {
      setProbeError(error instanceof Error ? error.message : "模型探测失败");
    } finally {
      setProbing(false);
    }
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
        });
      }
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
        <label className="is-wide provider-model-field">
          <span>默认模型</span>
          <div>
            <input
              list={`provider-${provider?.id ?? "new"}-models`}
              value={draft.model}
              onChange={(event) => set("model", event.target.value)}
              placeholder="可选；Profile 的模型覆盖优先"
            />
            <Button disabled={probing} onClick={() => void probe()}>
              <ArrowsClockwise size={12} className={probing ? "provider-spin" : ""} />
              {probing ? "探测中…" : "探测模型"}
            </Button>
          </div>
          <datalist id={`provider-${provider?.id ?? "new"}-models`}>
            {models.map((model) => <option value={model} key={model} />)}
          </datalist>
          {(models.length > 0 || probeError) && (
            <small className={probeError ? "is-error" : ""}>
              {probeError || `已返回 ${models.length} 个完整模型名`}
            </small>
          )}
        </label>
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
      await onChanged();
      notify(`供应商「${provider.name}」已删除`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "供应商删除失败");
      setDeleting(false);
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
          <small>{protocolLabel(provider.protocol)} · {provider.baseUrl}</small>
        </div>
        <span className={`provider-key-state${provider.hasKey ? " is-ready" : ""}`}>
          {provider.hasKey && <CheckCircle size={12} weight="fill" />}
          {provider.hasKey ? "Key 已保存" : "缺少 Key"}
        </span>
        <span className="provider-default-model">{provider.model || "未设默认模型"}</span>
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
