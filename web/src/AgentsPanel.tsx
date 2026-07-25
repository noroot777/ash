import { useEffect, useState } from "react";
import type { AgentExecutorProfile, AgentType, ExecTarget, LlmProtocol, LlmProvider } from "@harness/shared";
import { MagnifyingGlass, Check, X, Plus, Trash, CircleNotch } from "@phosphor-icons/react";
import { api } from "./api";
import { Menu, type MenuOption } from "./Menu";
import { RelaySection } from "./Relays";
import { useEscape } from "./useEscape";

const TYPES: AgentType[] = ["claude", "codex", "antigravity"];

// 哪种协议的中转站能挂给哪个 CLI:claude 认 Anthropic 端点,codex 认 OpenAI 端点。
// null = 该类型不支持挂中转站(antigravity 无执行器实现)。
const RELAY_PROTOCOL: Record<AgentType, LlmProtocol | null> = {
  claude: "anthropic",
  codex: "openai",
  antigravity: null,
};

// ── 可选配置项(§5)────────────────────────────────────────────────────────
// 原则:常用参数全部页面可选,不逼用户手写 CLI 参数;extraArgs 仅作兜底。
// 每组第一项 value="" = 不传参、跟随 CLI 自己的默认。

// 模型预设按 type 给常用值;下拉 header 里可自由输入任意模型名。
const MODEL_PRESETS: Record<AgentType, string[]> = {
  claude: ["opus", "sonnet", "haiku", "fable"],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
  antigravity: [],
};

// 推理强度:claude --effort(无 ultra);codex -c model_reasoning_effort。
// 模型不支持的档位会被 API 拒绝(如 gpt-5.5 最高 xhigh、ultra 仅 gpt-5.6-sol/terra)。
const EFFORT_VALUES: Record<AgentType, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "ultra", "max"],
  antigravity: [],
};
const EFFORT_DETAIL: Record<string, string> = {
  xhigh: "gpt-5.5 支持的最高档",
  ultra: "仅 gpt-5.6-sol/terra 等新模型支持",
};

// 速度档:标准=不传参;1.5x=加速档(codex: -c service_tier="priority";
// claude: --settings '{"fastMode": true}',仅 Opus 生效)。
const SPEED_OPTIONS: MenuOption[] = [
  { value: "standard", label: "标准", detail: "跟随 CLI 默认速度" },
  { value: "fast", label: "1.5x", detail: "加速档（用量消耗更快）" },
];

const withDefault = (values: string[], detail = "跟随 CLI 默认"): MenuOption[] => [
  { value: "", label: "默认", detail },
  ...values.map((v) => ({ value: v, label: v, detail: EFFORT_DETAIL[v] })),
];

type Detected = { type: string; bin: string; available: boolean; path: string | null; version: string | null };

// Agent registry management (DESIGN.md §5): executor profiles under each type,
// per-type default, local/ssh target, plus local-CLI detection.
export function AgentsPanel({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<AgentExecutorProfile[]>([]);
  const [relays, setRelays] = useState<LlmProvider[]>([]);
  const [detected, setDetected] = useState<Detected[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  // 本机装了哪些 CLI。null=还没探完(先按「只显示已注册的」渲染,避免闪一下又消失)。
  // 与 detected 分开:detected 只在用户手动点「检测」时出结果面板,这个是静默的渲染依据。
  const [avail, setAvail] = useState<Set<string> | null>(null);
  const reload = () => api.agents().then(setList);
  // 删中转站会把挂着它的执行者置回官方账号(服务端做的),所以中转站变了要连执行者一起刷。
  const reloadRelays = () => Promise.all([api.llmProviders().then(setRelays), reload()]).catch(() => {});
  const probe = () =>
    api.detectAgents().then((d) => {
      setAvail(new Set(d.filter((x) => x.available).map((x) => x.type)));
      return d;
    });
  useEscape(onClose);
  useEffect(() => {
    reload();
    api.llmProviders().then(setRelays).catch(() => {});
    probe().catch(() => setAvail(new Set()));
  }, []);

  const detect = async () => {
    setDetecting(true);
    try {
      setDetected(await probe());
    } finally {
      setDetecting(false);
    }
  };

  // 只列「本机装了的」和「已经注册过执行者的」类型 —— 没装的 CLI 摆在这儿只是灰噪声,
  // 想用得先装。已注册的恒显示(可能是 ssh 远端执行者,本机自然探不到)。
  const shownTypes = TYPES.filter((t) => list.some((a) => a.type === t) || avail?.has(t));

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
            {shownTypes.map((type) => {
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
                    <Row key={a.id} a={a} relays={relays} onChange={reload} />
                  ))}
                  {type !== "antigravity" && <AddRow type={type} relays={relays} onAdded={reload} />}
                </div>
              );
            })}
          </div>
          {shownTypes.length === 0 && (
            <p className="text-[12px] text-faint">
              {avail === null ? "检测本地智能体中…" : "本机没找到已安装的智能体 CLI（claude / codex）。装好后点右上角「检测本地智能体」。"}
            </p>
          )}

          <div className="mt-5 border-t border-line pt-4">
            <RelaySection list={relays} onChange={reloadRelays} />
          </div>
        </div>
      </div>
    </div>
  );
}

