import { useEffect, useState } from "react";
import type { LlmProvider } from "@harness/shared";
import { api } from "../lib/api.ts";
import { ProvidersSection } from "./ProvidersSection.tsx";

export function ProvidersSettings({ notify }: { notify: (message: string) => void }) {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setProviders(await api.llmProviders());
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
        <ProvidersSection providers={providers} onChanged={load} notify={notify} />
      )}
    </>
  );
}
