import { useState } from "react";
import type { LlmProvider, LlmProtocol } from "@harness/shared";
import { Plus, Trash, PencilSimple, ArrowsClockwise } from "@phosphor-icons/react";
import { api } from "./api";
import { ConfirmModal } from "./Modal";

// 中转站(relay)的增删改查。中转站不是「另一种后端」——它只是挂到执行者上的
// base_url + key,替换 CLI 自己的官方登录账号。harness 不直连它跑推理。
// 列表 state 由 AgentsPanel 持有(执行者行的「中转站」下拉也要用),这里只负责渲染 + 改完回调。
export function RelaySection({ list, onChange }: { list: LlmProvider[]; onChange: () => void }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">中转站</div>
      <div className="mb-2.5 text-[11px] text-faint">
        填网址 + API Key,再在上面任一执行者的「中转站」下拉里挂上——那个执行者就改用中转站的额度和模型跑,
        不再走 CLI 的官方登录账号。Anthropic 协议给 claude 用,OpenAI 协议给 codex 用。
      </div>
      {list.map((p) => (
        <RelayRow key={p.id} p={p} onChange={onChange} />
      ))}
      <AddRelay onAdded={onChange} />
    </div>
  );
}

function RelayRow({ p, onChange }: { p: LlmProvider; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (editing) return <EditRelay p={p} onDone={() => { setEditing(false); onChange(); }} onCancel={() => setEditing(false)} />;
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px]">
      <span className="shrink-0 font-medium text-ink">{p.name}</span>
      <span className="shrink-0 rounded bg-overlay px-1.5 py-0.5 text-[11px] text-muted">{p.protocol === "anthropic" ? "Anthropic" : "OpenAI"}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-faint">{p.baseUrl}</span>
      <span className={`shrink-0 text-[11px] ${p.hasKey ? "text-emerald-600" : "text-amber-600"}`}>{p.hasKey ? "key ✓" : "缺 key"}</span>
      <button
        onClick={() => setEditing(true)}
        className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded text-faint hover:bg-raised hover:text-ink"
        title="编辑"
      >
        <PencilSimple size={13} />
      </button>
      <button
        onClick={() => setConfirming(true)}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-faint hover:bg-raised hover:text-red-600"
        title="删除"
      >
        <Trash size={13} />
      </button>
      {confirming && (
        <ConfirmModal
          title="删除中转站"
          message={`删除「${p.name}」后,挂着它的执行者会退回 CLI 官方登录账号。`}
          confirmLabel="删除"
          danger
          onConfirm={() => api.deleteLlmProvider(p.id).then(onChange)}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

// 「拉取模型」按钮:探一下这个中转站活不活、有哪些模型可用。存下来的 model 只是
// 备注性质的默认值(执行者自己的「模型」下拉才是实际生效的),但拉一次能立刻验证配置对不对。
// providerId 让已存在的行复用库里的 key,不必重新输入。
function ModelField({
  protocol,
  baseUrl,
  apiKey,
  providerId,
  model,
  setModel,
}: {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  providerId?: string;
  model: string;
  setModel: (m: string) => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fetchModels = async () => {
    if (!baseUrl.trim()) {
      setErr("先填网址 baseUrl");
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const res = await api.probeModels({ protocol, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, id: providerId });
      setModels(res.models);
      if (!res.models.length) setErr("该中转站未返回模型");
      else if (!model) setModel(res.models[0]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1.5">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="默认模型（可选，执行者的「模型」下拉优先）"
          className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint"
        />
        <button
          onClick={fetchModels}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 text-muted hover:bg-raised hover:text-ink disabled:opacity-50"
          title="从该中转站拉取可用模型列表（顺带验证网址和 key 对不对）"
        >
          <ArrowsClockwise size={12} className={loading ? "animate-spin" : ""} /> {loading ? "拉取中…" : "拉取模型"}
        </button>
      </div>
      {models && models.length > 0 && (
        <select
          value={models.includes(model) ? model : ""}
          onChange={(e) => setModel(e.target.value)}
          className="rounded border border-line bg-canvas px-2 py-1 outline-none"
        >
          <option value="" disabled>
            选一个作默认模型（共 {models.length} 个）
          </option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      )}
      {err && <span className="text-[11px] text-red-600">{err}</span>}
    </div>
  );
}

// 编辑已有中转站——改名称 / 网址 / 协议 / 默认模型,或换 key(留空=保持库里那把)。
function EditRelay({ p, onDone, onCancel }: { p: LlmProvider; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(p.name);
  const [protocol, setProtocol] = useState<LlmProtocol>(p.protocol);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(p.model);
  const save = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    await api.patchLlmProvider(p.id, {
      name: name.trim(),
      protocol,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    onDone();
  };
  return (
    <div className="mb-1.5 flex flex-col gap-1.5 rounded-md border border-accent/50 p-2 text-[12px]">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" className="rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <div className="flex gap-1.5">
        <select value={protocol} onChange={(e) => setProtocol(e.target.value as LlmProtocol)} className="rounded border border-line bg-canvas px-2 py-1 outline-none">
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic 兼容</option>
        </select>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="网址（根地址，不含 /v1）" className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 font-mono outline-none placeholder:text-faint" />
      </div>
      <ModelField protocol={protocol} baseUrl={baseUrl} apiKey={apiKey} providerId={p.id} model={model} setModel={setModel} />
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={p.hasKey ? "API Key（留空＝保持不变）" : "API Key"}
        className="rounded border border-line bg-canvas px-2 py-1 font-mono outline-none placeholder:text-faint"
      />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-2 py-1 text-muted">取消</button>
        <button onClick={save} disabled={!name.trim() || !baseUrl.trim()} className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">保存</button>
      </div>
    </div>
  );
}

function AddRelay({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<LlmProtocol>("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const add = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    await api.createLlmProvider({ name: name.trim(), protocol, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() });
    setName("");
    setBaseUrl("");
    setApiKey("");
    setModel("");
    setOpen(false);
    onAdded();
  };
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="mt-1 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
        <Plus size={12} weight="bold" /> 添加中转站
      </button>
    );
  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-line p-2 text-[12px]">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称（如 公司中转）" className="rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <div className="flex gap-1.5">
        <select value={protocol} onChange={(e) => setProtocol(e.target.value as LlmProtocol)} className="rounded border border-line bg-canvas px-2 py-1 outline-none">
          <option value="anthropic">Anthropic 兼容（给 claude 用）</option>
          <option value="openai">OpenAI 兼容（给 codex 用）</option>
        </select>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="网址（如 https://your-relay.com，不含 /v1）" className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 font-mono outline-none placeholder:text-faint" />
      </div>
      <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key" className="rounded border border-line bg-canvas px-2 py-1 font-mono outline-none placeholder:text-faint" />
      <ModelField protocol={protocol} baseUrl={baseUrl} apiKey={apiKey} model={model} setModel={setModel} />
      <div className="flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="px-2 py-1 text-muted">取消</button>
        <button onClick={add} disabled={!name.trim() || !baseUrl.trim()} className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">添加</button>
      </div>
    </div>
  );
}
