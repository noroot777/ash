import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, AppSettings, LlmProvider } from "@harness/shared";
import { AGENT_TYPES, DEFAULT_APP_SETTINGS } from "@harness/shared";
import { Check, MagnifyingGlass } from "@phosphor-icons/react";
import { Button, Toggle } from "../components/ui.tsx";
import {
  refreshAgentAvailability,
  useAgentAvailability,
} from "../lib/agentAvailability.ts";
import { api, type DetectedCli } from "../lib/api.ts";
import { AgentProfilesSection } from "./AgentProfilesSection.tsx";
import { ProvidersSection } from "./ProvidersSection.tsx";
import "./agents-settings.css";

function updateById(rows: AgentExecutorProfile[], updated: AgentExecutorProfile) {
  return rows.map((row) => {
    if (row.id === updated.id) return updated;
    if (updated.isDefault && row.type === updated.type) return { ...row, isDefault: false };
    return row;
  });
}

export function AgentsSettings({ notify }: { notify: (message: string) => void }) {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectedCli[] | null>(null);
  const availability = useAgentAvailability();

  useEffect(() => {
    Promise.all([api.agents(), api.llmProviders(), api.settings()])
      .then(([agents, nextProviders, nextSettings]) => {
        setProfiles(agents);
        setProviders(nextProviders);
        setSettings(nextSettings);
      })
      .catch((error) => notify(error instanceof Error ? error.message : "执行器设置读取失败"))
      .finally(() => setLoading(false));
  }, [notify]);

  const defaults = useMemo(
    () => AGENT_TYPES.map((type) => ({
      type,
      profile: profiles.find((row) => row.type === type && row.isDefault),
    })),
    [profiles],
  );

  const changeProfile = (id: string, updated: AgentExecutorProfile | null) => {
    setProfiles((current) => updated
      ? updateById(current, updated)
      : current.filter((row) => row.id !== id));
  };

  const reloadProvidersAndProfiles = async () => {
    const [nextProfiles, nextProviders] = await Promise.all([api.agents(), api.llmProviders()]);
    setProfiles(nextProfiles);
    setProviders(nextProviders);
  };

  const detect = async () => {
    setDetecting(true);
    try {
      setDetected(await api.detectClis());
      refreshAgentAvailability();
    } catch (error) {
      notify(error instanceof Error ? error.message : "本地 CLI 检测失败");
    } finally {
      setDetecting(false);
    }
  };

  const register = async (cli: DetectedCli) => {
    if (!cli.type) return;
    try {
      const created = await api.createAgent({
        type: cli.type,
        name: `${cli.type}@local`,
        target: { kind: "local" },
        isDefault: !profiles.some((row) => row.type === cli.type),
      });
      setProfiles((current) => [...current, created]);
      refreshAgentAvailability();
      notify(`${cli.name} 已注册为执行器`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "注册失败");
    }
  };

  return (
    <>
      <header className="settings-heading">
        <div>
          <h1>执行器与供应商</h1>
          <p>配置实际调用的 CLI 身份，并为指定 Profile 绑定兼容的模型供应商。</p>
        </div>
        <Button disabled={detecting} onClick={() => void detect()}>
          <MagnifyingGlass size={13} />
          {detecting ? "检测中…" : "检测本地智能体"}
        </Button>
      </header>

      <AgentProfilesSection
        profiles={profiles}
        providers={providers}
        loading={loading}
        availability={availability}
        onProfileChanged={changeProfile}
        onProfileAdded={(profile) => setProfiles((current) => [...current, profile])}
        notify={notify}
      />

      {detected && (
        <section className="settings-section">
          <h2>检测结果</h2>
          <div className="settings-card settings-cli-grid">
            {detected.map((cli) => {
              const registered = !!cli.type && profiles.some(
                (profile) => profile.type === cli.type && profile.target.kind === "local",
              );
              return (
                <article key={cli.key}>
                  <span className={`settings-cli-state${cli.available ? " is-ready" : ""}`}>
                    {cli.available ? <Check size={12} /> : "—"}
                  </span>
                  <div>
                    <b>{cli.name}</b>
                    <small>{cli.available ? cli.version || cli.path : "未安装"}</small>
                  </div>
                  {cli.available && cli.type && !registered && (
                    <button type="button" onClick={() => void register(cli)}>注册</button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <ProvidersSection
        providers={providers}
        onChanged={reloadProvidersAndProfiles}
        notify={notify}
      />

      <section className="settings-section">
        <h2>默认规则</h2>
        <div className="settings-card">
          {defaults.map(({ type, profile }) => (
            <div className="settings-row" key={type}>
              <div>
                <b>{type} 类型默认</b>
                <small>任务未指定 executorId 时降级到此 Profile</small>
              </div>
              <span>{profile?.name ?? `内置 ${type}@local`}</span>
            </div>
          ))}
          <div className="settings-row">
            <div>
              <b>新任务默认使用 worktree</b>
              <small>仅 Git 项目生效；每张新任务仍可单独覆盖</small>
            </div>
            <Toggle
              label={settings.worktreeDefault ? "已开启" : "已关闭"}
              checked={settings.worktreeDefault}
              onChange={async (checked) => {
                try {
                  setSettings(await api.patchSettings({ worktreeDefault: checked }));
                } catch (error) {
                  notify(error instanceof Error ? error.message : "默认规则保存失败");
                }
              }}
            />
          </div>
        </div>
      </section>
    </>
  );
}
