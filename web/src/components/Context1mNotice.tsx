import { useEffect, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import type { AgentExecutorProfile, LlmProvider, Session } from "@ash/shared";
import { claudeCompactionPlan } from "@ash/shared/cli-overrides";
import { clampedCompactWindow, claudeModelWindow } from "@ash/shared/context-1m";
import { api } from "../lib/api.ts";
import { refreshProviders } from "../lib/modelCatalog.ts";
import { useCliHostEnv } from "../lib/useCliHostEnv.ts";
import { matchProfile } from "./ContextCompactQuickSettings.tsx";
import "./context-1m-notice.css";

// 600k / 200k / 149k 这种整数口径,跟设置页压缩提示(cli-overrides 的 fmtTokens)一致。
const fmtK = (n: number) => (n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(2))}M` : `${Math.round(n / 1000)}k`);

/**
 * 「配的压缩窗口比模型窗口大」时的那句提示 + 一键开启 1M。
 *
 * 执行器配 600k、模型却没在供应商上开 1M,CLI 会把窗口截到 200k:触发点从 ~480k 掉到
 * ~149k,任务隔几步就压一次,界面上却还写着 600k(判定见 shared/src/context-1m.ts)。
 * 开关本身在供应商的 1M 列表里,离用户看见症状的地方(会话的上下文胶囊、执行器的压缩
 * 配置)都隔着好几跳,所以就地给一颗按钮;写入走原子追加,两处同时点也不会互相冲掉。
 *
 * `cliWindow` 只有会话面板给:那是 CLI 这一轮自报的窗口(事实)。设置页没有正在跑的
 * 进程,按供应商声明推断。两者不一致 = 已经开了、但这一轮进程是开之前起的。
 */
export function Context1mNotice({
  model,
  provider,
  overrides,
  cliWindow,
  onEnabled,
}: {
  model: string | null | undefined;
  provider: LlmProvider | null | undefined;
  overrides: Record<string, number>;
  cliWindow?: number | null;
  onEnabled?: (provider: LlmProvider) => void;
}) {
  const hostEnv = useCliHostEnv();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = claudeModelWindow(model, provider);
  if (!status) return null;
  const running = cliWindow ?? status.window;
  const clamp = clampedCompactWindow(overrides.autoCompactWindow, running);
  if (!clamp) return null;

  if (status.window >= clamp.configured) {
    return (
      <p className="context-1m-notice is-pending">
        {status.model} 已开启 1M，下一轮起按 {fmtK(clamp.configured)} 窗口压缩。
      </p>
    );
  }

  const trigger = claudeCompactionPlan(overrides, hostEnv, running)?.trigger;
  const enable = async () => {
    if (!status.provider) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.enableContext1m(status.provider.id, status.model);
      refreshProviders();
      onEnabled?.(updated);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "开启失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="context-1m-notice" role="status">
      <WarningCircle size={13} weight="fill" aria-hidden="true" />
      <p>
        {status.model} 没开 1M：{fmtK(clamp.configured)} 窗口被截到 {fmtK(clamp.effective)}
        {typeof trigger === "number" ? `，约 ${fmtK(trigger)} 就压缩` : ""}。
        {!status.provider && ` 官方账号请把模型改成 ${status.model}[1m]。`}
        {error && <span className="context-1m-notice-error">{error}</span>}
      </p>
      {status.provider && (
        <button
          type="button"
          disabled={saving}
          aria-label={`为 ${status.model} 开启 1M：加进供应商「${status.provider.name}」的 1M 列表，挂它的执行器下一轮起生效`}
          onClick={() => void enable()}
        >
          {saving ? "开启中…" : "开启 1M"}
        </button>
      )}
    </div>
  );
}

/**
 * 会话面板那一处:要先认出这条会话用的执行器和它挂的供应商才判得了。只在 CLI 自报的
 * 窗口确实比压缩窗口小时才挂载(调用方判),所以平时不多发这两个请求。
 */
export function SessionContext1mNotice({ session, cliWindow }: { session: Session; cliWindow: number }) {
  const [facts, setFacts] = useState<{ profile: AgentExecutorProfile; provider: LlmProvider | null } | null>(null);

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
      // 读不到就不提示:这句话是锦上添花,为它在水位面板里报一条错不值当。
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity 已覆盖 matchProfile 读的全部字段
  }, [identity]);

  if (!facts) return null;
  return (
    <Context1mNotice
      model={session.turnModel || facts.profile.model}
      provider={facts.provider}
      overrides={facts.profile.configOverrides ?? {}}
      cliWindow={cliWindow}
      onEnabled={(provider) => setFacts((current) => (current ? { ...current, provider } : current))}
    />
  );
}
