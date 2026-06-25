import { useEffect, useState } from "react";
import type { LlmProvider, LlmProtocol } from "@harness/shared";
import { Plus, Trash, PencilSimple, ArrowsClockwise } from "@phosphor-icons/react";
import { api } from "./api";
import { useEscape } from "./useEscape";

// System-level settings. Home for global config that isn't tied to a project —
// currently the direct-LLM 「中转站」 connections used for issue parsing.
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]" onClick={onClose}>
      <div
        className="flex max-h-[82vh] w-[680px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">设置</h2>
          <button onClick={onClose} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink">
            关闭 <kbd>Esc</kbd>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <LlmConnections />
        </div>
      </div>
    </div>
  );
}

// ── 大模型连接（中转站，系统级）— 给事项「直连大模型」解析用，执行不走它 ─────────
function LlmConnections() {
  const [list, setList] = useState<LlmProvider[]>([]);
  const reload = () => api.llmProviders().then(setList).catch(() => {});
  useEffect(() => {
    reload();
  }, []);
  return (
    <div>
      <div className="mb-1 text-[12px] font-semibold text-ink">大模型连接 · 中转站</div>
      <div className="mb-3 text-[11px] text-faint">
        给事项的「直连大模型」解析用:填网址(baseUrl)+ API Key + 模型,按协议连(官方端点或中转站都行)。系统级,所有项目共用。执行不用它(执行只走本地 CLI 智能体)。
      </div>
      {list.map((p) => (
        <LlmRow key={p.id} p={p} onChange={reload} />
      ))}
      <AddLlm onAdded={reload} />
    </div>
  );
}

function LlmRow({ p, onChange }: { p: LlmProvider; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <EditLlm p={p} onDone={() => { setEditing(false); onChange(); }} onCancel={() => setEditing(false)} />;
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px]">
      <span className="font-medium text-ink">{p.name}</span>
      <span className="rounded bg-overlay px-1.5 py-0.5 text-[11px] text-muted">{p.protocol === "anthropic" ? "Anthropic" : "OpenAI"}</span>
      <span className="max-w-[240px] truncate font-mono text-[11px] text-faint">{p.baseUrl}</span>
      {p.model ? (
        <span className="shrink-0 text-muted">· 默认 {p.model}</span>
      ) : (
        <span className="shrink-0 text-amber-600">· 未设默认模型</span>
      )}
      <span className={`shrink-0 text-[11px] ${p.hasKey ? "text-emerald-600" : "text-amber-600"}`}>{p.hasKey ? "key ✓" : "缺 key"}</span>
      <button
        onClick={() => setEditing(true)}
        className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded text-faint hover:bg-raised hover:text-ink"
        title="编辑 / 配模型"
      >
        <PencilSimple size={13} />
      </button>
      <button
        onClick={() => api.deleteLlmProvider(p.id).then(onChange)}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-faint hover:bg-raised hover:text-red-600"
        title="删除"
      >
        <Trash size={13} />
      </button>
    </div>
  );
}

// Pick the default model for a connection: either fetch the live list (拉取模型)
// and choose from a dropdown, or type one manually. `providerId` lets an existing
// row reuse its stored key without re-typing it.
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
      if (!res.models.length) setErr("该连接未返回模型");
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
          placeholder="默认模型（如 gpt-4o / claude-3-5-sonnet）"
          className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint"
        />
        <button
          onClick={fetchModels}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 text-muted hover:bg-raised hover:text-ink disabled:opacity-50"
          title="从该连接拉取可用模型列表"
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

// Edit an existing connection — change the default model (with 拉取模型), name,
// baseUrl, or rotate the key. Leaving the key blank keeps the stored one.
function EditLlm({ p, onDone, onCancel }: { p: LlmProvider; onDone: () => void; onCancel: () => void }) {
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
    <div className="mb-1.5 flex max-w-[460px] flex-col gap-1.5 rounded-md border border-accent/50 p-2 text-[12px]">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" className="rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <div className="flex gap-1.5">
        <select value={protocol} onChange={(e) => setProtocol(e.target.value as LlmProtocol)} className="rounded border border-line bg-canvas px-2 py-1 outline-none">
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic 兼容</option>
        </select>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="网址 baseUrl" className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 font-mono outline-none placeholder:text-faint" />
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

function AddLlm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<LlmProtocol>("openai");
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
        <Plus size={12} weight="bold" /> 添加连接
      </button>
    );
  return (
    <div className="mt-1 flex max-w-[460px] flex-col gap-1.5 rounded-md border border-line p-2 text-[12px]">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称（如 中转-opus）" className="rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <div className="flex gap-1.5">
        <select value={protocol} onChange={(e) => setProtocol(e.target.value as LlmProtocol)} className="rounded border border-line bg-canvas px-2 py-1 outline-none">
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic 兼容</option>
        </select>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="网址 baseUrl（如 https://your-relay.com/v1）" className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 font-mono outline-none placeholder:text-faint" />
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
