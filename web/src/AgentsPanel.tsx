import { useEffect, useState } from "react";
import type { AgentExecutorProfile, AgentType, ExecTarget, LlmProtocol, LlmProvider } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { MagnifyingGlass, Check, Plus, Trash, CircleNotch, ArrowSquareOut } from "@phosphor-icons/react";
import { api, type DetectedCli } from "./api";
import { Menu, type MenuOption } from "./Menu";
import { RelaySection } from "./Relays";
import { Tip } from "./Tip";
import { useEscape } from "./useEscape";
import { refreshDetectedAgents } from "./useDetectedAgents";
import {
  clearProviderModelCache,
  ModelConfigPicker,
  ReasoningEffortPicker,
} from "./ModelConfigPicker";

// 哪种协议的供应商能挂给哪个 CLI:claude 认 Anthropic 端点,codex / qwen 认 OpenAI 端点。
// null = 该 CLI 还没有挂供应商的通道(只能用它自己登录的账号)。
//
// 这是 catalog spec 里 `exec.relay` 的**镜像**:真相在 server/src/executors/catalog/<key>.ts,
// 但 `GET /api/agents/catalog` 目前不吐这个字段,所以前端只能照抄一份。给某个 spec 新加
// relay 通道时记得同步这里(更好的做法是让目录接口把协议一并返回,这份镜像就能删掉)。
const RELAY_PROTOCOL: Record<AgentType, LlmProtocol | null> = {
  claude: "anthropic",
  codex: "openai",
  qwen: "openai",
  antigravity: null,
  gemini: null,
  opencode: null,
  trae: null,
  grok: null,
  kimi: null,
  cursor: null,
  qoder: null,
  copilot: null,
  kiro: null,
  kilo: null,
  pi: null,
};

// 速度档:标准=不传参;1.5x=加速档(codex: -c service_tier="priority";
// claude: --settings '{"fastMode": true}',仅 Opus 生效)。
const SPEED_OPTIONS: MenuOption[] = [
  { value: "standard", label: "标准", detail: "跟随 CLI 默认速度" },
  { value: "fast", label: "1.5x", detail: "加速档（用量消耗更快）" },
];

