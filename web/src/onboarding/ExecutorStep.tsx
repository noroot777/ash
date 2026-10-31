import { useCallback, useEffect, useState } from "react";
import type { AgentExecutorProfile, LlmProvider } from "@ash/shared";
import { MagnifyingGlass, Star } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { Dropdown, type DropdownOption } from "../components/Dropdown.tsx";
import { refreshAgentAvailability } from "../lib/agentAvailability.ts";
import { api, type DetectedCli } from "../lib/api.ts";
import { AgentDetectionResults } from "../settings/AgentDetectionResults.tsx";
import { providerProtocolForAgent, providersForAgent } from "../settings/agentProviderRules.ts";

/**
 * 第二站:谁来干活。
 *
 * 检测结果那张卡直接用设置页那一份(`AgentDetectionResults`),注册动作与它一样是
 * 「本地装了什么 → 注册成同名 Profile」,所以这里只负责把两件设置页没做的事补上:
 *
 *  · **进屏就自动检测一遍**。设置页那边要等用户按「检测本地智能体」是对的(他是专门
 *    去的);首次安装的人还不知道「执行器」和「本地 CLI」是一回事,摆一颗按钮在那儿
 *    等于让他先猜一次。
 *  · **把上一站加的供应商挂上去**。上一站填完 Key 却没有任何执行器用它,那一站就白走了;
 *    而真正会用到它的那一刻正是此刻。协议匹配规则与设置页共用 `providersForAgent`。
 */
export function ExecutorStep({ profiles, providers, onProfileAdded, onProfileChanged, notify }: {
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  onProfileAdded: (profile: AgentExecutorProfile) => void;
  onProfileChanged: (profile: AgentExecutorProfile) => void;
  notify: (message: string) => void;
}) {
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectedCli[] | null>(null);
  const [registeringKey, setRegisteringKey] = useState<string | null>(null);
  const [bindingId, setBindingId] = useState<string | null>(null);

  const detect = useCallback(async () => {
    setDetecting(true);
    try {
      setDetected(await api.detectClis());
      refreshAgentAvailability();
    } catch (error) {
      notify(error instanceof Error ? error.message : "本地 CLI 检测失败");
    } finally {
      setDetecting(false);
    }
  }, [notify]);

  useEffect(() => { void detect(); }, [detect]);

  const register = async (cli: DetectedCli) => {
    if (!cli.type) return;
    // 门禁同时落在按钮和这里:只 disable 按钮的话,键盘/程序化触发照样把请求发出去,
    // 再拿回同一句话(与 AgentProfilesSection 同款理由)。
    if (cli.versionWarning) {
      notify(cli.versionWarning);
      return;
    }
    setRegisteringKey(cli.key);
    try {
      const created = await api.createAgent({
        type: cli.type,
        name: `${cli.type}@local`,
        isDefault: !profiles.some((row) => row.type === cli.type),
      });
      onProfileAdded(created);
      refreshAgentAvailability();
      notify(`${cli.name} 已注册为执行器`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "注册失败");
    } finally {
      setRegisteringKey(null);
    }
  };

  const bind = async (profile: AgentExecutorProfile, providerId: string) => {
    setBindingId(profile.id);
    try {
      onProfileChanged(await api.patchAgent(profile.id, { providerId: providerId || null }));
    } catch (error) {
      notify(error instanceof Error ? error.message : "供应商绑定失败");
    } finally {
      setBindingId(null);
    }
  };

  return (
    <>
      <AgentDetectionResults
        detected={detected}
        profiles={profiles}
        registeringKey={registeringKey}
        onRegister={(cli) => void register(cli)}
      />
      {detecting && !detected && <p className="onboarding-muted">正在看这台机器上装了哪些 CLI…</p>}

      {!!profiles.length && (
        <ul className="onboarding-rows">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <span className={`settings-agent-avatar is-${profile.type}`}>
                {profile.type.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <b>{profile.name}</b>
                <small>{profile.type}{profile.model ? ` · ${profile.model}` : ""}</small>
              </div>
              {profile.isDefault && (
                <span className="onboarding-default">
                  <Star size={11} weight="fill" aria-hidden="true" />
                  默认
                </span>
              )}
              {!!providers.length && (
                <Dropdown
                  label={`${profile.name} 的供应商`}
                  className="onboarding-provider-pick"
                  value={profile.providerId ?? ""}
                  disabled={bindingId === profile.id}
                  filterable={false}
                  options={providerChoices(profile, providers)}
                  onChange={(value) => void bind(profile, value)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <Button className="onboarding-add" disabled={detecting} onClick={() => void detect()}>
        <MagnifyingGlass size={13} aria-hidden="true" />
        {detecting ? "检测中…" : "重新检测"}
      </Button>
    </>
  );
}

/** 候选 = CLI 官方账号 + 协议对得上的供应商。不支持接供应商的 CLI 只剩一条,下拉自己会说。 */
function providerChoices(profile: AgentExecutorProfile, providers: LlmProvider[]): DropdownOption[] {
  const protocol = providerProtocolForAgent(profile.type);
  return [
    { value: "", label: protocol ? "CLI 官方账号" : "不支持接供应商" },
    ...providersForAgent(profile.type, providers).map((provider) => ({
      value: provider.id,
      label: provider.name,
      detail: provider.hasKey ? "" : "缺 Key",
    })),
  ];
}
