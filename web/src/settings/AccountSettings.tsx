import { useState } from "react";
import { ArrowClockwise, SignOut } from "@phosphor-icons/react";
import { useAuth } from "../auth/authContext.ts";
import { KeyReveal } from "../auth/KeyReveal.tsx";
import { authApi, userApi } from "../lib/authApi.ts";
import { Button, TextInput } from "../components/ui.tsx";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

// 「我的账号」——设置页里唯一一节**只关于自己**的东西(§三/§五/§八 个人面)。
//
// 三样,都只有本人能做:
//  · git 署名:多人协作的提交署谁的名(不填就按姓名/目录名兜底,见 auth/run-env.ts)。
//  · 我的 key:自助轮换。旧 key 即刻失效,新 key **只显示这一次**。
//  · 登出。
//
// 目录名不在这里 —— 它设定后锁死(§七:一改所有已建项目路径失效)。姓名和角色:姓名
// 本人可改,角色只有实例管理员能动,所以它在这里是只读的一行说明。
export function AccountSettings({ notify }: { notify: (message: string) => void }) {
  const { state, refresh } = useAuth();
  const user = state.user;
  const [name, setName] = useState(user?.name ?? "");
  const [gitName, setGitName] = useState(user?.gitName ?? "");
  const [gitEmail, setGitEmail] = useState(user?.gitEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  if (state.mode !== "multi" || !user) {
    return (
      <>
        <header className="settings-heading">
          <div>
            <h1>我的账号</h1>
            <p>这台 ash 是自用模式，没有账号这回事。</p>
          </div>
        </header>
        <section className="settings-section">
          <div className="settings-card">
            <div className="settings-row">
              <div>
                <b>要多人一起用？</b>
                <small>到「默认规则」最下面的危险区切到多人模式。切过去之后这里会出现你的资料、git 署名和 key。</small>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  }

  const save = async (patch: { name?: string; gitName?: string; gitEmail?: string }) => {
    setBusy(true);
    try {
      await userApi.patch(user.id, patch);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败");
      // 服务端拒了就把输入框拨回真值,否则界面上留着一个其实没存进去的名字。
      setName(user.name);
      setGitName(user.gitName);
      setGitEmail(user.gitEmail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="settings-heading">
        <div>
          <h1>我的账号</h1>
          <p>你的资料、提交署名和登录用的 key。这一节的内容只有你自己看得到。</p>
        </div>
      </header>

      <section className="settings-section">
        <h2>资料</h2>
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <b>姓名</b>
              <small>别人在成员名单和任务归属里看到的就是这个。</small>
            </div>
            <TextInput
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => { if (name.trim() && name.trim() !== user.name) void save({ name: name.trim() }); }}
            />
          </div>
          <div className="settings-row">
            <div>
              <b>目录 / 角色</b>
              <small>
                你的项目都在 <code>{user.dirName}</code> 这个目录下。
                {user.role === "admin" ? "你是实例管理员。" : "普通成员。"}
                目录名设定后锁死（一改，所有已建项目的路径都会失效）；角色要找实例管理员改。
              </small>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>Git 署名</h2>
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <b>提交署谁的名</b>
              <small>
                agent 替你干活时的提交用这个身份。不填就按姓名和目录名兜底——
                但那样多人协作的 git log 里会全是机器身份，事后谁也认不出哪一笔是谁的。
              </small>
            </div>
          </div>
          <div className="settings-row">
            <div><b>name</b></div>
            <TextInput
              value={gitName}
              placeholder={user.name}
              disabled={busy}
              onChange={(event) => setGitName(event.target.value)}
              onBlur={() => { if (gitName !== user.gitName) void save({ gitName }); }}
            />
          </div>
          <div className="settings-row">
            <div><b>email</b></div>
            <TextInput
              value={gitEmail}
              placeholder={`${user.dirName}@ash.local`}
              disabled={busy}
              onChange={(event) => setGitEmail(event.target.value)}
              onBlur={() => { if (gitEmail !== user.gitEmail) void save({ gitEmail }); }}
            />
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>我的 key</h2>
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <b>重新生成</b>
              <small>
                手机上填过、或者你怀疑它泄露过，就换一把。
                <b>旧的立刻失效</b>——所有填过旧 key 的地方（手机 app、别人机器上的接力目标机）都要重填。
                网页这一端会当场换发新会话，不会把你踢出去。
              </small>
            </div>
            <Button variant="secondary" disabled={busy} onClick={() => setRotating(true)}>
              <ArrowClockwise size={13} aria-hidden="true" />重新生成
            </Button>
          </div>
          <div className="settings-row">
            <div>
              <b>登出这台浏览器</b>
              <small>只断这一端的会话，key 本身不变。</small>
            </div>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                try {
                  await authApi.logout();
                  window.location.reload();
                } catch (error) {
                  notify(error instanceof Error ? error.message : "登出失败");
                }
              }}
            >
              <SignOut size={13} aria-hidden="true" />登出
            </Button>
          </div>
        </div>
      </section>

      {rotating && (
        <ConfirmDialog
          title="重新生成我的 key"
          message="旧 key 立刻失效。手机 app、别人机器上填过你这把 key 的接力目标机，都要用新的重填一遍。"
          confirmLabel="生成新 key"
          danger
          busy={busy}
          onConfirm={async () => {
            setRotating(false);
            setBusy(true);
            try {
              setNewKey((await authApi.rotateKey()).key);
            } catch (error) {
              notify(error instanceof Error ? error.message : "重新生成失败");
            } finally {
              setBusy(false);
            }
          }}
          onClose={() => setRotating(false)}
        />
      )}

      {newKey && (
        <section className="settings-section">
          <div className="settings-card settings-card--pad">
            <KeyReveal
              value={newKey}
              title="这是你的新 key"
              note="只显示这一次。关掉之后服务端只留哈希，谁也读不回来——包括实例管理员。"
              confirmLabel="我已保存"
              onConfirm={() => { setNewKey(null); void refresh(); }}
            />
          </div>
        </section>
      )}
    </>
  );
}
