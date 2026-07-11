import { useEffect, useState } from "react";
import type { AgentExecutorProfile, AgentType, ExecTarget } from "@harness/shared";
import { MagnifyingGlass, Check, X, Plus, Trash, CircleNotch } from "@phosphor-icons/react";
import { api } from "./api";
import { Menu } from "./Menu";
import { useEscape } from "./useEscape";

const TYPES: AgentType[] = ["claude", "codex", "antigravity"];

// 速度档(§5):标准=不传参、跟随 CLI 默认;1.5x=加速档,executor 各自映射
// (codex: -c service_tier="priority";claude: --settings '{"fastMode": true}',仅 Opus 生效)。
const SPEED_OPTIONS = [
  { value: "standard", label: "标准", detail: "跟随 CLI 默认速度" },
  { value: "fast", label: "1.5x", detail: "加速档（用量消耗更快）" },
];

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
        </div>
      </div>
    </div>
  );
}

function targetText(t: ExecTarget) {
  return t.kind === "ssh" ? `ssh ${t.host}` : "本地";
}

function Row({ a, onChange }: { a: AgentExecutorProfile; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState("");
  const [argsEditing, setArgsEditing] = useState(false);
  const [argsText, setArgsText] = useState("");

  // 已注册的执行者也能随时改模型(检测注册进来的默认没填):点模型原地编辑,
  // Enter/失焦保存,Esc 取消(stopPropagation 免得连面板一起关),留空=清掉、
  // 回到 CLI 自己的默认模型(后端 PATCH 把空串落成 null)。
  const save = async () => {
    setEditing(false);
    const next = model.trim();
    if (next === (a.model ?? "")) return;
    await api.patchAgent(a.id, { model: next });
    onChange();
  };

  // 额外 CLI 参数同款原地编辑:按空白拆成参数数组随命令行传给 CLI(如
  // `-c model_reasoning_effort=xhigh`),留空=清掉。带空格的值 CLI 侧多为
  // key=value 形态,不做引号解析。
  const extra = a.extraArgs ?? [];
  const saveArgs = async () => {
    setArgsEditing(false);
    const next = argsText.trim() ? argsText.trim().split(/\s+/) : [];
    if (next.join(" ") === extra.join(" ")) return;
    await api.patchAgent(a.id, { extraArgs: next });
    onChange();
  };

  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px]">
      <span className="font-medium text-ink">{a.name}</span>
      <span className="text-muted">{targetText(a.target)}</span>
      {editing ? (
        <input
          autoFocus
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") save();
            else if (e.key === "Escape") setEditing(false);
          }}
          placeholder="如 opus；留空用 CLI 默认"
          className="w-44 rounded border border-line bg-canvas px-1.5 py-0.5 text-[11px] outline-none placeholder:text-faint"
        />
      ) : (
        <button
          onClick={() => {
            setModel(a.model ?? "");
            setEditing(true);
          }}
          title="指定模型（留空用 CLI 默认）"
          className={a.model ? "text-muted hover:text-ink" : "rounded border border-dashed border-line px-1.5 py-0.5 text-[11px] text-faint hover:text-ink"}
        >
          {a.model ? `· ${a.model}` : "+ 模型"}
        </button>
      )}
      <Menu
        options={SPEED_OPTIONS}
        value={a.speed ?? "standard"}
        onChange={(v) => api.patchAgent(a.id, { speed: v as "standard" | "fast" }).then(onChange)}
        menuWidth={220}
        triggerClassName={
          a.speed === "fast"
            ? "shrink-0 whitespace-nowrap text-[11px] text-muted hover:text-ink"
            : "shrink-0 whitespace-nowrap rounded border border-dashed border-line px-1.5 py-0.5 text-[11px] text-faint hover:text-ink"
        }
      >
        <span title="速度档（1.5x 加速消耗用量更快）">{a.speed === "fast" ? "· 1.5x" : "标准"}</span>
      </Menu>
      {argsEditing ? (
        <input
          autoFocus
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          onBlur={saveArgs}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") saveArgs();
            else if (e.key === "Escape") setArgsEditing(false);
          }}
          placeholder="如 -c model_reasoning_effort=xhigh"
          className="w-56 rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] outline-none placeholder:text-faint"
        />
      ) : (
        <button
          onClick={() => {
            setArgsText(extra.join(" "));
            setArgsEditing(true);
          }}
          title="额外 CLI 参数，按空格分隔（留空清掉）"
          className={extra.length ? "max-w-56 truncate font-mono text-[11px] text-muted hover:text-ink" : "rounded border border-dashed border-line px-1.5 py-0.5 text-[11px] text-faint hover:text-ink"}
        >
          {extra.length ? extra.join(" ") : "+ 参数"}
        </button>
      )}
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
  const [args, setArgs] = useState("");
  const [speed, setSpeed] = useState<"standard" | "fast">("standard");
  const [host, setHost] = useState("");

  const add = async () => {
    const target: ExecTarget = host.trim() ? { kind: "ssh", host: host.trim() } : { kind: "local" };
    await api.createAgent({
      type,
      name: name.trim() || `${type}@${host.trim() || "local"}${model ? "·" + model : ""}`,
      model: model.trim() || undefined,
      extraArgs: args.trim() ? args.trim().split(/\s+/) : undefined,
      speed: speed === "fast" ? "fast" : undefined,
      target,
      isDefault: false,
    });
    setName("");
    setModel("");
    setArgs("");
    setSpeed("standard");
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
      <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="额外 CLI 参数（可选，空格分隔）" className="rounded border border-line bg-canvas px-2 py-1 font-mono outline-none placeholder:text-faint" />
      <div className="flex items-center gap-2">
        <span className="text-muted">速度</span>
        <Menu
          options={SPEED_OPTIONS}
          value={speed}
          onChange={(v) => setSpeed(v as "standard" | "fast")}
          menuWidth={220}
          triggerClassName="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:text-ink"
        >
          {speed === "fast" ? "1.5x" : "标准"}
        </Menu>
      </div>
      <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ssh 主机（留空=本地）" className="rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <div className="flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="px-2 py-1 text-muted">取消</button>
        <button onClick={add} className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg hover:bg-accent-hover">添加</button>
      </div>
    </div>
  );
}
