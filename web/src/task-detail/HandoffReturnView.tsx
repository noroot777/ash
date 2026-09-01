import type { HandoffPeerIdentity } from "@ash/shared";
import { Fingerprint, SpinnerGap, Warning } from "@phosphor-icons/react";

// 移回的对话框刻意做得比接力短:移回没有任何可选项——目标机被任务记录的来源指纹
// 锁死,落哪个项目由原机的历史存档决定,连"选来源机地址"都该是系统自己探出来的。
// 所以这里不摆下拉、不摆路线图、不摆盘点表,只回答三件事:回哪台、有没有连上、
// 有没有需要先知道的意外。正常路径就是一句话加一个「确认移回」。
export type HandoffReturnPhase = "locating" | "ready" | "unreachable";

/**
 * 把预检抛回来的网络错误翻成人话。地址前缀去掉——它已经显示在同一句话里了;认不出来
 * 的原样留着,宁可技术味重也别把唯一的线索吞掉。
 */
function readableReason(message: string | null): string {
  const raw = (message ?? "").replace(/^连不上对端 ash（[^）]*）[:：]\s*/, "").trim();
  if (/ECONNREFUSED|fetch failed/i.test(raw)) return "它没有应答——那台机器上的 ash 多半没在跑，或者端口被挡住了。";
  if (/ETIMEDOUT|timeout|超时/i.test(raw)) return "连接超时——地址可能已经不对，或者两台机器不在同一个网络里。";
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return "这个主机名解析不出来。";
  return raw || "没有拿到应答。";
}

export function HandoffReturnView({
  phase,
  fallbackNotice,
  peerName,
  peerUrl,
  peer,
  taskScopedReturn,
  running,
  notes,
  errorMessage,
  identityMissing,
  autoResume,
  autoResumeLocked,
  accepted,
  replay,
  busy,
  onAutoResumeChange,
}: {
  phase: HandoffReturnPhase;
  /** 系统自动换过一次来源地址时的说明——替用户做过的事要说出来。 */
  fallbackNotice: string | null;
  peerName: string;
  peerUrl: string | null;
  peer: HandoffPeerIdentity | null;
  taskScopedReturn: boolean;
  running: boolean;
  notes: string[];
  errorMessage: string | null;
  /** 老记录连来源机指纹都没有:重试多少次也定位不出该回哪台,只能从来源机重新接力。 */
  identityMissing: boolean;
  autoResume: boolean;
  autoResumeLocked: boolean;
  /** 任务已验收/已合并:回去也不会自己跑起来,续跑框不该还立在那里骗人点。 */
  accepted: boolean;
  replay: boolean;
  busy: boolean;
  onAutoResumeChange: (next: boolean) => void;
}) {
  return (
    <>
      <p>
        把这个任务连同 git 分支、CLI 会话历史移回<b>{peerName}</b>。
        目标已按来源机指纹锁定，不能转送到第三台机器。
      </p>
      {replay && (
        <p className="handoff-error">
          <Warning size={13} aria-hidden="true" />
          上次移回没收到确认，这次会按同一来源机、原项目和续跑选项原样重放。若要放弃本次移回，
          请先关闭弹窗并使用横幅上的“核验后在本机继续”；系统会先确认原机尚未接回任务。
        </p>
      )}
      {fallbackNotice && (
        <p className="handoff-peer-line is-warn">
          <Warning size={13} aria-hidden="true" /><span>{fallbackNotice}</span>
        </p>
      )}
      {phase === "locating" && (
        <p className="handoff-probing">
          <SpinnerGap size={13} className="is-spinning" aria-hidden="true" />
          正在联系来源机器…
        </p>
      )}
      {phase === "unreachable" && (identityMissing ? (
        <p className="handoff-error">
          <Warning size={13} aria-hidden="true" />
          这条旧记录没有来源机指纹，无法安全判断该移回哪台机器。请从来源机重新接力一次。
        </p>
      ) : (
        <>
          <p className="handoff-error">
            <Warning size={13} aria-hidden="true" />
            连不上来源机器{peerUrl ? `（${peerUrl}）` : ""}。{readableReason(errorMessage)}
          </p>
          <ul className="handoff-summary">
            <li>确认那台机器开着、ash 正在运行，并且和本机在同一个网络里</li>
            <li>如果它换了地址，在「设置 → 远程主机」里更新后再重新检查</li>
          </ul>
        </>
      ))}
      {phase === "ready" && (
        <>
          <p className="handoff-peer-line">
            <Fingerprint size={13} aria-hidden="true" />
            <span>
              {peerUrl}
              {peer ? <>　身份 <b>{peer.short}</b></> : null}
              {peer
                ? taskScopedReturn
                  ? "（与这条任务接入时记录的来源指纹一致，无需重复审批）"
                  : "（指纹一致；原机存档不可用，本次按普通接力审批）"
                : "（对端没报出身份，无法核对是不是原来那台机器）"}
            </span>
          </p>
          {running && (
            <p className="handoff-probing">
              <Warning size={13} aria-hidden="true" />
              任务正在运行，移回会先把它停下来。
            </p>
          )}
          {notes.length > 0 && <ul className="handoff-summary">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
          {accepted ? (
            <p className="handoff-peer-line">
              <Warning size={13} aria-hidden="true" />
              <span>
                任务已验收，回到来源机<b>不会自动续跑</b>（续跑会把验收结论和合并快照整套摘掉）。
              </span>
            </p>
          ) : (
            <label className="handoff-check">
              <input
                type="checkbox"
                checked={autoResume}
                disabled={busy || autoResumeLocked}
                onChange={(event) => onAutoResumeChange(event.target.checked)}
              />
              回到来源机后立即续跑
            </label>
          )}
        </>
      )}
    </>
  );
}
