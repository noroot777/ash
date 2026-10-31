import { useCallback, useEffect, useState } from "react";
import type { AgentExecutorProfile, LlmProvider } from "@ash/shared";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ProvidersSection, type LoadState } from "./ProvidersSection.tsx";
import type { SettingsSection } from "./sections.ts";

/**
 * 这一页上是**两份**独立的远端事实,各自成败:
 *  ① 供应商本身 —— 这一页的主体,它决定列表里有什么、「还没有供应商」这句话成不成立;
 *  ② 执行器 Profile —— 只为在每一行旁边回答一句「有没有人挂它」。
 *
 * 曾经把两者捆成一次 `Promise.all`:`/agents` 一个 503,就把**已经成功读到**的供应商
 * 一起丢掉,页面接着拿初始的 `[]` 当答案,显示「还没有供应商」—— 用户看到的是自己加过的
 * 供应商全没了、连编辑入口都没有(审查第 1 轮实测)。而且它还顺带拖慢了主体:`/agents`
 * 慢一秒,整张卡就多停一秒在「读取中…」。
 *
 * 所以判据分开写,并且**只有明确成功才允许下断言**:供应商没读成功就不说「没有供应商」,
 * 挂载情况没读成功就不说「未挂到执行器」。另外「写成功了没有」只由写请求自己决定 ——
 * 旁注刷新失败不该把一次已经落库的保存报成失败,否则用户会去重放它(再点一次保存 =
 * 再建一个)。所以 ② 这一路一律不抛。
 */
export function ProvidersSettings({ notify, onOpen }: {
  notify: (message: string) => void;
  onOpen?: (section: SettingsSection) => void;
}) {
  // null = 还没有任何一次成功读取。读成功过就一直留着上一次的结果:后来的刷新失败只
  // 该是一句提示,不该把用户正在看的列表清空。
  const [providers, setProviders] = useState<LlmProvider[] | null>(null);
  const [providersState, setProvidersState] = useState<LoadState>("loading");
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesState, setProfilesState] = useState<LoadState>("loading");

  const loadProviders = useCallback(async () => {
    try {
      setProviders(await api.llmProviders());
      setProvidersState("ready");
    } catch (error) {
      setProvidersState("failed");
      throw error; // 主体读不到就是读不到,调用方(初始加载 / 保存 / 删除)照旧按失败处理
    }
  }, []);

  const loadProfiles = useCallback(async () => {
    // 已经读到过就别退回「未知」:刷新期间继续显示上一次的挂载情况,比闪一下空白好。
    setProfilesState((current) => (current === "ready" ? current : "loading"));
    try {
      setProfiles(await api.agents());
      setProfilesState("ready");
    } catch {
      setProfilesState("failed"); // 不抛:它只是旁注,见本文件顶部
    }
  }, []);

  const load = useCallback(async () => {
    void loadProfiles();
    await loadProviders();
  }, [loadProfiles, loadProviders]);

  useEffect(() => {
    load().catch((error) => notify(error instanceof Error ? error.message : "供应商设置读取失败"));
  }, [load, notify]);

  return (
    <>
      <header className="settings-heading">
        <div>
          <h1>供应商</h1>
          <p>管理模型协议、API 地址与密钥，再把供应商绑定到需要独立账号或模型目录的执行器。</p>
        </div>
      </header>
      {providers ? (
        <ProvidersSection
          providers={providers}
          profiles={profiles}
          profilesState={profilesState}
          onRetryProfiles={() => void loadProfiles()}
          onOpenExecutors={onOpen ? () => onOpen("executors") : undefined}
          onChanged={load}
          notify={notify}
        />
      ) : (
        <section className="settings-section">
          <h2>模型供应商</h2>
          <div className="settings-card">
            {providersState === "failed" ? (
              // 读失败和「一个都没有」是两回事,这里不许说成后者。
              <p className="settings-muted providers-load-failed">
                供应商列表读取失败，现在看不到已有的供应商。
                <Button variant="ghost" onClick={() => void load().catch(() => {})}>重试</Button>
              </p>
            ) : (
              <p className="settings-muted">读取中…</p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