function targetText(t: ExecTarget) {
  return t.kind === "ssh" ? `ssh ${t.host}` : "本地";
}

// 属性 chip:带 faint 标签 + 当前值;未设置时整体虚线灰。
const chipClass = (set: boolean) =>
  `inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] transition-colors hover:text-ink ${
    set ? "border-line text-ink" : "border-dashed border-line text-faint"
  }`;

function ChipLabel({ label, value }: { label: string; value?: string }) {
  return (
    <>
      <span className="text-faint">{label}</span>
      {value && <span>{value}</span>}
    </>
  );
}

// 模型下拉:预设 + header 自由输入(Enter 提交)。
function ModelMenu({ type, value, onPick }: { type: AgentType; value?: string; onPick: (v: string) => void }) {
  return (
    <Menu
      options={withDefault(MODEL_PRESETS[type], "跟随 CLI 配置的默认模型")}
      value={value ?? ""}
      onChange={onPick}
      menuWidth={230}
      triggerClassName={chipClass(!!value)}
      header={({ select }) => (
        <input
          placeholder="自定义模型名，Enter 确认"
          defaultValue={value ?? ""}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") select((e.target as HTMLInputElement).value.trim());
          }}
          className="w-full rounded border border-line bg-canvas px-1.5 py-1 text-[12px] outline-none placeholder:text-faint"
        />
      )}
    >
      <ChipLabel label="模型" value={value} />
    </Menu>
  );
}

// 中转站下拉:默认「官方账号」(不注入 env,CLI 用自己登录的账号)+ 协议匹配的中转站。
// 挂上后该执行者的每次运行都注入 base_url + key,执行任务和解析事项都走中转站。
function RelayMenu({
  type,
  relays,
  value,
  onPick,
}: {
  type: AgentType;
  relays: LlmProvider[];
  value?: string | null;
  onPick: (v: string) => void;
}) {
  const protocol = RELAY_PROTOCOL[type];
  if (!protocol) return null;
  const usable = relays.filter((r) => r.protocol === protocol);
  const current = usable.find((r) => r.id === value);
  const options: MenuOption[] = [
    { value: "", label: "官方账号", detail: `跟随 ${type} CLI 自己登录的账号` },
    ...usable.map((r) => ({ value: r.id, label: r.name, detail: r.hasKey ? r.baseUrl : "缺 key，挂上也连不通" })),
  ];
  return (
    <Menu
      options={options}
      value={value ?? ""}
      onChange={onPick}
      menuWidth={260}
      triggerClassName={chipClass(!!value)}
      header={
        usable.length === 0
          ? () => (
              <div className="px-1.5 py-1 text-[11px] text-faint">
                还没有 {protocol === "anthropic" ? "Anthropic" : "OpenAI"} 协议的中转站，去下面「中转站」里加
              </div>
            )
          : undefined
      }
    >
      <ChipLabel label="中转站" value={value ? current?.name ?? "已失效" : undefined} />
    </Menu>
  );
}

