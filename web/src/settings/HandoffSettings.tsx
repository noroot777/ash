import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, HandoffIdentity, HandoffPeer, HandoffTarget } from "@ash/shared";
import { Check, Fingerprint, Plus, Prohibit, Trash } from "@phosphor-icons/react";
import { Button, TextInput, Toggle } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

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
  const [busy, setBusy] = useState(false);
  // 目标行另存一份草稿:半填的行(名字有了 url 还没敲完)留在本地继续编辑,
  // 只有完整合法的行才落库,所以不能每次都用服务端返回值倒灌回输入框。
  const [targets, setTargets] = useState<HandoffTarget[]>(settings.handoffTargets);
  const [forgetIndex, setForgetIndex] = useState<number | null>(null);

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

  const reloadPeers = useCallback(() => {
    api.handoffPeers()
      .then(setPeers)
      .catch((error) => notify(error instanceof Error ? error.message : "接力来源读取失败"));
  }, [notify]);

  useEffect(() => { reloadPeers(); }, [reloadPeers]);

  const saveTargets = useCallback(
    async (next: HandoffTarget[]) => {
      setTargets(next);
      const complete = next
        .filter((item) => item.name.trim() && HANDOFF_URL_RE.test(item.url.trim()))
        .map((item) => ({
          name: item.name.trim(),
          url: item.url.trim().replace(/\/+$/, ""),
          // 记住的指纹跟着这一行走:改名字不该让信任失效,改地址才该(下面单独处理)。
          ...(item.peerFp ? { peerFp: item.peerFp } : {}),
        }));
      if (JSON.stringify(complete) === JSON.stringify(settings.handoffTargets)) return;
      try {
        onSettings(await api.patchSettings({ handoffTargets: complete }));
      } catch (error) {
        notify(error instanceof Error ? error.message : "接力目标保存失败");
      }
    },
    [notify, onSettings, settings.handoffTargets],
  );

  const peerAction = async (peer: HandoffPeer, action: "approve" | "block" | "forget") => {
    setBusy(true);
    try {
      if (action === "forget") await api.forgetHandoffPeer(peer.fingerprint);
      else await api.setHandoffPeerStatus(peer.fingerprint, action);
      reloadPeers();
    } catch (error) {
      notify(error instanceof Error ? error.message : "接力来源更新失败");
    } finally {
      setBusy(false);
    }
  };

  const forgetTarget = targets[forgetIndex ?? -1] ?? null;

  return (
    <section className="settings-section">
      <h2>任务接力</h2>
      <div className="settings-card">
        <div className="settings-row handoff-identity">
          <div>
            <b>本机接力身份</b>
            <small>
              别的机器第一次接力过来时会显示这串指纹，两边对上了再批准。私钥只存在本机数据目录，不随任何请求外传。
            </small>
          </div>
          <span className="handoff-fingerprint">
            <Fingerprint size={12} aria-hidden="true" />
            {identity ? identity.short : "读取中…"}
          </span>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <div>
            <b>接力目标机器</b>
            <small>
              另一台 ash 的根地址。第一次接力成功后会记住它的身份指纹，之后这个地址要是换了机器，接力会在打包前被拦下。
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
            {item.peerFp ? (
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
              <span className="handoff-fingerprint is-unknown">首次接力后记住</span>
            )}
            <Button
              variant="icon"
              aria-label={`删除接力目标 ${item.name || item.url || String(index + 1)}`}
              disabled={loading}
              onClick={() => void saveTargets(targets.filter((_, i) => i !== index))}
            >
              <Trash size={13} aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <div>
            <b>接力进来要先批准</b>
            <small>
              开启后，别的机器必须先在下面被你放行，且每个接力请求都要带它自己的密钥签名。
              关掉就退回旧行为：任何连得上这个端口的机器都能把任务推进本机。
            </small>
          </div>
          <Toggle
            label={settings.handoffRequireApproval ? "已开启" : "已关闭"}
            checked={settings.handoffRequireApproval}
            disabled={loading || busy}
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
            <b>接力来源</b>
            <small>谁尝试过把任务接力进本机。身份看指纹，不看地址——地址会漂，指纹不会。</small>
          </div>
        </div>
        {peers.length === 0 ? (
          <p className="handoff-peer-empty">
            还没有别的机器尝试接力进来。对方第一次接力时会自动出现在这里等你批准。
          </p>
        ) : (
          peers.map((peer) => (
            <div className={`settings-row handoff-peer-row is-${peer.status}`} key={peer.fingerprint}>
              <div>
                <b>
                  {peer.name || "未命名机器"}
                  <span className="handoff-peer-state">
                    {peer.status === "approved" ? "已批准" : peer.status === "blocked" ? "已拒绝" : "待批准"}
                  </span>
                </b>
                <small>
                  指纹 {peer.short}
                  {peer.lastAddr ? ` · 来自 ${peer.lastAddr}` : ""}
                  {` · 最近 ${new Date(peer.lastSeenAt).toLocaleString()}`}
                </small>
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

const HANDOFF_URL_RE = /^https?:\/\/\S+$/;

/** 和服务端 shortFingerprint 同一套:前 20 个 hex 分 5 组,只用于展示。 */
const shortOf = (fingerprint: string) =>
  (fingerprint.slice(0, 20).toUpperCase().match(/.{1,4}/g) ?? []).join("-");
