import { useEffect, useState } from "react";
import type { LlmProvider, LlmProtocol } from "@harness/shared";
import { Plus, Trash } from "@phosphor-icons/react";
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
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px]">
      <span className="font-medium text-ink">{p.name}</span>
      <span className="rounded bg-overlay px-1.5 py-0.5 text-[11px] text-muted">{p.protocol === "anthropic" ? "Anthropic" : "OpenAI"}</span>
      <span className="max-w-[260px] truncate font-mono text-[11px] text-faint">{p.baseUrl}</span>
      {p.model && <span className="shrink-0 text-muted">· {p.model}</span>}
      <span className={`shrink-0 text-[11px] ${p.hasKey ? "text-emerald-600" : "text-amber-600"}`}>{p.hasKey ? "key ✓" : "缺 key"}</span>
      <button
        onClick={() => api.deleteLlmProvider(p.id).then(onChange)}
        className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded text-faint hover:bg-raised hover:text-red-600"
        title="删除"
      >
        <Trash size={13} />
      </button>
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
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型（如 gpt-4o / claude-3-5-sonnet）" className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      </div>
      <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="网址 baseUrl（如 https://your-relay.com/v1）" className="rounded border border-line bg-canvas px-2 py-1 font-mono outline-none placeholder:text-faint" />
      <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key" className="rounded border border-line bg-canvas px-2 py-1 font-mono outline-none placeholder:text-faint" />
      <div className="flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="px-2 py-1 text-muted">取消</button>
        <button onClick={add} disabled={!name.trim() || !baseUrl.trim()} className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">添加</button>
      </div>
    </div>
  );
}