function Row({ a, relays, onChange }: { a: AgentExecutorProfile; relays: LlmProvider[]; onChange: () => void }) {
  const [argsEditing, setArgsEditing] = useState(false);
  const [argsText, setArgsText] = useState("");

  const patch = (p: Partial<AgentExecutorProfile>) => api.patchAgent(a.id, p).then(onChange);

  // 额外 CLI 参数(兜底,常用参数请用左侧下拉):按空白拆成参数数组随命令行
  // 传给 CLI,留空=清掉。带空格的值 CLI 侧多为 key=value 形态,不做引号解析。
  const extra = a.extraArgs ?? [];
  const saveArgs = async () => {
    setArgsEditing(false);
    const next = argsText.trim() ? argsText.trim().split(/\s+/) : [];
    if (next.join(" ") === extra.join(" ")) return;
    await patch({ extraArgs: next });
  };

  return (
    <div className="mb-1.5 rounded-md border border-line bg-panel px-2.5 py-2 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="truncate font-medium text-ink" title={a.name}>{a.name}</span>
        <span className="shrink-0 text-muted">{targetText(a.target)}</span>
        {a.isDefault ? (
          <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700">默认</span>
        ) : (
          <button
            onClick={() => patch({ isDefault: true })}
            className="shrink-0 whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:text-ink"
          >
            设为默认
          </button>
        )}
        <button
          onClick={() => api.deleteAgent(a.id).then(onChange)}
          className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded text-faint hover:bg-raised hover:text-red-600"
          title="删除"
        >
          <Trash size={13} />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <ModelMenu type={a.type} value={a.model} onPick={(v) => patch({ model: v })} />
        <Menu
          options={withDefault(EFFORT_VALUES[a.type])}
          value={a.reasoningEffort ?? ""}
          onChange={(v) => patch({ reasoningEffort: v })}
          menuWidth={250}
          triggerClassName={chipClass(!!a.reasoningEffort)}
        >
          <ChipLabel label="强度" value={a.reasoningEffort} />
        </Menu>
        <Menu
          options={SPEED_OPTIONS}
          value={a.speed ?? "standard"}
          onChange={(v) => patch({ speed: v as "standard" | "fast" })}
          menuWidth={220}
          triggerClassName={chipClass(a.speed === "fast")}
        >
          <ChipLabel label="速度" value={a.speed === "fast" ? "1.5x" : "标准"} />
        </Menu>
        <RelayMenu type={a.type} relays={relays} value={a.providerId} onPick={(v) => patch({ providerId: v || null })} />
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
            placeholder="额外 CLI 参数，空格分隔"
            className="w-56 rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] outline-none placeholder:text-faint"
          />
        ) : (
          <button
            onClick={() => {
              setArgsText(extra.join(" "));
              setArgsEditing(true);
            }}
            title="额外 CLI 参数（兜底；常用配置请用左侧下拉），空格分隔，留空清掉"
            className={
              extra.length
                ? "max-w-56 truncate font-mono text-[11px] text-muted hover:text-ink"
                : "shrink-0 whitespace-nowrap rounded border border-dashed border-line px-1.5 py-0.5 text-[11px] text-faint hover:text-ink"
            }
          >
            {extra.length ? extra.join(" ") : "+ 参数"}
          </button>
        )}
      </div>
    </div>
  );
}

function AddRow({ type, relays, onAdded }: { type: AgentType; relays: LlmProvider[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [speed, setSpeed] = useState<"standard" | "fast">("standard");
  const [providerId, setProviderId] = useState("");
  const [args, setArgs] = useState("");
  const [host, setHost] = useState("");

  const reset = () => {
    setName("");
    setModel("");
    setEffort("");
    setSpeed("standard");
    setProviderId("");
    setArgs("");
    setHost("");
  };

  const add = async () => {
    const target: ExecTarget = host.trim() ? { kind: "ssh", host: host.trim() } : { kind: "local" };
    const relayName = relays.find((r) => r.id === providerId)?.name;
    await api.createAgent({
      type,
      // 缺省名字带上中转站(claude@公司中转·opus),好在下拉里一眼分清同类型的多个执行者。
      name: name.trim() || `${type}@${relayName || host.trim() || "local"}${model ? "·" + model : ""}`,
      model: model.trim() || undefined,
      reasoningEffort: effort || undefined,
      speed: speed === "fast" ? "fast" : undefined,
      providerId: providerId || null,
      extraArgs: args.trim() ? args.trim().split(/\s+/) : undefined,
      target,
      isDefault: false,
    });
    reset();
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
      <div className="flex flex-wrap items-center gap-1.5">
        <ModelMenu type={type} value={model || undefined} onPick={setModel} />
        <Menu
          options={withDefault(EFFORT_VALUES[type])}
          value={effort}
          onChange={setEffort}
          menuWidth={250}
          triggerClassName={chipClass(!!effort)}
        >
          <ChipLabel label="强度" value={effort || undefined} />
        </Menu>
        <Menu
          options={SPEED_OPTIONS}
          value={speed}
          onChange={(v) => setSpeed(v as "standard" | "fast")}
          menuWidth={220}
          triggerClassName={chipClass(speed === "fast")}
        >
          <ChipLabel label="速度" value={speed === "fast" ? "1.5x" : "标准"} />
        </Menu>
        <RelayMenu type={type} relays={relays} value={providerId} onPick={setProviderId} />
      </div>
      <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="额外 CLI 参数（可选，空格分隔）" className="rounded border border-line bg-canvas px-2 py-1 font-mono outline-none placeholder:text-faint" />
      <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ssh 主机（留空=本地）" className="rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <div className="flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="px-2 py-1 text-muted">取消</button>
        <button onClick={add} className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg hover:bg-accent-hover">添加</button>
      </div>
    </div>
  );
}
