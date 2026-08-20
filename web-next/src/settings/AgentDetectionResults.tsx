import type { AgentExecutorProfile } from "@harness/shared";
import { Check, CheckCircle } from "@phosphor-icons/react";
import type { DetectedCli } from "../lib/api.ts";

export function AgentDetectionResults({
  detected,
  profiles,
  registeringKey,
  onRegister,
}: {
  detected: DetectedCli[] | null;
  profiles: AgentExecutorProfile[];
  registeringKey: string | null;
  onRegister: (cli: DetectedCli) => void;
}) {
  if (!detected) return null;
  const available = detected.filter((cli) => cli.available);

  return (
    <div className="agent-detection-results">
      <div className="agent-detection-results-head">
        <b>本地已安装</b>
        <small>{available.length} 个 CLI</small>
      </div>
      {!available.length ? (
        <p className="settings-muted">未检测到已安装的本地 CLI。</p>
      ) : (
        <div className="settings-cli-grid">
          {available.map((cli) => {
            const registered = !!cli.type && profiles.some((profile) => profile.type === cli.type);
            return (
              <article key={cli.key}>
                <span className="settings-cli-state is-ready"><Check size={12} /></span>
                <div>
                  <b>{cli.name}</b>
                  <small>{cli.version || cli.path}</small>
                  {/* 本平台的前提/限制（目前只有 Windows 侧会有，例如「需要先装 Git for
                      Windows」）。装上了也仍然要知道，所以放在已安装卡片里。 */}
                  {cli.platformNote ? <small className="settings-cli-note">{cli.platformNote}</small> : null}
                </div>
                {registered ? (
                  <span className="agent-cli-registered">
                    <CheckCircle size={12} weight="fill" /> 已注册
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={registeringKey !== null}
                    onClick={() => onRegister(cli)}
                  >
                    {registeringKey === cli.key ? "注册中…" : "注册"}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
