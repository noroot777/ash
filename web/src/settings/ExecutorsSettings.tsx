import { useEffect, useState } from "react";
import type { AgentExecutorProfile, LlmProvider } from "@ash/shared";
import { refreshAgentAvailability } from "../lib/agentAvailability.ts";
import { api, type DetectedCli } from "../lib/api.ts";
import { AgentProfilesSection } from "./AgentProfilesSection.tsx";

function updateById(rows: AgentExecutorProfile[], updated: AgentExecutorProfile) {
  return rows.map((row) => {
    if (row.id === updated.id) return updated;
    if (updated.isDefault && row.type === updated.type) return { ...row, isDefault: false };
    return row;
  });
}

export function ExecutorsSettings({ notify }: { notify: (message: string) => void }) {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectedCli[] | null>(null);
  const [registeringKey, setRegisteringKey] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.agents(), api.llmProviders()])
      .then(([agents, nextProviders]) => {
        setProfiles(agents);
        setProviders(nextProviders);
      })
      .catch((error) => notify(error instanceof Error ? error.message : "执行器设置读取失败"))
      .finally(() => setLoading(false));
  }, [notify]);

  const changeProfile = (id: string, updated: AgentExecutorProfile | null) => {
    setProfiles((current) => updated
      ? updateById(current, updated)
      : current.filter((row) => row.id !== id));
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
    setRegisteringKey(cli.key);
    try {
      const created = await api.createAgent({
        type: cli.type,
        name: `${cli.type}@local`,
        isDefault: !profiles.some((row) => row.type === cli.type),
      });
      setProfiles((current) => [...current, created]);
      refreshAgentAvailability();
      notify(`${cli.name} 已注册为执行器`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "注册失败");
    } finally {
      setRegisteringKey(null);
    }
  };

  return (
    <>
      <header className="settings-heading">
        <div>
          <h1>执行器</h1>
          <p>配置实际调用的 CLI 身份、运行位置、模型供应商与默认覆盖。</p>
        </div>
      </header>

      <AgentProfilesSection
        profiles={profiles}
        providers={providers}
        loading={loading}
        detecting={detecting}
        detected={detected}
        registeringKey={registeringKey}
        onDetect={() => void detect()}
        onRegister={(cli) => void register(cli)}
        onProfileChanged={changeProfile}
        onProfileAdded={(profile) => setProfiles((current) => [...current, profile])}
        onProfilesDeleted={(ids) => {
          const deleted = new Set(ids);
          setProfiles((current) => current.filter((profile) => !deleted.has(profile.id)));
        }}
        notify={notify}
      />
    </>
  );
}
