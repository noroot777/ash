// 项目成员(§六)。项目是**共享轴**上的东西:谁能看见这个项目、谁能改它的设置,
// 都在这一屏里定。
//
// 两件容易搞混的事界面上要分开说:
//  · 实例管理员天然能进任意项目,但他**不是成员行**(`implicit`),所以不能被移除。
//  · 邀请链接是「谁拿到谁能进」,跟专属邀请链接(一人一条)不是一回事,写明有效期。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectMemberView, ProjectRole, ProjectView, UserView } from "@ash/shared";
import { ApiError } from "../lib/apiClient.ts";
import { projectMemberApi, userApi } from "../lib/authApi.ts";
import { useAuth } from "../auth/authContext.ts";
import { Button } from "../components/ui.tsx";
import "./project-members.css";
import { Select, type SelectOption } from "../components/Select.tsx";
import { localeDateTime } from "../lib/localeFormat.ts";

const ROLE_LABEL: Record<ProjectRole, string> = {
  admin: "项目管理员",
  member: "成员",
};
const ROLE_OPTIONS: SelectOption<ProjectRole>[] = [
  { value: "member", label: ROLE_LABEL.member },
  { value: "admin", label: ROLE_LABEL.admin },
];

export function ProjectMembersSettings({
  project,
  notify,
}: {
  project: ProjectView;
  notify: (message: string) => void;
}) {
  const { state } = useAuth();
  const [members, setMembers] = useState<ProjectMemberView[]>([]);
  const [users, setUsers] = useState<UserView[]>([]);
  const [invite, setInvite] = useState<{ active: boolean; expiresAt: string | null } | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  // 加人时就把角色定下来:不然「先加进来是成员、再翻到名单里改成管理员」是两趟操作,
  // 中间那一小段时间里对方是拿错权限的。
  const [pickRole, setPickRole] = useState<ProjectRole>("member");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, all, inviteState] = await Promise.all([
        projectMemberApi.list(project.id),
        userApi.list(),
        projectMemberApi.inviteState(project.id).catch(() => null),
      ]);
      setMembers(list);
      setUsers(all);
      setInvite(inviteState);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "读不出成员列表");
    }
  }, [project.id, notify]);

  useEffect(() => {
    setInviteUrl(null);
    void load();
  }, [load]);

  // 我能不能管这个项目。判据只有一份:服务端算好的 `project.myRole`(自用模式与实例管理员
  // 一律是 admin) —— 项目设置那一屏用的也是它,两处不会各算各的。
  const canManage = project.myRole === "admin";

  const candidates = useMemo(() => {
    const inProject = new Set(members.map((m) => m.userId));
    return users.filter((u) => !inProject.has(u.id));
  }, [users, members]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        notify(label);
        await load();
      } catch (e) {
        notify(e instanceof ApiError ? e.message : "操作失败");
      } finally {
        setBusy(false);
      }
    },
    [load, notify],
  );

  if (state.mode !== "multi") {
    return (
      <section className="settings-section">
        <header className="settings-heading">
          <div>
            <h1>成员</h1>
            <p>自用模式下项目就是你自己的，没有成员这回事。</p>
          </div>
        </header>
      </section>
    );
  }

  return (
    <section className="settings-section pmem">
      {/* 标题下至多一句：谁看得见。谁能改什么由下面名单里的角色下拉自己说明。 */}
      <header className="settings-heading">
        <div>
          <h1>成员</h1>
          <p>谁在这份名单里，谁才看得见 {project.name} 和它下面的任务；项目管理员能加减成员，实例管理员天然能进任意项目。</p>
        </div>
      </header>

      <ul className="pmem-list">
        {members.map((member) => (
          <li key={member.userId} className="pmem-row">
            <div className="pmem-who">
              <b>{member.name}</b>
              {member.userId === state.user?.id ? <span className="pmem-tag">你</span> : null}
              {member.implicit ? <span className="pmem-tag pmem-tag--muted">实例管理员</span> : null}
            </div>
            <div className="pmem-actions">
              {member.implicit ? (
                <span className="pmem-note">天然可进，不在成员名单里</span>
              ) : canManage ? (
                <>
                  <Select
                    className="pmem-role"
                    label={`${member.name} 的项目角色`}
                    value={member.role}
                    disabled={busy}
                    options={ROLE_OPTIONS}
                    onChange={(next) =>
                      void run("已改权限", () =>
                        projectMemberApi.setRole(project.id, member.userId, next),
                      )
                    }
                  />
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => void run("已移出项目", () => projectMemberApi.remove(project.id, member.userId))}
                  >
                    移出
                  </Button>
                </>
              ) : (
                <span className="pmem-note">{ROLE_LABEL[member.role]}</span>
              )}
            </div>
          </li>
        ))}
      </ul>

      {canManage ? (
        <div className="pmem-block">
          <h3>加人</h3>
          <div className="pmem-add">
            <Select
              className="pmem-user"
              label="选择要加入的用户"
              value={pick}
              placeholder="选一个用户…"
              filterable={candidates.length > 8}
              filterPlaceholder="筛选用户…"
              options={candidates.map((u) => ({ value: u.id, label: u.name }))}
              onChange={setPick}
            />
            <Select
              className="pmem-role"
              label="加入后的角色"
              value={pickRole}
              options={ROLE_OPTIONS}
              onChange={setPickRole}
            />
            <Button
              variant="primary"
              disabled={busy || !pick}
              onClick={() =>
                void run(`已加入项目：${ROLE_LABEL[pickRole]}`, async () => {
                  await projectMemberApi.add(project.id, pick, pickRole);
                  setPick("");
                  setPickRole("member");
                })
              }
            >
              加入项目
            </Button>
          </div>
          {candidates.length === 0 ? (
            <p className="settings-hint">所有用户都已经在这个项目里了。</p>
          ) : null}

          <h3>邀请链接</h3>
          <p className="settings-hint">
            拿到这条链接的<b>任何已登录用户</b>点开就是成员 —— 跟一人一条的专属链接不是一回事。
            {invite?.active && invite.expiresAt
              ? `当前有一条有效链接，${localeDateTime(invite.expiresAt)} 过期。`
              : "当前没有有效链接。"}
          </p>
          {inviteUrl ? (
            <code className="pmem-invite-url">{new URL(inviteUrl, window.location.origin).toString()}</code>
          ) : null}
          <div className="pmem-actions">
            <Button
              disabled={busy}
              onClick={() =>
                void run("已生成邀请链接", async () => {
                  setInviteUrl((await projectMemberApi.createInvite(project.id)).inviteUrl);
                })
              }
            >
              {invite?.active ? "换一条新链接" : "生成邀请链接"}
            </Button>
            {invite?.active ? (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run("已作废", async () => {
                    await projectMemberApi.revokeInvite(project.id);
                    setInviteUrl(null);
                  })
                }
              >
                作废现有链接
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