type Detected = DetectedCli;

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
  // 删供应商会把挂着它的执行器置回官方账号(服务端做的),所以供应商变了要连执行器一起刷。
  const reloadRelays = () => {
    clearProviderModelCache();
    return Promise.all([api.llmProviders().then(setRelays), reload()]).catch(() => {});
  };
  const probe = () =>
    api.detectClis().then((d) => {
      // 目录里每一项都能派任务了,所以「本机装了的」就是可选执行器类型的全集。
      setAvail(new Set(d.filter((x) => x.available).map((x) => x.type as string)));
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
      // 刚装完一个 CLI 就点检测的场景:让所有「选谁干活」的下拉也跟着重新探一次,
      // 否则新装的那个要等下次刷新页面才出现在候选里。
      refreshDetectedAgents();
    } finally {
      setDetecting(false);
    }
  };

  // 只列「本机装了的」和「已经注册过执行器的」类型 —— 没装的 CLI 摆在这儿只是灰噪声,
  // 想用得先装。已注册的恒显示(可能是 ssh 远端执行器,本机自然探不到)。
  const shownTypes = AGENT_TYPES.filter((t) => list.some((a) => a.type === t) || avail?.has(t));

  const registerDetected = async (d: Detected) => {
    if (!d.type) return;
    const hasAny = list.some((a) => a.type === d.type);
    await api.createAgent({
      type: d.type,
      name: `${d.type}@local`,
      target: { kind: "local" },
      isDefault: !hasAny,
    });
    reload();
  };

  // 「检测到什么就展示什么」:没装的整卡不出现,连安装命令入口一起去掉 —— 用户要的是
  // 「这台机器上现在能派给谁」,一屏灰掉的未安装卡片只会把这个答案埋掉。
  const installed = (detected ?? []).filter((d) => d.available);

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
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted">本机检测到的智能体</span>
                <span className="text-[11px] text-faint">
                  {installed.length} 个已安装（目录共 {detected.length} 项）
                  ；没装的不列出来，装好后再点一次检测
                </span>
              </div>
              {installed.length === 0 ? (
                <p className="text-[12px] text-faint">
                  一个都没探到。装好任意一个智能体 CLI（如 claude / codex）后再点「检测本地智能体」。
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {installed.map((d) => (
                    <CliCard
                      key={d.key}
                      d={d}
                      registered={list.some((a) => a.type === d.type && a.target.kind === "local")}
                      onRegister={() => registerDetected(d)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            {shownTypes.map((type) => {
              const profiles = list.filter((a) => a.type === type);
              return (
                <div key={type}>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{type}</div>
                  {profiles.length === 0 && (
                    <p className="mb-1 text-[12px] text-faint">未配置 · 将用内置本地默认执行器</p>
                  )}
                  {profiles.map((a) => (
                    <Row key={a.id} a={a} relays={relays} onChange={reload} />
                  ))}
                  <AddRow type={type} relays={relays} onAdded={reload} />
                </div>
              );
            })}
          </div>
          {shownTypes.length === 0 && (
            <p className="text-[12px] text-faint">
              {avail === null
                ? "检测本地智能体中…"
                : "本机没找到已安装的智能体 CLI。装好任意一个（如 claude / codex）后点右上角「检测本地智能体」。"}
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

// 一张「本机装了的智能体」卡。只在 available 时渲染,所以不再有未安装分支、也没有
// 安装命令入口 —— 装没装是用户在终端里的事,这个面板回答的是「装了的这些怎么用」。
// 没有现成 logo 素材,图标位一律用名称首字母方块占位(与其扒各家 logo 惹一堆授权和
// 体积问题,不如整齐的占位块)。
function CliCard({ d, registered, onRegister }: { d: Detected; registered: boolean; onRegister: () => void }) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-line bg-panel p-2.5">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent/15 text-[13px] font-semibold text-accent">
        {d.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-ink">{d.name}</span>
          <Check size={12} weight="bold" className="shrink-0 text-emerald-600" />
          {d.untested && (
            <Tip
              label={
                d.notes
                  ? `执行参数按官方文档起草、本机未实测。${d.notes}`
                  : "执行参数按官方文档起草、本机未实测：能派任务，但首轮可能卡在交互确认或解析不出输出。"
              }
              className="shrink-0"
            >
              <span className="rounded bg-amber-500/15 px-1 py-px text-[10px] text-amber-700">未实测</span>
            </Tip>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted">{d.description}</div>
        <div className="mt-1 space-y-0.5">
          {d.version && <div className="truncate font-mono text-[10px] text-muted">{d.version}</div>}
          <div className="truncate font-mono text-[10px] text-faint">{d.path}</div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <a
            href={d.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:text-ink"
          >
            文档 <ArrowSquareOut size={10} />
          </a>
          {registered ? (
            <span className="text-[11px] text-faint">已注册</span>
          ) : (
            <button
              onClick={onRegister}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg hover:bg-accent-hover"
            >
              <Plus size={11} weight="bold" /> 注册为执行器
            </button>
          )}
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
      <span className="shrink-0 text-faint">{label}</span>
      {value && <span className="truncate">{value}</span>}
    </>
  );
}

// 供应商下拉:默认「官方账号」(不注入 env,CLI 用自己登录的账号)+ 协议匹配的供应商。
// 挂上后该执行器的每次运行都注入 base_url + key,执行任务和解析事项都走供应商。
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
                还没有 {protocol === "anthropic" ? "Anthropic" : "OpenAI"} 协议的供应商，去下面「供应商」里加
              </div>
            )
          : undefined
      }
    >
      <ChipLabel label="供应商" value={value ? current?.name ?? "已失效" : undefined} />
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
        {/* 供应商排在最前:它决定了「模型」下拉里能选什么(官方账号=CLI 别名,供应商=它自己那套全名) */}
        <RelayMenu type={a.type} relays={relays} value={a.providerId} onPick={(v) => patch({ providerId: v || null })} />
        <ModelConfigPicker
          key={a.providerId ?? ""}
          type={a.type}
          provider={relays.find((r) => r.id === a.providerId)}
          value={a.model}
          onChange={(v) => patch({ model: v })}
          fallback=""
          triggerClassName={`${chipClass(!!a.model)} max-w-[240px] overflow-hidden`}
        />
        <ReasoningEffortPicker
          type={a.type}
          value={a.reasoningEffort}
          onChange={(v) => patch({ reasoningEffort: v })}
          fallback=""
          triggerClassName={chipClass(!!a.reasoningEffort)}
        />
        <Menu
          options={SPEED_OPTIONS}
          value={a.speed ?? "standard"}
          onChange={(v) => patch({ speed: v as "standard" | "fast" })}
          menuWidth={220}
          triggerClassName={chipClass(a.speed === "fast")}
        >
          <ChipLabel label="速度" value={a.speed === "fast" ? "1.5x" : "标准"} />
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
      // 缺省名字带上供应商(claude@公司自建·opus),好在下拉里一眼分清同类型的多个执行器。
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
        <Plus size={12} weight="bold" /> 添加执行器
      </button>
    );

  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-line p-2 text-[12px]">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称（可选）" className="rounded border border-line bg-canvas px-2 py-1 outline-none placeholder:text-faint" />
      <div className="flex flex-wrap items-center gap-1.5">
        <RelayMenu type={type} relays={relays} value={providerId} onPick={setProviderId} />
        <ModelConfigPicker
          key={providerId}
          type={type}
          provider={relays.find((r) => r.id === providerId)}
          value={model || undefined}
          onChange={setModel}
          fallback=""
          triggerClassName={`${chipClass(!!model)} max-w-[240px] overflow-hidden`}
        />
        <ReasoningEffortPicker
          type={type}
          value={effort}
          onChange={setEffort}
          fallback=""
          triggerClassName={chipClass(!!effort)}
        />
        <Menu
          options={SPEED_OPTIONS}
          value={speed}
          onChange={(v) => setSpeed(v as "standard" | "fast")}
          menuWidth={220}
          triggerClassName={chipClass(speed === "fast")}
        >
          <ChipLabel label="速度" value={speed === "fast" ? "1.5x" : "标准"} />
        </Menu>
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
