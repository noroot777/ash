import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import type { GitConfigValue, ProjectGitConfig } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

// 项目设置页的 Git 一节。分成两张卡，因为两边**存在完全不同的地方**：
//
// · 「提交身份」写进仓库自己的 `.git/config`（user.name / user.email / core.sshCommand）。
//   agent 在 worktree 里提交、用户在终端里 `git config user.email`，读到的都是这一份，
//   所以界面必须如实标出「这个值是本仓库设的，还是从全局继承来的」——否则用户会以为
//   自己在项目上改的东西没生效，实际上他只是看着一个继承值。
// · 「远端凭证」（HTTPS 用户名 + 令牌）只进 ash 自己的库，且**只写不读**：`.git/config`
//   是明文、被所有 worktree 共享、agent 读得到，令牌不该躺在那儿。
//
// 令牌框永远是空的，这是设计而不是加载失败，所以卡片里必须有一句话说清楚它，并且
// 「留空 = 沿用已存的令牌」——不然用户只想改个用户名，却被逼着回 GitHub 重新生成一次。
//
// `canManage`（项目管理员 / 实例管理员）决定这一屏是两副面孔中的哪一副。这两张卡改的
// 都是**整个项目共用**的东西:提交署名和 SSH key 落在主仓的 .git/config,所有人所有任务
// 的 worktree 都跟着变;HTTPS 令牌是项目级凭证,覆盖一次就没了。所以按权限表(§四「项目
// 设置」那一行)只给管理员。后端本来就会 403(project-git-routes.ts 的共用 handler),这里
// 把必然失败的输入框和按钮收掉,免得成员改完点保存才发现改不了(第 1 轮审查 P1)。
//
// **读侧照旧全员可见**:看远端、看署名从哪继承来的没有风险,令牌本来就只写不读
// (`git-credentials.ts`),所以「能不能看」和「能不能改」不捆在一起。

const scopeHint = (field: GitConfigValue): string => {
  if (field.scope === "local") return "本项目设定";
  if (field.scope === "inherited") return `继承自全局：${field.value}`;
  return "全局也没设";
};

