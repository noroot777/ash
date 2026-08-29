import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  HandoffApprovalResult,
  HandoffIdentity,
  HandoffPeer,
  HandoffReturnGrant,
  HandoffTarget,
} from "@ash/shared";
import { Check, Fingerprint, PaperPlaneTilt, Plus, Prohibit, SpinnerGap, Trash } from "@phosphor-icons/react";
import { useIsInstanceAdmin, useIsMultiUser } from "../auth/authContext.ts";
import { Button, TextInput, Toggle } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import {
  approvalNotice,
  approvalStateClass,
  approvalStateLabel,
  HANDOFF_PEERS_CHANGED_EVENT,
  HANDOFF_URL_RE,
  normalizeTargetUrl,
  shortOf,
} from "./handoffTargetUi.ts";
import { HandoffPeerKeyField } from "./HandoffPeerKeyField.tsx";
import { UserHandoffTargets } from "./UserHandoffTargets.tsx";

// 设置页的「任务接力」整段:本机身份 + 出站目标(含记住的对端指纹)+ 入站来源审批。
//
// 两个方向别混,它们防的不是同一件事:
//  · **目标机器**(出站)= 我把任务发到哪。第一次接力成功后记住对端的公钥指纹(TOFU),
//    以后这个地址换了机器就在打包之前当场拦下 —— 接力推出去的是整个仓库和完整会话
//    历史,而地址是会漂的(DHCP 换租约、有人抢地址),这道核对是唯一拦得住「发错机器」的。
//  · **接力来源**(入站)= 谁能把任务推进本机。陌生机器敲过门就落进待批准列表,点一下
//    放行;没批准的连项目清单都拿不到。
export function HandoffSettings({
  settings,
  loading,
  onSettings,
  notify,
}: {
  settings: AppSettings;
  loading: boolean;
  onSettings: (next: AppSettings) => void;
  notify: (message: string) => void;
}) {
  const [identity, setIdentity] = useState<HandoffIdentity | null>(null);
  const [peers, setPeers] = useState<HandoffPeer[]>([]);
  const [returnGrants, setReturnGrants] = useState<HandoffReturnGrant[]>([]);
  const [busy, setBusy] = useState(false);
  // 目标行另存一份草稿:半填的行(名字有了 url 还没敲完)留在本地继续编辑,
  // 只有完整合法的行才落库,所以不能每次都用服务端返回值倒灌回输入框。
  const [targets, setTargets] = useState<HandoffTarget[]>(settings.handoffTargets);
  const [forgetIndex, setForgetIndex] = useState<number | null>(null);
  const [approvalByUrl, setApprovalByUrl] = useState<Record<string, HandoffApprovalResult>>({});
  const [approvalBusyUrl, setApprovalBusyUrl] = useState<string | null>(null);
  // 自用模式下「我在对端的账号 key」不住在设置里(它是凭证,`GET /settings` 会把整份
  // 吐回前端),所以哪几台配过 key 得单独问一次 `/handoff/targets` —— 那条路只报 hasKey。
  const [keyedUrls, setKeyedUrls] = useState<Set<string>>(new Set());
  const isMulti = useIsMultiUser();
  const isInstanceAdmin = useIsInstanceAdmin();
  // 两件事,门禁不一样:
  //  · **入站策略**(要不要审批、加不加密、载荷上限)= 整台机器的安全姿态,一个人关掉
  //    等于替所有人开门,所以多人模式下只有实例管理员能改(§八 实例面)。
  //  · **来源名单**的批准/拒绝 = 计划点名的「全员可见可批」(§十一,互信定位),
  //    任何登录用户都能点,服务端记下操作人。
  const canManageInstance = !isMulti || isInstanceAdmin;
  const lockInstance = loading || busy || !canManageInstance;

  // 只在首次读回设置时倒灌一次输入框:每次 PATCH 都会拿到一个新数组引用,跟着同步
  // 就会把用户正在敲的半截行(名字有了 url 还没敲完)冲掉。
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || loading) return;
    seeded.current = true;
    setTargets(settings.handoffTargets);
  }, [loading, settings.handoffTargets]);

  useEffect(() => {
    api.handoffIdentity()
      .then(setIdentity)
      .catch((error) => notify(error instanceof Error ? error.message : "本机接力身份读取失败"));
  }, [notify]);

  const applyTargetKeys = useCallback((rows: HandoffTarget[]) => {
    setKeyedUrls(new Set(rows.filter((row) => row.hasKey).map((row) => normalizeTargetUrl(row.url).toLowerCase())));
  }, []);

  useEffect(() => {
    // 多人模式那份清单自己带 hasKey(UserHandoffTargets 直接读 `/handoff/targets`)。
    if (isMulti) return;
    api.handoffTargets()
      .then(applyTargetKeys)
      .catch((error) => notify(error instanceof Error ? error.message : "对端账号 key 状态读取失败"));
  }, [applyTargetKeys, isMulti, notify]);

  const reloadPeers = useCallback(() => {
    Promise.all([api.handoffPeers(), api.handoffReturnGrants()])
      .then(([nextPeers, nextGrants]) => {
        setPeers(nextPeers);
        setReturnGrants(nextGrants);
      })
      .catch((error) => notify(error instanceof Error ? error.message : "接力来源读取失败"));
  }, [notify]);

  useEffect(() => { reloadPeers(); }, [reloadPeers]);
  useEffect(() => {
    const onChanged = () => reloadPeers();
    window.addEventListener(HANDOFF_PEERS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(HANDOFF_PEERS_CHANGED_EVENT, onChanged);
  }, [reloadPeers]);

  const saveTargets = useCallback(
    async (next: HandoffTarget[]): Promise<boolean> => {
      setTargets(next);
      const complete = next
        .filter((item) => item.name.trim() && HANDOFF_URL_RE.test(item.url.trim()))
        .map((item) => ({
          name: item.name.trim(),
          url: item.url.trim().replace(/\/+$/, ""),
          // 记住的指纹跟着这一行走:改名字不该让信任失效,改地址才该(下面单独处理)。
          ...(item.peerFp ? { peerFp: item.peerFp } : {}),
        }));
      if (JSON.stringify(complete) === JSON.stringify(settings.handoffTargets)) return true;
      try {
        onSettings(await api.patchSettings({ handoffTargets: complete }));
        return true;
      } catch (error) {
        notify(error instanceof Error ? error.message : "接力目标保存失败");
        return false;
      }
    },
    [notify, onSettings, settings.handoffTargets],
  );

  const peerAction = async (
    peer: Pick<HandoffPeer, "fingerprint">,
    action: "approve" | "block" | "unblock" | "forget",
  ) => {
    setBusy(true);
    try {
      if (action === "forget") await api.forgetHandoffPeer(peer.fingerprint);
      else if (action === "unblock") await api.unblockHandoffPeer(peer.fingerprint);
      else await api.setHandoffPeerStatus(peer.fingerprint, action);
      reloadPeers();
      window.dispatchEvent(new Event(HANDOFF_PEERS_CHANGED_EVENT));
    } catch (error) {
      notify(error instanceof Error ? error.message : "接力来源更新失败");
    } finally {
      setBusy(false);
    }
  };

  const requestApproval = async (item: HandoffTarget) => {
    const targetUrl = item.url.trim().replace(/\/+$/, "");
    if (!item.name.trim() || !HANDOFF_URL_RE.test(targetUrl)) {
      notify("先把远程主机的名字和 http(s) 地址填完整");
      return;
    }
    if (!(await saveTargets(targets))) return;
    setApprovalBusyUrl(targetUrl);
    try {
      const result = await api.requestHandoffApproval(targetUrl);
      setApprovalByUrl((current) => ({ ...current, [targetUrl]: result }));
      if (result.peer) {
        setTargets((current) => current.map((target) =>
          target.url.trim().replace(/\/+$/, "") === targetUrl
            ? { ...target, peerFp: result.peer!.fingerprint }
            : target));
        onSettings(await api.settings());
      }
      notify(approvalNotice(item.name.trim(), result));
    } catch (error) {
      notify(error instanceof Error ? error.message : "接力申请发送失败");
    } finally {
      setApprovalBusyUrl(null);
    }
  };

  const forgetTarget = targets[forgetIndex ?? -1] ?? null;
  const inboundPeers = peers.filter((peer) => !peer.returnOnly);

  return (
    <section className="settings-section">
      <h2>任务接力</h2>
      <div className="settings-card">
        <div className="settings-row handoff-identity">
          <div>
            <b>本机接力身份</b>
            <small>
              别的机器第一次申请接力时会显示这串指纹，两边对上了再批准。私钥只存在本机数据目录，不随任何请求外传。
            </small>
          </div>
          <span className="handoff-fingerprint">
            <Fingerprint size={12} aria-hidden="true" />
            {identity ? identity.short : "读取中…"}
          </span>
        </div>
      </div>

      {isMulti ? <UserHandoffTargets notify={notify} /> : (
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <b>接力目标机器</b>
              <small>
                另一台 ash 的根地址。第一次明确申请时会记住它的身份指纹，之后这个地址要是换了机器，申请和接力都会被拦下。
                <br />
                目标机是<b>多人实例</b>时还要填<b>你在那台机器上的账号 key</b>——
                接力用的是你在对端的身份，能推进哪些项目由对端的成员名单决定。没有账号就找对端管理员开一个。
              </small>
            </div>
            <Button
              variant="ghost"
              disabled={loading}
              onClick={() => setTargets([...targets, { name: "", url: "" }])}
            >
              <Plus size={13} aria-hidden="true" />添加
            </Button>
          </div>
          {targets.map((item, index) => (
            <div className="settings-row handoff-target-row" key={index}>
              <TextInput
                placeholder="名字（如 家里的台式机）"
                className="handoff-target-name"
                value={item.name}
                disabled={loading}
                onChange={(event) => {
                  const next = targets.slice();
                  next[index] = { ...item, name: event.target.value };
                  setTargets(next);
                }}
                onBlur={() => void saveTargets(targets)}
              />
              <TextInput
                placeholder="http://192.168.1.50:4317"
                value={item.url}
                disabled={loading}
                onChange={(event) => {
                  const next = targets.slice();
                  // 地址改了就把记住的指纹一起丢掉:那串指纹是对**上一个地址**背后那台
                  // 机器的承诺,跟着新地址走就成了一句凭空的担保。
                  const peerFp = event.target.value.trim() === item.url.trim() ? item.peerFp : null;
                  next[index] = { ...item, url: event.target.value, peerFp };
                  setTargets(next);
                }}
                onBlur={() => void saveTargets(targets)}
              />
              <Button
                variant="ghost"
                className="handoff-target-request"
                disabled={loading || approvalBusyUrl !== null
                  || !item.name.trim() || !HANDOFF_URL_RE.test(item.url.trim())}
                onClick={() => void requestApproval(item)}
              >
                {approvalBusyUrl === item.url.trim().replace(/\/+$/, "")
                  ? <SpinnerGap size={13} className="is-spinning" aria-hidden="true" />
                  : <PaperPlaneTilt size={13} aria-hidden="true" />}
                {approvalByUrl[item.url.trim().replace(/\/+$/, "")] || item.peerFp ? "检查状态" : "申请"}
              </Button>
              {approvalByUrl[item.url.trim().replace(/\/+$/, "")] ? (
                <span className={`handoff-approval-state ${approvalStateClass(approvalByUrl[item.url.trim().replace(/\/+$/, "")])}`}>
                  {approvalStateLabel(approvalByUrl[item.url.trim().replace(/\/+$/, "")])}
                </span>
              ) : item.peerFp ? (
                <button
                  type="button"
                  className="handoff-fingerprint is-known"
                  disabled={loading}
                  aria-label={`忘记「${item.name || item.url}」记住的身份指纹`}
                  onClick={() => setForgetIndex(index)}
                >
                  <Fingerprint size={12} aria-hidden="true" />
                  {shortOf(item.peerFp)}
                </button>
              ) : (
                <span className="handoff-approval-state is-unknown">申请后核对身份</span>
              )}
              <Button
                variant="icon"
                aria-label={`删除接力目标 ${item.name || item.url || String(index + 1)}`}
                disabled={loading}
                onClick={() => void saveTargets(targets.filter((_, i) => i !== index))}
              >
                <Trash size={13} aria-hidden="true" />
              </Button>
              {/* key 按**地址**存(自用模式那份清单没有行 id),所以地址还没敲完整的半截行
                  先不给填 —— 填进去会落到一个不存在的目标上。 */}
              <HandoffPeerKeyField
                url={normalizeTargetUrl(item.url)}
                hasKey={keyedUrls.has(normalizeTargetUrl(item.url).toLowerCase())}
                mode="row"
                disabled={loading || !HANDOFF_URL_RE.test(item.url.trim())}
                notify={notify}
                onSaved={applyTargetKeys}
              />
            </div>
          ))}
        </div>
      )}

      <div className="settings-card">
        <div className="settings-row">
          <div>
            <b>接力进来要先批准</b>
            <small>
              开启后，别的机器必须先在下面被你放行，且每个接力请求都要带它自己的密钥签名。
              关掉就退回旧行为：任何连得上这个端口的机器都能把任务推进本机。
              {isMulti && (
                <>
                  <br />
                  批准一台机器只是<b>让它敲得开门</b>：它上面的每个人能把任务推进哪些项目，仍由那个人
                  在本机的账号和项目成员名单决定——机器指纹管传输，账号管权限，两层各管各的。
                  下面的来源名单<b>谁都能批</b>（批了会记名）；这三个开关是整台机器的安全姿态
                  {!canManageInstance && "，只有实例管理员能改"}。
                </>
              )}
            </small>
          </div>
          <Toggle
            label={settings.handoffRequireApproval ? "已开启" : "已关闭"}
            checked={settings.handoffRequireApproval}
            disabled={lockInstance}
            onChange={async (checked) => {
              try {
                onSettings(await api.patchSettings({ handoffRequireApproval: checked }));
              } catch (error) {
                notify(error instanceof Error ? error.message : "接力审批开关保存失败");
              }
            }}
          />
        </div>
        <div className="settings-row handoff-peer-head">
          <div>
            <b>接力传输加密</b>
            <small>
              接力载荷（整个 git bundle + 完整 CLI 会话历史）出门前用对端公钥加密，
              防同网段抓包。冒充和篡改本来就由签名挡着，这一条只管窃听，关掉不影响身份校验。
              <br />
              调试接力本身时可以关掉——密文在抓包工具里看不了。对端太旧收不了加密载荷时会自动回退成明文，
              接力对话框里会写明这次是不是明文。
            </small>
          </div>
          <Toggle
            label={settings.handoffEncrypt ? "已开启" : "已关闭（明文）"}
            checked={settings.handoffEncrypt}
            disabled={lockInstance}
            onChange={async (checked) => {
              try {
                onSettings(await api.patchSettings({ handoffEncrypt: checked }));
              } catch (error) {
                notify(error instanceof Error ? error.message : "接力加密开关保存失败");
              }
            }}
          />
        </div>
        <div className="settings-row handoff-peer-head">
          <div>
            <b>接力载荷上限</b>
            <small>
              单次接力最多收多大的载荷（MB）。超过就在读取过程中掐断，不等读完——
              验签必须等 body 读完（签名覆盖 body 哈希），没有这条闸，一个巨大的请求
              不用带任何签名就能把内存吃光。
              <br />
              512 是硬顶：载荷最终要变成一个 JS 字符串，Node 的字符串最长就这么大。
              接力失败提示「超过上限」而任务确实很大时，先在两边把仓库同步到相近的提交——
              历史对齐了就只打增量包。
            </small>
          </div>
          <input
            type="number"
            className="ui-input handoff-body-limit"
            min={1}
            max={512}
            step={1}
            value={settings.handoffMaxBodyMb}
            disabled={lockInstance}
            onChange={(e) => onSettings({ ...settings, handoffMaxBodyMb: Number(e.target.value) })}
            onBlur={async (e) => {
              const mb = Math.min(512, Math.max(1, Math.round(Number(e.target.value) || 512)));
              try {
                onSettings(await api.patchSettings({ handoffMaxBodyMb: mb }));
              } catch (error) {
                notify(error instanceof Error ? error.message : "接力载荷上限保存失败");
              }
            }}
          />
        </div>
        <div className="settings-row handoff-peer-head">
          <div>
            <b>接力来源</b>
            <small>谁尝试过把任务接力进本机。身份看指纹，不看地址——地址会漂，指纹不会。</small>
          </div>
        </div>
        {inboundPeers.length === 0 ? (
          <p className="handoff-peer-empty">
            还没有别的机器申请接力进来。对方第一次申请时会自动出现在这里等你批准。
          </p>
        ) : (
          inboundPeers.map((peer) => (
            <div className={`settings-row handoff-peer-row is-${peer.status}`} key={peer.fingerprint}>
              <div>
                <b>
                  {peer.name || "未命名机器"}
                  <span className="handoff-peer-state">
                    {peer.status === "approved" ? "已批准" : peer.status === "blocked" ? "已拒绝" : "待批准"}
                  </span>
                  {peerModeLabel(peer.peerMode) && (
                    <span className="handoff-peer-mode">{peerModeLabel(peer.peerMode)}</span>
                  )}
                </b>
                <small>
                  指纹 {peer.short}
                  {peer.lastAddr ? ` · 来自 ${peer.lastAddr}` : ""}
                  {` · 最近 ${new Date(peer.lastSeenAt).toLocaleString()}`}
                  {peer.approvedByName ? ` · 由 ${peer.approvedByName} 处理` : ""}
                </small>
                {/* 知情批准(§十一):对方是多人实例时,批准的是**那台机器**,
                    它上面的每个人都能经这条路敲门。这句话必须在点「批准」之前看得见。 */}
                {peer.status !== "approved" && multiPeerCount(peer.peerMode) !== null && (
                  <small className="handoff-peer-warn">
                    对方是多人实例（{multiPeerCount(peer.peerMode)} 个账号）：批准后，那台机器上的
                    <b>所有用户</b>都能经这次配对把任务接力进来。他们各自能推进哪些项目，仍由他们在本机的账号和项目成员名单决定。
                  </small>
                )}
              </div>
              <div className="handoff-peer-actions">
                {peer.status !== "approved" && (
                  <Button variant="ghost" disabled={busy} onClick={() => void peerAction(peer, "approve")}>
                    <Check size={13} aria-hidden="true" />批准
                  </Button>
                )}
                {peer.status !== "blocked" && (
                  <Button variant="ghost" disabled={busy} onClick={() => void peerAction(peer, "block")}>
                    <Prohibit size={13} aria-hidden="true" />拒绝
                  </Button>
                )}
                <Button
                  variant="icon"
                  aria-label={`忘记接力来源 ${peer.name || peer.short}`}
                  disabled={busy}
                  onClick={() => void peerAction(peer, "forget")}
                >
                  <Trash size={13} aria-hidden="true" />
                </Button>
              </div>
            </div>
          ))
        )}
        <div className="settings-row handoff-peer-head">
          <div>
            <b>历史回程权限</b>
            <small>
              曾接走任务的机器只能把对应历史任务免审批移回，不等于整机已批准。
              拒绝会立即阻止该指纹的所有接力与历史回程，避免遗留权限不可见、不可撤销。
            </small>
          </div>
        </div>
        {returnGrants.length === 0 ? (
          <p className="handoff-peer-empty">当前没有机器持有历史任务的免审批回程权限。</p>
        ) : returnGrants.map((grant) => (
          <div className={`settings-row handoff-peer-row${grant.blocked ? " is-blocked" : " is-approved"}`} key={grant.fingerprint}>
            <div>
              <b>
                {grant.name || "历史持有机器"}
                <span className="handoff-peer-state">{grant.blocked ? "已撤销" : `可移回 ${grant.taskCount} 条任务`}</span>
              </b>
              <small>
                指纹 {grant.short} · 最近授权 {new Date(grant.lastGrantedAt).toLocaleString()}
              </small>
            </div>
            <div className="handoff-peer-actions">
              {grant.blocked ? (
                <Button variant="ghost" disabled={busy} onClick={() => void peerAction(grant, "unblock")}>
                  <Check size={13} aria-hidden="true" />解除拒绝
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void peerAction(grant, "block")}
                >
                  <Prohibit size={13} aria-hidden="true" />拒绝这台机器
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {forgetTarget && (
        <ConfirmDialog
          title="忘记记住的对端身份"
          message={
            `清除后，下一次接力到「${forgetTarget.name || forgetTarget.url}」会按首次配对处理：`
            + "那个地址背后换成了别的机器也不会被拦住。只有在你确认那台机器重装过、或者换了新机器时才这么做。"
          }
          confirmLabel="清除并重新配对"
          danger
          busy={loading}
          onConfirm={() => {
            const index = forgetIndex!;
            setForgetIndex(null);
            void saveTargets(targets.map((t, i) => (i === index ? { ...t, peerFp: null } : t)));
          }}
          onClose={() => setForgetIndex(null)}
        />
      )}
    </section>
  );
}

/** 对端自报的模式标签。`multi:3` → 3;不是多人实例(或老版本没报)→ null。 */
const multiPeerCount = (mode?: string): number | null => {
  const hit = /^multi:(\d+)$/.exec(mode ?? "");
  return hit ? Number(hit[1]) : null;
};

const peerModeLabel = (mode?: string): string => {
  if (mode === "single") return "自用实例";
  const count = multiPeerCount(mode);
  return count === null ? "" : `多人实例 · ${count} 人`;
};
