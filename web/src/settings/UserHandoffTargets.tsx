import { useCallback, useEffect, useState } from "react";
import type { HandoffApprovalResult, HandoffTarget } from "@ash/shared";
import { Fingerprint, Key, PaperPlaneTilt, Plus, SpinnerGap, Trash } from "@phosphor-icons/react";
import { Button, TextInput } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import {
  approvalNotice,
  approvalStateClass,
  approvalStateLabel,
  HANDOFF_URL_RE,
  normalizeTargetUrl,
  shortOf,
} from "./handoffTargetUi.ts";

// 多人模式的接力目标机清单(§十一)。跟自用模式那份的区别只有一处,但那一处是要害:
// **每行带着「我在对端的账号 key」**,所以清单必须按人存、不能进 app_settings —— 那份
// 设置会被 `GET /settings` 整份吐给前端,一个打开的网页就等于拿走全部对端凭据。
//
// 两层信任别混:
//  · **机器指纹**(peerFp)= 这个地址背后还是不是原来那台机器,防的是地址漂了/被顶替;
//    整机一次配对,全实例共用。
//  · **账号 key**(peerKey)= 对端认不认识**我这个人**。对端是多人实例时没有它就只能
//    看到空的项目列表,所以接力会当场报错,而不是让人对着「对方一个项目都没有」发懵。
//
// key 是凭证,读侧永不回显(同 project_git_credentials 待遇),只报 hasKey。
export function UserHandoffTargets({ notify }: { notify: (message: string) => void }) {
  const [targets, setTargets] = useState<HandoffTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: "", url: "", peerKey: "" });
  // 改 key 是显式动作:默认收起,点「换一把」才展开输入框。省得每次进设置页都看见
  // 一排空的密码框,让人以为 key 丢了。
  const [keyEdit, setKeyEdit] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<HandoffTarget | null>(null);
  const [approvalByUrl, setApprovalByUrl] = useState<Record<string, HandoffApprovalResult>>({});
  const [approvalBusyUrl, setApprovalBusyUrl] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.handoffTargets()
      .then(setTargets)
      .catch((error) => notify(error instanceof Error ? error.message : "接力目标机读取失败"))
      .finally(() => setLoading(false));
  }, [notify]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<HandoffTarget[]>, failure: string) => {
    setBusy(true);
    try {
      setTargets(await fn());
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const name = draft.name.trim();
    const url = normalizeTargetUrl(draft.url);
    if (!name || !HANDOFF_URL_RE.test(url)) {
      notify("先把名字和 http(s) 地址填完整");
      return;
    }
    if (await run(() => api.addHandoffTarget({ name, url, peerKey: draft.peerKey.trim() }), "接力目标机添加失败")) {
      setDraft({ name: "", url: "", peerKey: "" });
    }
  };

  const patch = (target: HandoffTarget, next: { name?: string; url?: string; peerKey?: string }) =>
    run(() => api.patchHandoffTarget(target.id!, next), "接力目标机保存失败");

  const requestApproval = async (target: HandoffTarget) => {
    const url = normalizeTargetUrl(target.url);
    setApprovalBusyUrl(url);
    try {
      const result = await api.requestHandoffApproval(url);
      setApprovalByUrl((current) => ({ ...current, [url]: result }));
      // 配对成功会在服务端记下指纹,重新读一遍清单把它显示出来。
      if (result.peer) load();
      notify(approvalNotice(target.name, result));
    } catch (error) {
      notify(error instanceof Error ? error.message : "接力申请发送失败");
    } finally {
      setApprovalBusyUrl(null);
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-row">
        <div>
          <b>我的接力目标机</b>
          <small>
            另一台 ash 的根地址。这份清单只属于你，别人看不到，也用不了你填的 key。
            <br />
            目标机也是多人实例时，还要填<b>你在那台机器上的账号 key</b>——
            接力用的是你在对端的身份，能推进哪些项目由对端那边的成员名单决定。没有账号就找对端管理员开一个。
          </small>
        </div>
      </div>

      {loading ? (
        <p className="handoff-peer-empty">读取中…</p>
      ) : targets.length === 0 ? (
        <p className="handoff-peer-empty">还没有添加过目标机。填下面一行加第一台。</p>
      ) : (
        targets.map((target) => {
          const url = normalizeTargetUrl(target.url);
          const editing = keyEdit[target.id!] !== undefined;
          return (
            <div className="settings-row handoff-target-row is-user" key={target.id}>
              <TextInput
                placeholder="名字（如 家里的台式机）"
                className="handoff-target-name"
                defaultValue={target.name}
                disabled={busy}
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  if (name && name !== target.name) void patch(target, { name });
                }}
              />
              <TextInput
                placeholder="http://192.168.1.50:4317"
                defaultValue={target.url}
                disabled={busy}
                onBlur={(event) => {
                  const next = normalizeTargetUrl(event.target.value);
                  if (HANDOFF_URL_RE.test(next) && next !== url) void patch(target, { url: next });
                }}
              />
              <Button
                variant="ghost"
                className="handoff-target-request"
                disabled={busy || approvalBusyUrl !== null}
                onClick={() => void requestApproval(target)}
              >
                {approvalBusyUrl === url
                  ? <SpinnerGap size={13} className="is-spinning" aria-hidden="true" />
                  : <PaperPlaneTilt size={13} aria-hidden="true" />}
                {approvalByUrl[url] || target.peerFp ? "检查状态" : "申请"}
              </Button>
              {approvalByUrl[url] ? (
                <span className={`handoff-approval-state ${approvalStateClass(approvalByUrl[url])}`}>
                  {approvalStateLabel(approvalByUrl[url])}
                </span>
              ) : target.peerFp ? (
                <span className="handoff-fingerprint is-known">
                  <Fingerprint size={12} aria-hidden="true" />
                  {shortOf(target.peerFp)}
                </span>
              ) : (
                <span className="handoff-approval-state is-unknown">申请后核对身份</span>
              )}
              <Button
                variant="icon"
                aria-label={`删除接力目标 ${target.name}`}
                disabled={busy}
                onClick={() => setRemoving(target)}
              >
                <Trash size={13} aria-hidden="true" />
              </Button>
              <div className="handoff-target-key">
                <Key size={12} aria-hidden="true" />
                {editing ? (
                  <>
                    <TextInput
                      type="password"
                      placeholder="ash_… （你在对端的账号 key）"
                      value={keyEdit[target.id!]}
                      autoComplete="off"
                      disabled={busy}
                      onChange={(event) =>
                        setKeyEdit((current) => ({ ...current, [target.id!]: event.target.value }))}
                    />
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={async () => {
                        if (await patch(target, { peerKey: keyEdit[target.id!].trim() })) {
                          setKeyEdit(({ [target.id!]: _drop, ...rest }) => rest);
                        }
                      }}
                    >
                      保存
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setKeyEdit(({ [target.id!]: _drop, ...rest }) => rest)}
                    >
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <small>{target.hasKey ? "已配置对端账号 key（不回显）" : "还没配对端账号 key"}</small>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setKeyEdit((current) => ({ ...current, [target.id!]: "" }))}
                    >
                      {target.hasKey ? "换一把" : "填写"}
                    </Button>
                    {target.hasKey && (
                      <Button variant="ghost" disabled={busy} onClick={() => void patch(target, { peerKey: "" })}>
                        清除
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })
      )}

      <div className="settings-row handoff-target-row is-draft">
        <TextInput
          placeholder="名字（如 家里的台式机）"
          className="handoff-target-name"
          value={draft.name}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <TextInput
          placeholder="http://192.168.1.50:4317"
          value={draft.url}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, url: event.target.value })}
        />
        <TextInput
          type="password"
          placeholder="对端账号 key（选填）"
          value={draft.peerKey}
          autoComplete="off"
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, peerKey: event.target.value })}
        />
        <Button variant="ghost" disabled={busy} onClick={() => void add()}>
          <Plus size={13} aria-hidden="true" />添加
        </Button>
      </div>

      {removing && (
        <ConfirmDialog
          title="删除接力目标机"
          message={`「${removing.name}」以及这台机器上记住的身份指纹和你填的对端账号 key 都会被删掉。`}
          confirmLabel="删除"
          danger
          busy={busy}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void run(() => api.deleteHandoffTarget(target.id!), "接力目标机删除失败");
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
