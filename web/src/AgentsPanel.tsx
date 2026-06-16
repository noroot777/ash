import { useEffect, useState } from "react";
import type { AgentExecutorProfile, AgentType, ExecTarget } from "@harness/shared";
import { api } from "./api";

const TYPES: AgentType[] = ["claude", "codex", "antigravity"];

// Agent registry management (DESIGN.md §5): executor profiles under each type,
// with a per-type default and local/ssh target.
export function AgentsPanel({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<AgentExecutorProfile[]>([]);
  const reload = () => api.agents().then(setList);
  useEffect(() => {
    reload();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh]" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium">智能体执行器</h2>
          <button onClick={onClose} className="text-xs text-muted hover:text-ink">关闭 Esc</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {TYPES.map((type) => {
            const profiles = list.filter((a) => a.type === type);
            return (
              <div key={type} className="mb-5">
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">{type}</div>
                {profiles.length === 0 && (
                  <p className="mb-1 text-xs text-faint">
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
      </div>
    </div>
  );
}

function targetText(t: ExecTarget) {
  return t.kind === "ssh" ? `ssh ${t.host}` : "本地";
}

function Row({ a, onChange }: { a: AgentExecutorProfile; onChange: () => void }) {
  return (
    <div className="mb-1 flex items-center gap-2 rounded-md border border-line bg-raised/40 px-2.5 py-1.5 text-xs">
      <span className="font-medium text-ink">{a.name}</span>
      <span className="text-muted">{targetText(a.target)}</span>
      {a.model && <span className="text-muted">· {a.model}</span>}
      {a.isDefault ? (
        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-700">默认</span>
      ) : (
        <button
          onClick={() => api.patchAgent(a.id, { isDefault: true }).then(onChange)}
          className="rounded border border-line2 px-1.5 py-0.5 text-muted hover:text-ink"
        >
          设为默认
        </button>
      )}
      <button
        onClick={() => api.deleteAgent(a.id).then(onChange)}
        className="ml-auto text-faint hover:text-red-600"
      >
        删除
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
      <button onClick={() => setOpen(true)} className="text-xs text-muted hover:text-ink">
        + 添加执行者
      </button>
    );

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-md border border-line p-2 text-xs">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称（可选）" className="w-28 rounded bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型（可选）" className="w-28 rounded bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ssh 主机（留空=本地）" className="w-36 rounded bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <button onClick={add} className="rounded bg-accent hover:bg-accent-hover px-2 py-1 font-medium text-accent-fg">添加</button>
      <button onClick={() => setOpen(false)} className="px-2 py-1 text-muted">取消</button>
    </div>
  );
}
