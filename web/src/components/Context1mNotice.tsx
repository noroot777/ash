import { useEffect, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import type { AgentExecutorProfile, ContextUsage, LlmProvider, Session } from "@ash/shared";
import { claudeCompactionPlan } from "@ash/shared/cli-overrides";
import { type ClaudeModelWindow, clampedCompactWindow, claudeModelWindow } from "@ash/shared/context-1m";
import { contextCompactTrigger } from "@ash/shared/usage";
import { api } from "../lib/api.ts";
import { refreshProviders } from "../lib/modelCatalog.ts";
import { useCliHostEnv } from "../lib/useCliHostEnv.ts";
import { matchProfile } from "./ContextCompactQuickSettings.tsx";
import "./context-1m-notice.css";

// 600k / 200k / 149k 这种整数口径,跟设置页压缩提示(cli-overrides 的 fmtTokens)一致。
const fmtK = (n: number) => (n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(2))}M` : `${Math.round(n / 1000)}k`);

// 「配的压缩窗口比模型窗口大」时的那句提示 + 一键开启 1M。
//
// 执行器配 600k、模型却没在供应商上开 1M,CLI 会把窗口截到 200k:触发点从 ~480k 掉到
// ~149k,任务隔几步就压一次,界面上却还写着 600k(判定见 shared/src/context-1m.ts)。
// 开关本身在供应商的 1M 列表里,离用户看见症状的地方(会话的上下文胶囊、执行器的压缩
// 配置)都隔着好几跳,所以就地给一颗按钮;写入走原子追加,两处同时点也不会互相冲掉。
//
// 两种事实分开用:**报出这份水位的那一轮在怎么跑**只看水位自带的启动快照(压缩窗口、
// 百分比、输出预留,由产出水位的进程起跑时一起写下,见 shared CompactSnapshot)和 CLI 自报
// 的窗口;**下一轮会怎么跑**才看当前执行器与供应商配置,判据跟起跑那一侧对齐(没 key 回退
// 官方账号、额外参数覆盖模型)。不从展示用的命令行字符串里反推模型 —— 那串是有损拼接的。

/** 设置页:按执行器当前配置判「下一次起跑会不会被截」。 */
export function Context1mNotice({
  model,
  provider,
  extraArgs,
  overrides,
  onEnabled,
}: {
  model: string | null | undefined;
  provider: LlmProvider | null | undefined;
  extraArgs: readonly string[];
  overrides: Record<string, number>;
  onEnabled: (provider: LlmProvider) => void;
}) {
  const hostEnv = useCliHostEnv();
  const next = claudeModelWindow(model, provider, extraArgs);
  const clamp = next ? clampedCompactWindow(overrides.autoCompactWindow, next.window) : null;
  if (!next || !clamp) return null;
  const trigger = claudeCompactionPlan(overrides, hostEnv, next.window)?.trigger;
  return (
    <div className="context-1m-notice" role="status">
      <WarningCircle size={13} weight="fill" aria-hidden="true" />
      <p>
        {next.model} 没开 1M：{fmtK(clamp.configured)} 窗口会被截到 {fmtK(clamp.effective)}
        {typeof trigger === "number" ? `，约 ${fmtK(trigger)} 就压缩` : ""}。
        <NextLaunchHint next={next} />
      </p>
      {next.provider && <EnableButton model={next.model} provider={next.provider} onEnabled={onEnabled} />}
    </div>
  );
}

/**
 * 会话面板:调用方已确认「压缩窗口比 CLI 自报的窗口大」。这句警告只由会话自己的启动快照
 * 撑着,读不到执行器配置也照样显示;读到了再补一句「下一轮会怎样」。
 */
export function SessionContext1mNotice({ session, context }: { session: Session; context: ContextUsage }) {
  const [facts, setFacts] = useState<{ profile: AgentExecutorProfile; provider: LlmProvider | null } | null>(null);
  // 一键开启之后重读一遍权威配置(而不是拿响应去拼本地状态):别处同时改过的也一并对上。
  const [reload, setReload] = useState(0);
  // 只认身份字段:会话对象每次轮询都是新引用,拿它当依赖会每次重拉两张表。
  const identity = `${session.id}|${session.executorId ?? ""}|${session.executor}|${session.agentType}`;
  useEffect(() => {
    let alive = true;
    Promise.all([api.agents(), api.llmProviders()])
      .then(([profiles, providers]) => {
        const profile = matchProfile(profiles, session);
        if (!alive || !profile) return;
        setFacts({ profile, provider: providers.find((item) => item.id === profile.providerId) ?? null });
      })
      // 读不到就只少一句「下一轮会怎样」,上面那句警告不依赖它。
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity 已覆盖 matchProfile 读的全部字段
  }, [identity, reload]);

  // 快照与自报窗口出自同一个进程,所以这里说的是「报出这份水位的那一轮」,不管它是不是
  // 正在跑的这一轮 —— 新一轮报回来之前,面板上本来就是上一份水位。
  const clamp = clampedCompactWindow(context.compactWindow, context.windowEstimated ? null : context.window);
  if (!clamp) return null;
  const model = session.turnModel || session.model || "这个模型";
  const trigger = contextCompactTrigger(context);

  const nextModel = facts ? session.turnModel || facts.profile.model : null;
  const next = facts ? claudeModelWindow(nextModel, facts.provider, facts.profile.extraArgs ?? []) : null;
  const nextWindow = facts?.profile.configOverrides?.autoCompactWindow;
  const nextClamped = next ? clampedCompactWindow(nextWindow, next.window) !== null : false;

  return (
    <div className="context-1m-notice" role="status">
      <WarningCircle size={13} weight="fill" aria-hidden="true" />
      <p>
        {model} 没开 1M：{fmtK(clamp.configured)} 窗口被截到 {fmtK(clamp.effective)}
        {trigger !== null ? `，约 ${fmtK(trigger)} 就压缩` : ""}。
        {next && !nextClamped && <span className="context-1m-notice-next">下一轮起不再被截。</span>}
        {next && nextClamped && <NextLaunchHint next={next} />}
      </p>
      {next?.provider && nextClamped && (
        <EnableButton model={next.model} provider={next.provider} onEnabled={() => setReload((n) => n + 1)} />
      )}
    </div>
  );
}

/** 按不出「开启 1M」时,换一句用户能照着做的话。 */
function NextLaunchHint({ next }: { next: ClaudeModelWindow }) {
  const blocker = next.blocker;
  if (!blocker) return null;
  const text = blocker.kind === "no-key"
    ? `供应商「${blocker.provider.name}」没填 API Key，起跑时会退回官方账号，先补上 key。`
    : blocker.kind === "extra-args-model"
      ? `额外参数里的 --model ${blocker.model} 覆盖了模型，请在那里改成 ${next.model}[1m]。`
      : `官方账号请把模型改成 ${next.model}[1m]。`;
  return <span className="context-1m-notice-next">{text}</span>;
}

function EnableButton({
  model,
  provider,
  onEnabled,
}: {
  model: string;
  provider: { id: string; name: string };
  onEnabled: (provider: LlmProvider) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enable = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.enableContext1m(provider.id, model);
      refreshProviders();
      onEnabled(updated);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "开启失败");
    } finally {
      setSaving(false);
    }
  };
  return (
    <span className="context-1m-notice-action">
      <button
        type="button"
        disabled={saving}
        aria-label={`为 ${model} 开启 1M：加进供应商「${provider.name}」的 1M 列表，挂它的执行器下一轮起生效`}
        onClick={() => void enable()}
      >
        {saving ? "开启中…" : "开启 1M"}
      </button>
      {error && <span className="context-1m-notice-error">{error}</span>}
    </span>
  );
}
