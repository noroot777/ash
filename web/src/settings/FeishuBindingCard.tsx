import { useState } from "react";
import type { FeishuBinding, ImBindCode, ProjectView } from "@ash/shared";
import { Button } from "../components/ui.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { countdownText, formatTime, isExpired, remainingText } from "./feishuText.ts";
import { useNow } from "./useFeishuPoll.ts";

// 绑定卡：把「我」和一个飞书账号连起来。每个人绑自己的，所以所有人都看得到这张卡。
//
// 方向固定是「网页发起、网页确认」（方案 §6.2）：码在这里生成 → 在飞书里发给机器人 → 回这里
// 确认「是不是你发的」。反过来让机器人先给码、人到网页上输入，攻击者就能先从机器人那里拿码
// 再诱导机主去输，所以没有那个入口。
//
// 状态以服务端为准（none → code → pending → bound），刷新后照样看得出走到了哪一步。唯一拿
// 不回来的是码的明文：库里只存哈希，它只在生成那一刻回给页面一次，所以只记在这个组件里。

export function FeishuBindingCard({ binding, online, projects, onBinding, notify }: {
  binding: FeishuBinding;
  /** 机器人此刻在不在线；不在线时码发过去没人收，要提前说。 */
  online: { ok: boolean; label: string };
  /** null = 项目清单还没读到（不是没有项目）。 */
  projects: ProjectView[] | null;
  onBinding: (next: FeishuBinding) => void;
  notify: (message: string) => void;
}) {
  const [fresh, setFresh] = useState<ImBindCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const counting = binding.state === "code" || binding.state === "pending";
  const now = useNow(counting);

  const run = async (work: () => Promise<FeishuBinding>, done: string, fail: string) => {
    setBusy(true);
    try {
      onBinding(await work());
      notify(done);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : fail);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const generate = () => run(async () => {
    const code = await api.createFeishuBindCode();
    setFresh(code);
    return { state: "code", codeId: code.codeId, expiresAt: code.expiresAt };
  }, "绑定码已生成，在飞书里发给机器人", "绑定码生成失败");

  const sendTest = async () => {
    setBusy(true);
    try {
      await api.sendFeishuTestCard();
      notify("测试卡已发出，去飞书单聊里看看");
    } catch (error) {
      notify(error instanceof Error ? error.message : "测试卡发送失败");
    } finally {
      setBusy(false);
    }
  };

  const offline = !online.ok && (
    <small className="feishu-warn">机器人现在不在线（{online.label}），码发过去没人收，先把上面的连接弄好。</small>
  );

  let body;
  if (binding.state === "none") {
    body = (
      <div className="settings-row">
        <div>
          <b>还没绑定飞书</b>
          <small>绑定后，提问、待验收、失败这些要你拍板的事会推成卡片，发到你和机器人的单聊里。</small>
          {offline}
        </div>
        <Button variant="primary" disabled={busy} onClick={() => void generate()}>绑定飞书</Button>
      </div>
    );
  } else if (binding.state === "code") {
    const plain = fresh && fresh.codeId === binding.codeId ? fresh.code : null;
    const left = countdownText(binding.expiresAt, now);
    body = plain && left ? (
      <div className="settings-row feishu-code-row">
        <div>
          <b>在飞书里给机器人单聊发这串码</b>
          <span className="feishu-code-line">
            <code className="feishu-code" aria-label="绑定码">{plain}</code>
            <CopyButton value={plain} label="复制" icon className="feishu-copy" />
            <span className="feishu-countdown">{left} 后过期</span>
          </span>
          <small>发过去之后这里会显示是谁发的，由你确认。码只显示这一次，刷新页面就看不到了。</small>
          {offline}
        </div>
        <Button variant="secondary" disabled={busy} onClick={() => void generate()}>重新生成</Button>
      </div>
    ) : (
      <div className="settings-row">
        <div>
          <b>{left ? `有一个未用的码，${remainingText(binding.expiresAt, now)}后过期` : "上一个码已过期"}</b>
          <small>码的明文只在生成那一刻显示一次（库里只存哈希），刷新后拿不回来。重新生成一个，旧的随之作废。</small>
        </div>
        <Button variant="primary" disabled={busy} onClick={() => void generate()}>重新生成</Button>
      </div>
    );
  } else if (binding.state === "pending") {
    const left = remainingText(binding.expiresAt, now);
    body = (
      <div className="settings-row feishu-pending">
        <div>
          <b>飞书用户 …{binding.openIdTail} 在 {formatTime(binding.claimedAt)} 发来了这串码，是你吗？</b>
          <small>
            没开通讯录权限，ash 拿不到飞书里的名字，只能显示 open_id 的末几位。不是你发的就点「不是我」——说明码落到了别人手里。
            {left ? `${left}内有效。` : "这次申请已过期。"}
          </small>
        </div>
        <span className="feishu-actions">
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => api.rejectFeishuBinding(binding.codeId), "已拒绝这次绑定申请", "操作失败")}>
            不是我
          </Button>
          <Button variant="primary" disabled={busy || isExpired(binding.expiresAt, now)} onClick={() => void run(async () => {
            const next = await api.acceptFeishuBinding(binding.codeId);
            setFresh(null);
            return next;
          }, "飞书已绑定", "绑定失败")}>
            确认绑定
          </Button>
        </span>
      </div>
    );
  } else {
    body = (
      <>
        <div className="settings-row">
          <div>
            <b>已绑定飞书用户 …{binding.openIdTail}</b>
            <small>绑定于 {formatTime(binding.boundAt)}。只显示 open_id 的末几位：没开通讯录权限，ash 拿不到飞书里的名字。</small>
            {binding.stale && (
              <small className="feishu-warn">换过飞书应用（绑定时用的是 {binding.appId}），需要重新绑定：同一个人在不同应用里的 open_id 不一样。</small>
            )}
          </div>
          <span className="feishu-actions">
            {binding.stale && <Button variant="primary" disabled={busy} onClick={() => void generate()}>重新绑定</Button>}
            <Button variant="danger" disabled={busy} onClick={() => setConfirmUnbind(true)}>解除绑定</Button>
          </span>
        </div>
        <div className="settings-row">
          <div>
            <b>当前项目</b>
            <small>在飞书里新建任务时落在哪个项目。</small>
          </div>
          <select
            aria-label="飞书里的当前项目"
            value={binding.projectId ?? ""}
            disabled={busy}
            onChange={(event) => void run(() => api.setFeishuBindingProject(event.target.value || null), "当前项目已切换", "当前项目保存失败")}
          >
            <option value="">未指定</option>
            {binding.projectId && !(projects ?? []).some((project) => project.id === binding.projectId) && (
              <option value={binding.projectId}>{projects ? "（已看不到的项目）" : "（项目名没读到）"}</option>
            )}
            {(projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        <div className="settings-row">
          <div>
            <b>发一张测试卡</b>
            <small>验证机器人能不能给你发消息——权限、发版、连接任何一环没通，这里会报出来。</small>
          </div>
          <Button variant="secondary" disabled={busy || binding.stale} onClick={() => void sendTest()}>发一张测试卡</Button>
        </div>
      </>
    );
  }

  return (
    <section className="settings-section" data-settings-anchor="feishu-binding">
      <h2>绑定</h2>
      <div className="settings-card">
        {body}
        <div className="settings-card-foot">
          <span>绑定只能从网页发起、在网页确认：码在这里生成，在飞书里发给机器人，再回到这里点确认。</span>
        </div>
      </div>
      {confirmUnbind && (
        <ConfirmDialog
          title="解除飞书绑定"
          message="解除后卡片不再推给你，你在飞书里发给机器人的消息也不再被认作你；已发出的卡片按钮随之失效。以后要用得重新绑定。"
          confirmLabel="解除绑定"
          danger
          busy={busy}
          onClose={() => setConfirmUnbind(false)}
          onConfirm={() => void run(api.unbindFeishu, "已解除飞书绑定", "解除绑定失败").then((ok) => { if (ok) setConfirmUnbind(false); })}
        />
      )}
    </section>
  );
}
