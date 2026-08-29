// 「用户」设置节(§五)。**只有实例管理员**看得到这一节;界面上藏起来只是省事,
// 真正的闸在后端(`requireAdmin`)。不过这一屏自己能把人降级(含降自己),所以下面那道
// 「你不是管理员」的岔路不是摆设:降完之后导航项没了、这块面板却还挂在屏幕上,
// `GET /users` 对普通成员回的是**精简版**(只有 id/name/role),照原样渲染就是一屏
// 目录名和状态全空的残表。
//
// 四件事在这一屏里必须说清楚,否则用户会用错:
//  ① 建用户**不设 key**,只发一条专属链接;key 在他自己点开链接时生成。
//  ② 停用不是删除 —— 它断会话、停他的任务、暂停他的日程,数据全留着。
//  ③ 重置 key = **别人**手上那把当场失效;自己那把在「我的账号」里换(见 UserRow)。
//  ④ 邀请链接只发给还没领到 key 的人 —— 它是匿名领取入口,对已有 key 的账号开它
//    等于开一条账号接管链接(第 5 轮审查 P1)。
import { useCallback, useEffect, useState } from "react";
import type { UserRole, UserView } from "@ash/shared";
import { suggestDirName, suggestGitEmail, userDirNameError, USER_DIR_NAME_HINT } from "@ash/shared/multiuser";
import { ApiError } from "../lib/apiClient.ts";
import { userApi } from "../lib/authApi.ts";
import { useAuth } from "../auth/authContext.ts";
import { Button, TextInput } from "../components/ui.tsx";
import "./users-settings.css";

function absoluteInvite(url: string): string {
  return new URL(url, window.location.origin).toString();
}

const ROLE_LABEL: Record<UserRole, string> = {
  admin: "实例管理员",
  member: "普通成员",
};

const asRole = (value: string): UserRole => (value === "admin" ? "admin" : "member");

// 管理员那一版的名单行带着 dirName/status;普通成员拿到的精简版只有 id/name/role。
const isAdminRow = (row: UserView) => typeof (row as Partial<UserView>).dirName === "string";