export function ProjectGitSettings({ projectId, canManage, notify }: {
  projectId: string;
  canManage: boolean;
  notify: (message: string) => void;
}) {
  const [config, setConfig] = useState<ProjectGitConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [credUser, setCredUser] = useState("");
  const [credSecret, setCredSecret] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  // 输入框只在「服务端给了新的一份」时被重置：编辑中途的重新加载会把用户打了一半的字
  // 冲掉。所以除了这里，别的地方不设置这五个 state。
  const adopt = useCallback((next: ProjectGitConfig) => {
    setConfig(next);
    setUserName(next.identity.userName.scope === "local" ? next.identity.userName.value ?? "" : "");
    setUserEmail(next.identity.userEmail.scope === "local" ? next.identity.userEmail.value ?? "" : "");
    setSshKey(next.identity.sshKeyPath ?? "");
    setCredUser(next.credential?.username ?? "");
    setCredSecret("");
  }, []);

  useEffect(() => {
    let alive = true;
    setConfig(null);
    setLoadError(null);
    api.projectGitConfig(projectId)
      .then((next) => { if (alive) adopt(next); })
      .catch((error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : "读取 Git 配置失败");
      });
    return () => { alive = false; };
  }, [projectId, adopt]);

  const run = async (done: string, work: () => Promise<ProjectGitConfig>) => {
    setBusy(true);
    try { adopt(await work()); notify(done); }
    catch (error) { notify(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  };

  if (loadError) {
    return (
      <section className="settings-section"><h2>Git</h2>
        <div className="settings-card"><p className="settings-muted">{loadError}</p></div>
      </section>
    );
  }
  if (!config) {
    return (
      <section className="settings-section"><h2>Git</h2>
        <div className="settings-card"><p className="settings-muted">读取仓库配置…</p></div>
      </section>
    );
  }
  if (!config.identity.isRepo) {
    return (
      <section className="settings-section"><h2>Git</h2>
        <div className="settings-card">
          <p className="settings-muted">这个项目目录还不是 Git 仓库，没有可设置的提交身份和远端。在目录里 <code>git init</code> 或改用一个已有仓库后回来。</p>
        </div>
      </section>
    );
  }

  const { identity, credential } = config;
  const identityDirty = userName !== (identity.userName.scope === "local" ? identity.userName.value ?? "" : "")
    || userEmail !== (identity.userEmail.scope === "local" ? identity.userEmail.value ?? "" : "")
    || sshKey !== (identity.sshKeyPath ?? "");
  const credentialDirty = credUser.trim() !== (credential?.username ?? "") || credSecret !== "";
  const unknownSshCommand = identity.sshCommand.value !== null && identity.sshKeyPath === null;
  const anyHttps = identity.remotes.some((remote) => remote.https);

  return (
    <>
      <section className="settings-section"><h2>Git 身份</h2><div className="settings-card">
        <div className="settings-row">
          <div>
            <b>远端</b>
            <small>{identity.remotes.length ? "URL 里内嵌的密码已隐去" : "这个仓库还没有配置远端"}</small>
          </div>
          <span className="git-remote-list">
            {identity.remotes.map((remote) => (
              <span key={remote.name} className="git-remote-row">
                <b>{remote.name}</b>
                <code className="mono">{remote.url}</code>
                <em>{remote.https ? "HTTPS" : "SSH"}</em>
              </span>
            ))}
          </span>
        </div>
        <label className="settings-field">
          <span>提交用户名</span>
          <input
            value={userName}
            disabled={busy}
            readOnly={!canManage}
            placeholder={identity.userName.scope === "inherited" ? identity.userName.value ?? "" : "留空则跟着全局设置走"}
            onChange={(event) => setUserName(event.target.value)}
          />
          <span className="git-scope">{scopeHint(identity.userName)}</span>
        </label>
        <label className="settings-field">
          <span>提交邮箱</span>
          <input
            value={userEmail}
            disabled={busy}
            readOnly={!canManage}
            placeholder={identity.userEmail.scope === "inherited" ? identity.userEmail.value ?? "" : "留空则跟着全局设置走"}
            onChange={(event) => setUserEmail(event.target.value)}
          />
          <span className="git-scope">{scopeHint(identity.userEmail)}</span>
        </label>
        <label className="settings-field">
          <span>SSH 私钥</span>
          <input
            className="mono"
            value={sshKey}
            disabled={busy || unknownSshCommand}
            readOnly={!canManage}
            placeholder={unknownSshCommand ? "" : "留空则用默认的 ssh 身份，例如 ~/.ssh/id_ed25519"}
            onChange={(event) => setSshKey(event.target.value)}
          />
          <span className="git-scope">
            {unknownSshCommand
              ? `仓库里已有自定义 core.sshCommand：${identity.sshCommand.value}`
              : "推送 SSH 远端时只用这把 key"}
          </span>
        </label>
        <div className="settings-card-foot">
          <span>
            {canManage
              ? "这三项写进仓库的 .git/config，agent 和你自己的终端看到的是同一份；所有任务 worktree 都跟着生效。清空输入框 = 回去跟着全局走。"
              : "这三项写进仓库的 .git/config，所有人的任务 worktree 都跟着生效，所以只有项目管理员能改；这里按只读展示。"}
          </span>
          {canManage && (
            <Button variant="primary" disabled={!identityDirty || busy} onClick={() => void run("提交身份已保存", () =>
              api.saveProjectGitConfig(projectId, { userName, userEmail, sshKeyPath: sshKey }))}>
              {busy ? "保存中…" : "保存身份"}
            </Button>
          )}
        </div>
      </div></section>

      <section className="settings-section"><h2>Git 凭证</h2><div className="settings-card">
        <div className="settings-row">
          <div>
            <b>HTTPS 用户名与令牌</b>
            <small>
              {credential
                ? `已配置：${credential.username}（${new Date(credential.updatedAt).toLocaleString()}）`
                : "未配置。这个项目走 HTTPS 拉取/推送时会用系统里的凭证"}
            </small>
          </div>
        </div>
        <label className="settings-field">
          <span>用户名</span>
          <input value={credUser} disabled={busy} readOnly={!canManage} autoComplete="off" onChange={(event) => setCredUser(event.target.value)} />
        </label>
        <label className="settings-field">
          <span>令牌 / 密码</span>
          <input
            type="password"
            value={credSecret}
            disabled={busy}
            readOnly={!canManage}
            autoComplete="new-password"
            placeholder={credential ? "留空则沿用已存的令牌" : "GitHub / GitLab 的 access token"}
            onChange={(event) => setCredSecret(event.target.value)}
          />
          <span className="git-scope">存进去就取不回来，只能换一个</span>
        </label>
        <div className="settings-card-foot">
          <span>
            {!canManage
              ? "这是整个项目共用的凭证，覆盖一次所有人都跟着换，所以只有项目管理员能改；令牌本来就取不回来，这里只显示用户名。"
              : anyHttps || !identity.remotes.length
                ? "只存在 ash 自己的库里，不写进仓库；这个项目的拉取、推送（含任务工作区的推送）都用它。"
                : "当前远端都是 SSH，配了也不会被用到——SSH 走上面那把私钥。"}
          </span>
          {canManage && (
            <span className="git-cred-actions">
              {credential && (
                <Button variant="danger" disabled={busy} onClick={() => setConfirmClear(true)}>清除凭证</Button>
              )}
              <Button variant="primary" disabled={!credentialDirty || !credUser.trim() || busy} onClick={() => void run("Git 凭证已保存", () =>
                api.saveProjectGitCredential(projectId, credUser, credSecret))}>
                {busy ? "保存中…" : "保存凭证"}
              </Button>
            </span>
          )}
        </div>
      </div></section>

      {confirmClear && (
        <ConfirmDialog
          title="清除 Git 凭证"
          message="清除后这个项目的 HTTPS 拉取和推送会回到系统默认凭证。令牌无法恢复，需要重新填写。"
          confirmLabel="清除凭证"
          danger
          busy={busy}
          onClose={() => setConfirmClear(false)}
          onConfirm={() => void run("Git 凭证已清除", async () => {
            const next = await api.deleteProjectGitCredential(projectId);
            setConfirmClear(false);
            return next;
          })}
        />
      )}
    </>
  );
}
