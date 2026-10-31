import { useEffect, useState } from "react";
import type { AgentExecutorProfile, LlmProvider } from "@ash/shared";
import { api } from "../lib/api.ts";
import { ProvidersSection } from "./ProvidersSection.tsx";
import type { SettingsSection } from "./sections.ts";

export function ProvidersSettings({ notify, onOpen }: {
  notify: (message: string) => void;
  onOpen?: (section: SettingsSection) => void;
}) {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  // 执行器 Profile 只为回答一件事:这家供应商有没有人挂它。没人挂 = 任务里选不到它的
  // 模型(lib/modelCatalog.ts),那是用户在这一页之后最容易撞上的墙,得在这一页说清。
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const [nextProviders, nextProfiles] = await Promise.all([api.llmProviders(), api.agents()]);
    setProviders(nextProviders);
    setProfiles(nextProfiles);
  };

  useEffect(() => {
    load()
      .catch((error) => notify(error instanceof Error ? error.message : "供应商设置读取失败"))
      .finally(() => setLoading(false));
  }, [notify]);

  return (
    <>
      <header className="settings-heading">
        <div>
          <h1>供应商</h1>
          <p>管理模型协议、API 地址与密钥，再把供应商绑定到需要独立账号或模型目录的执行器。</p>
        </div>
      </header>
      {loading ? (
        <section className="settings-section">
          <h2>模型供应商</h2>
          <div className="settings-card"><p className="settings-muted">读取中…</p></div>
        </section>
      ) : (
        <ProvidersSection
          providers={providers}
          profiles={profiles}
          onOpenExecutors={onOpen ? () => onOpen("executors") : undefined}
          onChanged={load}
          notify={notify}
        />
      )}
    </>
  );
}