function InviteLink({ url, onDone }: { url: string; onDone?: () => void }) {
  const [copied, setCopied] = useState(false);
  const full = absoluteInvite(url);
  return (
    <div className="users-invite">
      <p>
        把这条链接发给他。<b>7 天内有效</b>，点开就能生成自己的 key —— key 只在他那一边显示一次，你看不到。
      </p>
      <code className="users-invite-url">{full}</code>
      <div className="users-invite-actions">
        <Button
          variant="primary"
          onClick={() => {
            void navigator.clipboard?.writeText(full).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          {copied ? "已复制" : "复制链接"}
        </Button>
        {onDone ? <Button variant="ghost" onClick={onDone}>知道了</Button> : null}
      </div>
    </div>
  );
}

export function UsersSettings({
  notify,
  onAccount,
}: {
  notify: (message: string) => void;
  onAccount: () => void;
}) {
  const { state, refresh } = useAuth();
  const [users, setUsers] = useState<UserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<{ userId: string; url: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const [name, setName] = useState("");
  const [dirName, setDirName] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [busy, setBusy] = useState(false);

  // 名单只在**后端还把我当管理员**时才收下。自降级那一下必然撞上一个窗口:PATCH 一成功
  // 后端下一次 `GET /users` 就改口回精简版(user-routes.ts),而这一屏要等 `refresh()`
  // 把 auth state 刷回来才知道自己不是管理员了 —— 中间这一拍把精简版写进来,渲染出的
  // 就是一张目录名全空、却照样摆着「发邀请链接 / 停用 / 角色下拉」的假管理表;`refresh()`
  // 要是失败,它还会一直留在屏幕上(第 1 轮审查 P2)。
  //
  // 所以判据落在**响应形状**上,不靠 load/refresh 的先后:精简版一律不收,宁可留着上一份
  // 名单,等这一屏自己关掉。
  const load = useCallback(async () => {
    try {
      const rows = await userApi.list();
      if (rows.every(isAdminRow)) setUsers(rows);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "读不出用户列表");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!dirTouched) setDirName(name.trim() ? suggestDirName(name) : "");
  }, [name, dirTouched]);

  // 姓名推不出目录名(中文名必然如此)时当场说清,别等提交后才回一句「目录名必填」。
  const dirError = dirName
    ? userDirNameError(dirName)
    : name.trim() ? "自己填一个英文目录名（中文名推不出来），比如 zhangsan" : null;

  const resetForm = () => {
    setName("");
    setDirName("");
    setDirTouched(false);
    setGitName("");
    setGitEmail("");
    setRole("member");
    setAdding(false);
  };

  const create = useCallback(async () => {
    setBusy(true);
    try {
      const result = await userApi.create({
        name: name.trim(),
        role,
        dirName: dirName.trim(),
        gitName: gitName.trim(),
        gitEmail: gitEmail.trim(),
      });
      resetForm();
      setInvite({ userId: result.user.id, url: result.inviteUrl });
      await load();
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "建不出用户");
    } finally {
      setBusy(false);
    }
  }, [name, role, dirName, gitName, gitEmail, load, notify]);

  const act = useCallback(
    async (label: string, run: () => Promise<unknown>) => {
      let result: { inviteUrl?: string | null; stoppedTasks?: string[]; pausedSchedules?: number };
      try {
        result = (await run()) as { inviteUrl?: string | null; stoppedTasks?: string[]; pausedSchedules?: number };
      } catch (e) {
        notify(e instanceof ApiError ? e.message : "操作失败");
        return;
      }
      if (result?.inviteUrl) setInvite({ userId: "", url: result.inviteUrl });
      if (result?.stoppedTasks) {
        notify(
          `已停用。停掉 ${result.stoppedTasks.length} 个在跑/排队的任务` +
            (result.pausedSchedules ? `，暂停 ${result.pausedSchedules} 条日程` : ""),
        );
      } else {
        notify(label);
      }
      // 到这里动作**已经成了**,底下两步是善后 —— 它们失败不许回一句「操作失败」把结论
      // 说反(第 1 轮审查 P2)。`refresh()` 排在 `load()` 前面:自降级那一下 auth state
      // 早一拍刷回来,这一屏就早一拍关掉;刷不回来时如实说一句,别让人对着一张已经失效的
      // 管理名单继续点。
      await refresh().catch(() => notify("账号状态没刷新出来，刷新页面看最新的"));
      await load();
    },
    [load, notify, refresh],
  );

  if (state.mode !== "multi") {
    return (
      <section className="settings-section">
        <h2>用户</h2>
        <p className="settings-hint">
          这台 ash 现在是<b>自用模式</b>，没有用户这回事。要几个人一起用，去「默认规则 → 危险区」切到多人模式。
        </p>
      </section>
    );
  }

  // 降完自己之后落在这里:导航项已经没了,但这块面板还挂在屏幕上,而普通成员拿到的
  // `GET /users` 是精简版,照原样渲染就是一屏空目录名。
  if (state.user?.role !== "admin") {
    return (
      <section className="settings-section">
        <h2>用户</h2>
        <p className="settings-hint">
          只有<b>实例管理员</b>能管用户，你现在是普通成员。要改回来得找另一位管理员。
        </p>
      </section>
    );
  }

  return (
    <section className="settings-section users-settings">
      <header className="users-header">
        <div>
          <h2>用户</h2>
          <p className="settings-hint">
            根目录 <code>{state.rootDir ?? "—"}</code>。每建一个用户，就在它下面开一个属于他的目录。
          </p>
        </div>
        {!adding ? <Button variant="primary" onClick={() => setAdding(true)}>添加用户</Button> : null}
      </header>

      {invite ? <InviteLink url={invite.url} onDone={() => setInvite(null)} /> : null}

      {adding ? (
        <form
          className="users-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="users-field">
            <span>姓名</span>
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="李四" />
          </label>
          <label className="users-field">
            <span>目录名</span>
            <TextInput
              value={dirName}
              onChange={(e) => {
                setDirTouched(true);
                setDirName(e.target.value);
              }}
              placeholder="lisi"
            />
            <small className={dirError ? "users-error" : ""}>
              {dirError ?? `他的项目都建在 ${state.rootDir ?? "<根目录>"}/${dirName || "<目录名>"} 里。${USER_DIR_NAME_HINT}`}
            </small>
          </label>
          <label className="users-field">
            <span>git 署名</span>
            <TextInput value={gitName} onChange={(e) => setGitName(e.target.value)} placeholder={name || "李四"} />
          </label>
          <label className="users-field">
            <span>git 邮箱</span>
            <TextInput
              value={gitEmail}
              onChange={(e) => setGitEmail(e.target.value)}
              placeholder={name ? suggestGitEmail(name, dirName) : "lisi@ash.local"}
            />
          </label>
          <label className="users-field">
            <span>实例角色</span>
            <select
              className="ui-input"
              value={role}
              onChange={(e) => setRole(asRole(e.target.value))}
            >
              <option value="member">{ROLE_LABEL.member}</option>
              <option value="admin">{ROLE_LABEL.admin}（能管用户、能碰任意路径、能开终端）</option>
            </select>
          </label>
          <div className="users-form-actions">
            <Button variant="ghost" onClick={resetForm}>取消</Button>
            <Button variant="primary" type="submit" disabled={busy || !name.trim() || !dirName.trim() || !!dirError}>
              {busy ? "正在创建…" : "创建并生成邀请链接"}
            </Button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <p className="settings-hint">正在读取…</p>
      ) : (
        <ul className="users-list">
          {users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              self={state.user?.id === user.id}
              onAct={act}
              onAccount={onAccount}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const STATUS_LABEL: Record<string, string> = {
  invited: "还没领 key",
  active: "在用",
  suspended: "已停用",
};

function UserRow({
  user,
  self,
  onAct,
  onAccount,
}: {
  user: UserView;
  self: boolean;
  onAct: (label: string, run: () => Promise<unknown>) => Promise<void>;
  onAccount: () => void;
}) {
  const [confirming, setConfirming] = useState<"suspend" | "reset" | null>(null);
  const [pendingRole, setPendingRole] = useState<UserRole | null>(null);
  const [roleBusy, setRoleBusy] = useState(false);

  const applyRole = async (role: UserRole) => {
    setPendingRole(null);
    setRoleBusy(true);
    // 后端还有一道「最后一个能登录进来的管理员不许降」的 409(user-routes.ts),
    // 它带着理由回来,由 onAct 原样 notify —— 这里不重复算一遍那份判据。
    await onAct(role === "admin" ? "已升为实例管理员" : "已降为普通成员", () => userApi.patch(user.id, { role }));
    setRoleBusy(false);
  };

  // 「升管理员」交出的是整台机器(管用户 + 任意路径 + 终端),「把自己降下去」是当场
  // 把自己关在门外 —— 这两下不许一个下拉手滑就落地。降别人是可撤销的,当场生效。
  const requestRole = (next: UserRole) => {
    if (next === user.role) return;
    if (next === "admin" || self) setPendingRole(next);
    else void applyRole(next);
  };

  return (
    <li className="users-row" data-status={user.status}>
      <div className="users-row-main">
        <div className="users-row-name">
          <b>{user.name}</b>
          {user.role === "admin" ? <span className="users-tag">管理员</span> : null}
          {self ? <span className="users-tag users-tag--self">你</span> : null}
          <span className="users-status">{STATUS_LABEL[user.status] ?? user.status}</span>
          {user.hasPendingInvite ? <span className="users-tag users-tag--muted">邀请链接有效中</span> : null}
        </div>
        <div className="users-row-meta">
          目录 <code>{user.dirName}</code>
          {user.gitEmail ? <> · git {user.gitName || user.name} &lt;{user.gitEmail}&gt;</> : null}
          {user.lastActiveAt ? <> · 最近活跃 {new Date(user.lastActiveAt).toLocaleString()}</> : null}
        </div>
      </div>

      <div className="users-row-actions">
        {/*
          实例角色。停用中的人也能改 —— 「先升成管理员再恢复」是一条正当路径,而且
          「最后一个管理员」保护按**登录得进来**算(store.ts `canSignIn`),停用账号本来
          就顶不上那个位置,这里放开不会把实例锁死。
        */}
        {pendingRole ? (
          <ConfirmInline
            text={
              pendingRole === "admin"
                ? `${user.name} 将能管理所有用户、访问这台机器上的任意路径、开终端。`
                : "降级后你立刻失去管理员权限，这一屏也随之关上 —— 只能由另一位管理员把你改回来。"
            }
            danger={pendingRole === "member"}
            onCancel={() => setPendingRole(null)}
            onConfirm={() => void applyRole(pendingRole)}
          />
        ) : (
          <select
            className="ui-input users-role"
            aria-label={`${user.name} 的实例角色`}
            value={user.role}
            disabled={roleBusy}
            onChange={(e) => requestRole(asRole(e.target.value))}
          >
            <option value="member">{ROLE_LABEL.member}</option>
            <option value="admin">{ROLE_LABEL.admin}</option>
          </select>
        )}
        {user.status === "suspended" ? (
          <Button onClick={() => void onAct("已恢复", () => userApi.resume(user.id))}>恢复</Button>
        ) : (
          <>
            {/*
              key 那一格按**有没有领到 key** 分岔,三种状态各只有一件事可做:
               · 还没领到 → 只有「把链接给他」。专属邀请链接是匿名领取入口(谁拿到谁
                 就能当场生成 key 并拿会话),所以已经有 key 的账号不许再开这条链接,
                 否则等于开一条延迟生效的接管入口,还绕开了下面那道自重置闸(第 5 轮
                 审查 P1)。后端 `POST /users/:id/invite` 有同判据的 409。
               · 已领到 · 别人 → 「重置 key」:旧 key 即刻失效,再给一条重领链接。
               · 已领到 · 自己 → 去「我的账号」。管理员这条会断掉你自己的会话,而新
                 链接只在那一次响应里,`AuthGate` 一刷新就把它连同整个工作台卸载
                 (第 4 轮审查 P1);自助那条当场把你换到新 key 上。
            */}
            {!user.hasKey ? (
              <Button onClick={() => void onAct("已重发邀请链接", () => userApi.reissueInvite(user.id))}>
                {user.hasPendingInvite ? "重发链接" : "发邀请链接"}
              </Button>
            ) : self ? (
              <Button onClick={onAccount}>去「我的账号」换自己的 key</Button>
            ) : confirming === "reset" ? (
              <ConfirmInline
                text="他手上那把 key 会当场失效，需要用新链接重领。"
                onCancel={() => setConfirming(null)}
                onConfirm={() => {
                  setConfirming(null);
                  void onAct("已重置", () => userApi.resetKey(user.id));
                }}
              />
            ) : (
              <Button onClick={() => setConfirming("reset")}>重置 key</Button>
            )}
            {/*
              名单上标着「邀请链接有效中」,就得有地方把它作废 —— 尤其是已经领到 key
              的人:领取那一步**不作废链接**(§五:手滑点开就锁死是要避免的),所以一个
              领完了没点「我已保存」的人,身上会挂着一条 7 天内谁拿到谁就能接管他账号
              的链接。这颗按钮是管理员这一侧唯一能烧掉它的地方(项目成员那一屏的
              「作废现有链接」同一形状)。
            */}
            {user.hasPendingInvite ? (
              <Button onClick={() => void onAct("已作废", () => userApi.revokeInvite(user.id))}>
                作废链接
              </Button>
            ) : null}
            {self ? null : confirming === "suspend" ? (
              <ConfirmInline
                text="会断掉他的登录、停掉他名下在跑/排队的任务、暂停他建的日程。数据全部保留，随时能恢复。"
                danger
                onCancel={() => setConfirming(null)}
                onConfirm={() => {
                  setConfirming(null);
                  void onAct("已停用", () => userApi.suspend(user.id));
                }}
              />
            ) : (
              <Button variant="danger" onClick={() => setConfirming("suspend")}>停用</Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function ConfirmInline({
  text,
  danger,
  onConfirm,
  onCancel,
}: {
  text: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="users-confirm">
      <span>{text}</span>
      <Button variant="ghost" onClick={onCancel}>取消</Button>
      <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>确定</Button>
    </div>
  );
}
