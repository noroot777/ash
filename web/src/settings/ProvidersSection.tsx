import { useEffect, useMemo, useRef, useState } from "react";
import type { LlmProtocol, LlmProvider, ProviderModelListMode } from "@ash/shared";
import {
  ArrowsClockwise,
  CheckCircle,
  PencilSimple,
  Play,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { Button, Toggle } from "../components/ui.tsx";
import { Dropdown, type DropdownOption } from "../components/Dropdown.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { agentsForProtocol, protocolLabel } from "./agentProviderRules.ts";
import { refreshProviders } from "../lib/modelCatalog.ts";
import { clearProviderModelCache } from "./ProviderModelInput.tsx";
import { ProviderPinnedModels } from "./ProviderPinnedModels.tsx";
import { ProviderContext1mModels } from "./ProviderContext1mModels.tsx";
import { useProviderCatalog, type ProviderCatalog } from "./useProviderCatalog.ts";

type ProviderDraft = {
  name: string;
  /** `""` = 还没选。**新建时故意没有默认值**,理由见 ProtocolChoice。 */
  protocol: LlmProtocol | "";
  baseUrl: string;
  apiKey: string;
  model: string;
  protocolConversionEnabled: boolean;
  modelListMode: ProviderModelListMode;
  pinnedModels: string[];
  context1mModels: string[];
};

function ProviderModelField({
  providerId,
  providerName,
  protocol,
  baseUrl,
  apiKey,
  model,
  knownModels,
  context1mModels,
  protocolConversionEnabled,
  catalog,
  onModelChange,
}: {
  providerId?: string;
  providerName: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  knownModels: string[];
  context1mModels: string[];
  protocolConversionEnabled: boolean;
  /** 整个表单共用的那份模型目录。 */
  catalog: ProviderCatalog;
  onModelChange: (model: string) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [testError, setTestError] = useState("");
  const testRequest = useRef(0);
  const { models, probing, error: probeError, probe } = catalog;

  useEffect(() => {
    testRequest.current += 1;
    setTesting(false);
    setTestResult("");
    setTestError("");
  }, [apiKey, baseUrl, model, protocol, protocolConversionEnabled, providerId]);

  // 从**这颗**按钮探测才顺手补上默认模型：下面那两处探的是固定/1M 列表，
  // 在那里按一下就被改掉默认模型，用户不会预期。
  const probeForDefault = async () => {
    const probedModels = await probe();
    if (probedModels?.length && !model) onModelChange(probedModels[0]);
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
        context1m: protocol === "anthropic" && context1mModels.includes(model.trim()),
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

  const options = useMemo<DropdownOption[]>(() => {
    const seen = new Set<string>();
    return [...(model ? [model] : []), ...knownModels, ...models].flatMap((candidate) => {
      const value = candidate.trim();
      if (!value || seen.has(value)) return [];
      seen.add(value);
      return [{
        value,
        label: value,
        group: providerName.trim() || "供应商模型",
        mono: true,
        detail: [value === model ? "当前默认" : "", context1mModels.includes(value) ? "1M" : ""]
          .filter(Boolean)
          .join(" · "),
      }];
    });
  }, [context1mModels, knownModels, model, models, providerName]);

  return (
    <div className="is-wide provider-model-field">
      <label>默认模型</label>
      <div className="provider-model-control">
        <Dropdown
          label="默认模型"
          value={model}
          options={options}
          status={probing ? "loading" : probeError ? "failed" : models.length ? "ready" : "idle"}
          note={probeError ? `探测失败：${probeError}（仍可直接填写模型名）` : ""}
          allowCustom
          mono
          filterPlaceholder="筛选或直接填写模型名"
          emptyText="没有匹配的模型，输入完整模型名即可直接使用"
          placeholder="可选；Profile 的模型覆盖优先"
          onChange={onModelChange}
          onClear={model ? () => onModelChange("") : undefined}
          clearLabel="不设置默认模型"
        />
        <Button disabled={probing} onClick={() => void probeForDefault()}>
          <ArrowsClockwise size={12} className={probing ? "provider-spin" : ""} />
          {probing ? "探测中…" : "探测模型"}
        </Button>
        <Button disabled={testing} onClick={() => void testModel()}>
          <Play size={12} weight="fill" />
          {testing ? "测试中…" : "测试模型"}
        </Button>
      </div>
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

const PROTOCOL_CHOICES: LlmProtocol[] = ["anthropic", "openai"];

/**
 * 协议二选一。
 *
 * 原先它是「名称」右边一颗预选着 Anthropic 的 `<select>`:一个看起来已经填好的小控件
 * 没人会再点开,于是 codex 的中转站被存成 anthropic 协议,直到执行器那边的下拉里一个
 * 都挑不着才发现。所以改了两处 ——
 *
 * 1. **新建时不给默认值**(`""`),没选就存不下去(门禁在按钮和 `save` 两头);
 * 2. **按「这家供应商给谁用」来标**:协议名是实现细节,用户心里记着的是自己要跑哪个
 *    CLI。名单从 `PROVIDER_PROTOCOL` 反推(`agentsForProtocol`),不手抄第二份。
 *
 * 编辑已有供应商时照常带出原值,不逼人把已经选对的东西再选一遍。
 */
function ProtocolChoice({
  value,
  onChange,
}: {
  value: LlmProtocol | "";
  onChange: (protocol: LlmProtocol) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  // 单选组的键盘语义得自己补上:换掉的那颗原生 <select> 是能用方向键切的,两颗
  // 光挂 role="radio" 的按钮不是。做法照 WAI-ARIA 的 radiogroup —— 方向键换选,
  // 焦点只停在选中的那一颗上(没选中时停第一颗),Tab 一下整组进出。
  const move = (from: number, delta: number) => {
    const next = (from + delta + PROTOCOL_CHOICES.length) % PROTOCOL_CHOICES.length;
    onChange(PROTOCOL_CHOICES[next]);
    groupRef.current?.querySelectorAll("button")[next]?.focus();
  };
  const focusIndex = Math.max(0, PROTOCOL_CHOICES.indexOf(value as LlmProtocol));

  return (
    <div className="is-wide provider-protocol-pick">
      <span>协议</span>
      <div role="radiogroup" aria-label="协议" ref={groupRef}>
        {PROTOCOL_CHOICES.map((protocol, index) => (
          <button
            key={protocol}
            type="button"
            role="radio"
            aria-checked={value === protocol}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => onChange(protocol)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") move(index, 1);
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(index, -1);
              else return;
              event.preventDefault();
            }}
          >
            <b>{protocolLabel(protocol)}</b>
            <small>{agentsForProtocol(protocol).join(" · ")}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 供应商表单本体。导出是给首启向导用的(`src/onboarding/ProviderStep.tsx`):
 * 「添加供应商」这件事全应用只该有一份表单 —— 协议/BaseURL/Key/模型目录/1M 声明
 * 这几项的联动规则抄第二份的话,两边迟早说出不一样的话。
 */
export function ProviderForm({
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
    // 编辑已有的那一份照常带出原值 —— 逼人把已经选对的东西再选一遍不是引导,是刁难。
    protocol: provider?.protocol ?? "",
    baseUrl: provider?.baseUrl ?? "",
    apiKey: "",
    model: provider?.model ?? "",
    protocolConversionEnabled: provider?.protocolConversionEnabled ?? false,
    modelListMode: provider?.modelListMode ?? "api",
    pinnedModels: provider?.pinnedModels ?? [],
    context1mModels: provider?.context1mModels ?? [],
  });
  const [saving, setSaving] = useState(false);
  // 表单里三处要选模型（默认 / 固定 / 1M），共用这一份目录：在任意一处按
  // 「探测模型」，三处同时就绪，不必挨个再点一遍。
  const catalog = useProviderCatalog({
    providerId: provider?.id,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
  });

  const set = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => {
    setDraft((current) => ({
      ...current,
      [key]: value,
      ...(key === "protocol" && value === "anthropic" ? { protocolConversionEnabled: false } : {}),
    }));
  };

  const save = async () => {
    // 门禁同时落在按钮和这里(web/CLAUDE.md「主工作区」同款理由):只 disable 按钮的话,
    // 回车/程序化触发照样能把一条没选协议的记录存进去。
    if (!draft.protocol || !draft.name.trim() || !draft.baseUrl.trim()) return;
    const protocol = draft.protocol;
    setSaving(true);
    try {
      if (provider) {
        await api.patchLlmProvider(provider.id, {
          name: draft.name.trim(),
          protocol,
          baseUrl: draft.baseUrl.trim(),
          model: draft.model.trim(),
          protocolConversionEnabled: protocol === "openai" && draft.protocolConversionEnabled,
          modelListMode: draft.modelListMode,
          pinnedModels: draft.pinnedModels,
          context1mModels: protocol === "anthropic" ? draft.context1mModels : [],
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        });
        clearProviderModelCache(provider.id);
      } else {
        await api.createLlmProvider({
          name: draft.name.trim(),
          protocol,
          baseUrl: draft.baseUrl.trim(),
          apiKey: draft.apiKey.trim(),
          model: draft.model.trim(),
          protocolConversionEnabled: protocol === "openai" && draft.protocolConversionEnabled,
          modelListMode: draft.modelListMode,
          pinnedModels: draft.pinnedModels,
          context1mModels: protocol === "anthropic" ? draft.context1mModels : [],
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
        <ProtocolChoice value={draft.protocol} onChange={(protocol) => set("protocol", protocol)} />
        <label className="is-wide">
          <span>名称</span>
          <input value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder="例如 公司自建" />
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
        {/* 模型那几块等协议选完再出现:它们答不上话 —— 探模型目录要靠协议决定请求
            打哪条路径,1M 上下文声明又只有 anthropic 这边有。 */}
        {draft.protocol && (
          <>
            <ProviderModelField
              providerId={provider?.id}
              providerName={draft.name}
              protocol={draft.protocol}
              baseUrl={draft.baseUrl}
              apiKey={draft.apiKey}
              model={draft.model}
              knownModels={draft.pinnedModels}
              context1mModels={draft.context1mModels}
              protocolConversionEnabled={draft.protocolConversionEnabled}
              catalog={catalog}
              onModelChange={(model) => set("model", model)}
            />
            <ProviderPinnedModels
              providerId={provider?.id}
              protocol={draft.protocol}
              baseUrl={draft.baseUrl}
              apiKey={draft.apiKey}
              protocolConversionEnabled={draft.protocolConversionEnabled}
              catalog={catalog}
              mode={draft.modelListMode}
              pinned={draft.pinnedModels}
              onModeChange={(mode) => set("modelListMode", mode)}
              onPinnedChange={(models) => set("pinnedModels", models)}
            />
            {draft.protocol === "anthropic" && (
              <ProviderContext1mModels
                providerId={provider?.id}
                defaultModel={draft.model}
                pinnedModels={draft.pinnedModels}
                catalog={catalog}
                selectedModels={draft.context1mModels}
                onChange={(models) => set("context1mModels", models)}
              />
            )}
          </>
        )}
      </div>
      <div className="provider-form-actions">
        <Button variant="ghost" disabled={saving} onClick={onCancel}>取消</Button>
        <Button
          variant="primary"
          disabled={saving || !draft.protocol || !draft.name.trim() || !draft.baseUrl.trim()}
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
  // 收起表单后原地闪一下:列表长了以后,光靠 toast 找不回刚才改的是哪一行。
  const [justEdited, setJustEdited] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const flash = () => {
    setJustEdited(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setJustEdited(false), 2600);
  };

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

  return (
    <>
      <article className={`provider-row${justEdited ? " is-just-edited" : ""}${editing ? " is-editing" : ""}`}>
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
            {provider.context1mModels.length ? ` · ${provider.context1mModels.length} 个 1M` : ""}
          </small>
        </div>
        <span className={`provider-key-state${provider.hasKey ? " is-ready" : ""}`}>
          {provider.hasKey && <CheckCircle size={12} weight="fill" />}
          {provider.hasKey ? "Key 已保存" : "缺少 Key"}
        </span>
        <span className="provider-default-model">{provider.model || "未设默认模型"}</span>
        <button
          type="button"
          className="provider-icon-action"
          aria-pressed={editing}
          onClick={() => setEditing((open) => !open)}
          aria-label={editing ? `收起 ${provider.name} 的编辑表单` : `编辑 ${provider.name}`}
        >
          <PencilSimple size={14} />
        </button>
        <button type="button" className="settings-icon-danger" onClick={() => setConfirmDelete(true)} aria-label={`删除 ${provider.name}`}>
          <Trash size={14} />
        </button>
      </article>
      {editing && (
        <ProviderForm
          provider={provider}
          notify={notify}
          onCancel={() => { setEditing(false); flash(); }}
          onSaved={async () => {
            await onChanged();
            setEditing(false);
            flash();
            notify(`供应商「${provider.name}」已更新`);
          }}
        />
      )}
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
