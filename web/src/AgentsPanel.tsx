import { useEffect, useState } from "react";
import type { AgentExecutorProfile, AgentType, ExecTarget, LlmProvider, LlmProtocol } from "@harness/shared";
import { MagnifyingGlass, Check, X, Plus, Trash, CircleNotch } from "@phosphor-icons/react";
import { api } from "./api";
import { useEscape } from "./useEscape";

const TYPES: AgentType[] = ["claude", "codex", "antigravity"];

type Detected = { type: string; bin: string; available: boolean; path: string | null; version: string | null };

// Agent registry management (DESIGN.md §5): executor profiles under each type,
// per-type default, local/ssh target, plus local-CLI detection.
export function AgentsPanel({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<AgentExecutorProfile[]>([]);
  const [detected, setDetected] = useState<Detected[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const reload = () => api.agents().then(setList);
  useEscape(onClose);
  useEffect(() => {
    reload();
  }, []);

  const detect = async () => {
    setDetecting(true);
    try {
      setDetected(await api.detectAgents());
    } finally {
      setDetecting(false);
    }
  };

  const registerDetected = async (d: Detected) => {
    const hasAny = list.some((a) => a.type === d.type);
    await api.createAgent({
      type: d.type as AgentType,
      name: `${d.type}@local`,
      target: { kind: "local" },
      isDefault: !hasAny,
    });
    reload();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]" onClick={onClose}>
      <div
        className="flex max-h-[82vh] w-[860px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">智能体执行器</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={detect}
              disabled={detecting}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink transition-colors hover:bg-raised disabled:opacity-50"
            >
              {detecting ? <CircleNotch size={13} className="animate-spin" /> : <MagnifyingGlass size={13} />}
              检测本地智能体
            </button>
            <button onClick={onClose} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink">
              关闭 <kbd>Esc</kbd>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {detected && (
            <div className="mb-5 rounded-lg border border-line bg-raised/50 p-3">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">本地检测结果</div>
              <div className="grid gap-1.5">
                {detected.map((d) => {
                  const registered = list.some((a) => a.type === d.type && a.target.kind === "local");
                  return (
                    <div key={d.type} className="flex items-center gap-2 text-[12px]">
                      {d.available ? (
                        <Check size={14} weight="bold" className="text-emerald-600" />
                      ) : (
                        <X size={14} weight="bold" className="text-faint" />
                      )}
                      <span className="w-24 font-medium text-ink">{d.type}</span>
                      {d.available ? (
                        <>
                          <span className="truncate font-mono text-[11px] text-muted">{d.path}</span>
                          {d.version && <span className="shrink-0 font-mono text-[11px] text-faint">{d.version}</span>}
                          <span className="ml-auto shrink-0">
                            {registered ? (
                              <span className="text-[11px] text-faint">已注册</span>
                            ) : (
                              <button
                                onClick={() => registerDetected(d)}
                                className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg hover:bg-accent-hover"
                              >
                                <Plus size={11} weight="bold" /> 注册为执行者
                              </button>
                            )}
                          </span>
                        </>
                      ) : (
                        <span className="text-faint">未安装</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            {TYPES.map((type) => {
              const profiles = list.filter((a) => a.type === type);
              return (
                <div key={type}>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{type}</div>
                  {profiles.length === 0 && (
                    <p className="mb-1 text-[12px] text-faint">
                      {type === "antigravity" ? "无内置解析器；待该 CLI 可用后支持" : "未配置 · 将用内置本地默认执行者"}
                    </p>
                  )}
                  {profiles.map((a) => (
                    <Row key={a.id} a={a} onChange={reload} />
                  ))}
                  {type !== "antigravity" && <AddRow type={type} onAdded={reload} />}
                </div>
              );
            })}
          </div>
          <LlmConnections />
        </div>
      </div>
    </div>
  );
}

function targetText(t: ExecTarget) {
  return t.kind === "ssh" ? `ssh ${t.host}` : "本地";
}

function Row({ a, onChange }: { a: AgentExecutorProfile; onChange: () => void }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px]">
      <span className="font-medium text-ink">{a.name}</span>
      <span className="text-muted">{targetText(a.target)}</span>
      {a.model && <span className="text-muted">· {a.model}</span>}
      {a.isDefault ? (
        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700">默认</span>
      ) : (
        <button
          onClick={() => api.patchAgent(a.id, { isDefault: true }).then(onChange)}
          className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:text-ink"
        >
          设为默认
        </button>
      )}
      <button
        onClick={() => api.deleteAgent(a.id).then(onChange)}
        className="ml-auto grid h-6 w-6 place-items-center rounded text-faint hover:bg-raised hover:text-red-600"
        title="删除"
      >
        <Trash size={13} />
      </button>
    </div>
  );
}

function AddRow({ type, onAdded }: { type: AgentType; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [host, setHost] = useState("");

  const add = async () => {
    const target: ExecTarget = host.trim() ? { kind: "ssh", host: host.trim() } : { kind: "local" };
    await api.createAgent({
      type,
      name: name.trim() || `${type}@${host.trim() || "local"}${model ? "·" + model : ""}`,
      model: model.trim() || undefined,
      target,
      isDefault: false,
    });
    setName("");
    setModel("");
    setHost("");
    setOpen(false);
    onAdded();
  };

  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
        <Plus size={12} weight="bold" /> 添加执行者
      </button>
    );

  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-line p-2 text-[12px]">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称（可选）" className="rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型（可选，如 opus）" className="rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ssh 主机（留空=本地）" className="rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <div className="flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="px-2 py-1 text-muted">取消</button>
        <button onClick={add} className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg hover:bg-accent-hover">添加</button>
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
    <div className="mt-6 border-t border-line pt-5">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">大模型连接 · 中转站</div>
      <div className="mb-2.5 text-[11px] text-faint">
        给事项的「直连大模型」解析用:填网址(baseUrl)+ API Key + 模型,按协议连(官方或中转站都行)。系统级,所有项目共用。执行不用它(执行只走本地 CLI 智能体)。
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
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
        <Plus size={12} weight="bold" /> 添加连接
      </button>
    );
  return (
    <div className="mt-1 flex max-w-[440px] flex-col gap-1.5 rounded-md border border-line p-2 text-[12px]">
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
