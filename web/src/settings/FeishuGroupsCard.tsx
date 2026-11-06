import { useState } from "react";
import type { FeishuGroup, FeishuGroupClaim, FeishuGroups, ProjectView } from "@ash/shared";
import { Button, Toggle } from "../components/ui.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { SettingsPathText } from "./SettingsPathText.tsx";
import type { SettingsSection } from "./sections.ts";
import { countdownText, formatTime, isExpired, remainingText } from "./feishuText.ts";
import { useNow } from "./useFeishuPoll.ts";

// 群卡：把一个飞书群绑到一个项目。流程和个人绑定同一个方向——网页上选项目、生成码，把机器人
// 拉进群、在群里 @ 它发码，回网页看见「哪个群认领了」再确认。码的明文同样只在生成那一刻有，
// 记在这个组件里（按 codeId 存，同时可能有好几个群在绑）。

export function FeishuGroupsCard({ groups, projects, bound, onGroups, onOpen, notify }: {
  groups: FeishuGroups;
  projects: ProjectView[];
  /** 本人已经绑了飞书：群里发码的人得是已绑定的人，机器人才认。 */
  bound: boolean;
  onGroups: (next: FeishuGroups) => void;
  onOpen: (section: SettingsSection, anchor?: string | null) => void;
  notify: (message: string) => void;
}) {
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [unbinding, setUnbinding] = useState<FeishuGroup | null>(null);
  const claims = groups.claims;
  const now = useNow(claims.length > 0);
  const live = claims.filter((claim) => !isExpired(claim.expiresAt, now));
  const target = projectId || projects[0]?.id || "";
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? "（已看不到的项目）";

  const run = async (work: () => Promise<FeishuGroups>, done: string, fail: string) => {
    setBusy(true);
    try {
      onGroups(await work());
      notify(done);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : fail);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setBusy(true);
    try {
      const code = await api.createFeishuGroupCode(target);
      setCodes((current) => ({ ...current, [code.codeId]: code.code }));
      // 生成码只回这一串，不回整份群状态：先把这条认领占上位置（之后的轮询会给出服务端那份）。
      onGroups({
        groups: groups.groups,
        claims: [...claims.filter((claim) => claim.codeId !== code.codeId), {
          codeId: code.codeId, projectId: target, chatId: null, name: null, claimedAt: null, expiresAt: code.expiresAt,
        }],
      });
      notify("群绑定码已生成");
    } catch (error) {
      notify(error instanceof Error ? error.message : "群绑定码生成失败");
    } finally {
      setBusy(false);
    }
  };

  const claimRow = (claim: FeishuGroupClaim) => {
    if (claim.chatId) {
      return (
        <div key={claim.codeId} className="settings-row feishu-pending">
          <div>
            <b>群「{claim.name ?? "未命名的群"}」在 {claim.claimedAt ? formatTime(claim.claimedAt) : "刚才"} 发来了绑定码，要把它绑到项目「{projectName(claim.projectId)}」吗？</b>
            <small>不认识这个群就拒绝。{remainingText(claim.expiresAt, now)}内有效。</small>
          </div>
          <span className="feishu-actions">
            <Button variant="secondary" disabled={busy} onClick={() => void run(() => api.rejectFeishuGroup(claim.codeId), "已拒绝这个群的绑定申请", "操作失败")}>拒绝</Button>
            <Button variant="primary" disabled={busy} onClick={() => void run(() => api.acceptFeishuGroup(claim.codeId), "群已绑定", "群绑定失败")}>确认绑定群</Button>
          </span>
        </div>
      );
    }
    const plain = codes[claim.codeId];
    return (
      <div key={claim.codeId} className="settings-row feishu-code-row">
        <div>
          <b>给项目「{projectName(claim.projectId)}」的群绑定码</b>
          {plain ? (
            <>
              <span className="feishu-code-line">
                <code className="feishu-code" aria-label="群绑定码">{plain}</code>
                <CopyButton value={plain} label="复制" icon className="feishu-copy" />
                <span className="feishu-countdown">{countdownText(claim.expiresAt, now)} 后过期</span>
              </span>
              <small>把机器人拉进群，在群里 @机器人 发这串码。码只显示这一次，刷新页面就看不到了。</small>
            </>
          ) : (
            <small>还没用，{remainingText(claim.expiresAt, now)}后过期。明文只在生成那一刻显示（库里只存哈希），看不到了就再生成一个。</small>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="settings-section" data-settings-anchor="feishu-groups">
      <h2>群</h2>
      <div className="settings-card">
        {groups.groups.map((group) => (
          <div key={group.chatId} className="settings-row feishu-group-row">
            <div>
              <b>{group.name ?? "未命名的群"}</b>
              <small>
                绑定于 {formatTime(group.boundAt)}{group.boundBy ? ` · 由 ${group.boundBy} 绑定` : ""}
                {!group.canEdit && " · 只有绑它的人或实例管理员能改"}
                {group.pushCards && !group.receiving && " · 同一项目更晚绑定的群也开着推送，卡片只发到那个群"}
              </small>
            </div>
            <span className="feishu-actions">
              <select
                aria-label={`${group.name ?? "未命名的群"} 绑定的项目`}
                value={group.projectId}
                disabled={busy || !group.canEdit}
                onChange={(event) => void run(() => api.patchFeishuGroup(group.chatId, { projectId: event.target.value }), "群绑定的项目已切换", "保存失败")}
              >
                {!projects.some((project) => project.id === group.projectId) && <option value={group.projectId}>（已看不到的项目）</option>}
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <Toggle
                label={group.pushCards ? "卡片发到群里" : "卡片发单聊"}
                checked={group.pushCards}
                disabled={busy || !group.canEdit}
                onChange={(checked) => void run(() => api.patchFeishuGroup(group.chatId, { pushCards: checked }), checked ? "这个项目的卡片改发到群里" : "这个项目的卡片改回发单聊", "保存失败")}
              />
              <Button variant="ghost" disabled={busy || !group.canEdit} onClick={() => setUnbinding(group)}>解绑</Button>
            </span>
          </div>
        ))}
        {live.map(claimRow)}
        <div className="settings-row feishu-group-new">
          <div>
            <b>绑定一个群</b>
            <small>
              {bound
                ? "选好项目生成码，再把机器人拉进群、在群里 @机器人 发这串码。"
                : <SettingsPathText text="群里 @ 机器人发码的人要是已经绑定了飞书的人，所以先在「设置 → 飞书 → 绑定」绑好你自己的。" onOpen={onOpen} />}
            </small>
          </div>
          <span className="feishu-actions">
            <select aria-label="要绑群的项目" value={target} disabled={busy || !projects.length} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <Button variant="secondary" disabled={busy || !target} onClick={() => void generate()}>生成群绑定码</Button>
          </span>
        </div>
        <div className="settings-card-foot feishu-foot-text">
          <span>
            群里的 @ 消息进这个项目的群聊房间，用发言人自己的 ash 身份执行；没绑定飞书的人 @ 机器人不会有反应。
            打开「卡片发到群里」后，这个项目的任务卡片改发到群里、不再发单聊，在群话题里回复提问卡就是答复，回复别的卡以 /reply 开头才会发给那个任务。
            群功能要在应用权限里开 <code>im:message.group_at_msg:readonly</code> 并重新发版。
          </span>
        </div>
      </div>
      {unbinding && (
        <ConfirmDialog
          title="解绑飞书群"
          message={`解绑后，群「${unbinding.name ?? "未命名的群"}」里 @ 机器人不再进项目「${projectName(unbinding.projectId)}」，这个项目的卡片也改回发到各人的单聊。`}
          confirmLabel="解绑"
          danger
          busy={busy}
          onClose={() => setUnbinding(null)}
          onConfirm={() => void run(() => api.unbindFeishuGroup(unbinding.chatId), "群已解绑", "解绑失败").then((ok) => { if (ok) setUnbinding(null); })}
        />
      )}
    </section>
  );
}
