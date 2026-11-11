import { useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import type { ContextUsage, LlmProvider, Session } from "@ash/shared";
import { type CliHostEnv, claudeCompactionPlan } from "@ash/shared/cli-overrides";
import { type ClaudeModelWindow, clampedCompactWindow, claudeModelWindow } from "@ash/shared/context-1m";
import { contextCompactTrigger } from "@ash/shared/usage";
import { api } from "../lib/api.ts";
import { refreshProviders } from "../lib/modelCatalog.ts";
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
// 会话面板只解释**报出这份水位的那一轮**(水位自带的启动快照,由产出水位的进程起跑时按
// 最终生效的参数写下,见 shared CompactSnapshot);设置页只判**执行器自己的配置**下一次起跑
// 会怎样(没 key 回退官方账号、额外参数覆盖模型,跟起跑那一侧同一套判据)。两边不互相借数。

/** 设置页:按执行器当前配置判「下一次起跑会不会被截」。 */
export function Context1mNotice({
  model,
  provider,
  extraArgs,
  overrides,
  hostEnv,
  onEnabled,
}: {
  model: string | null | undefined;
  provider: LlmProvider | null | undefined;
  extraArgs: readonly string[];
  overrides: Record<string, number>;
  /** 跟同一弹层里其它预览共用的那份(见 useCliHostEnv),不自己另取。 */
  hostEnv: CliHostEnv;
  onEnabled: (provider: LlmProvider) => void;
}) {
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
 * 会话面板:调用方已确认「压缩窗口比 CLI 自报的窗口大」。只说报出这份水位的那一轮的事实
 * (水位自带的启动快照 + CLI 自报窗口),不推测下一轮:下一轮跑哪个模型、挂哪家供应商要看
 * 任务级覆盖与当时的执行器配置,只有服务端起跑那一刻才定得下来,拿历史会话去猜会指错模型
 * (第 3 轮审查 F2)。开关在设置页 → 执行器的压缩配置里,那里按执行器自己的配置判、能一键开启。
 */
export function SessionContext1mNotice({ session, context }: { session: Session; context: ContextUsage }) {
  const clamp = clampedCompactWindow(context.compactWindow, context.windowEstimated ? null : context.window);
  if (!clamp) return null;
  const trigger = contextCompactTrigger(context);
  return (
    <div className="context-1m-notice" role="status">
      <WarningCircle size={13} weight="fill" aria-hidden="true" />
      <p>
        没开 1M：{fmtK(clamp.configured)} 窗口被截到 {fmtK(clamp.effective)}
        {trigger !== null ? `，约 ${fmtK(trigger)} 就压缩` : ""}。
        <span className="context-1m-notice-next">到设置 → 执行器「{session.executor}」的 CLI 配置里开启。</span>
      </p>
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
