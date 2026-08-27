// 「切到多人模式」的表单本体。首启向导和设置页危险区**共用这一份** —— 那三条警告
// (转不回、根目录锁死、宿主订阅被抹去)一旦有两份拷贝,迟早只改一边。
//
// 它只负责「填完 → 拿到 key」;拿到之后展示还是跳转由调用方决定。
import { useCallback, useEffect, useState } from "react";
import { suggestDirName, suggestGitEmail, userDirNameError } from "@ash/shared/multiuser";
import { ApiError } from "../lib/apiClient.ts";
import { authApi, type SetupPreflight } from "../lib/authApi.ts";

const LABELS: Record<string, string> = {
  projects: "项目",
  tasks: "任务",
  notes: "随手记",
  executors: "执行器",
  providers: "供应商",
  workflows: "起手式",
  reviewers: "审查者",
  teamPresets: "模式预设",
};

export function MultiModeForm({
  onCancel,
  onIssued,
  cancelLabel = "返回",
}: {
  onCancel: () => void;
  onIssued: (key: string) => void;
  cancelLabel?: string;
}) {
  const [preflight, setPreflight] = useState<SetupPreflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [adminName, setAdminName] = useState("");
  const [rootDir, setRootDir] = useState("");
  const [dirName, setDirName] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");

  useEffect(() => {
    void authApi.setupPreflight().then(setPreflight).catch(() => {});
  }, []);

  // 目录名默认从姓名推,用户一旦手改过就不再覆盖他。
  useEffect(() => {
    if (!dirTouched) setDirName(adminName.trim() ? suggestDirName(adminName) : "");
  }, [adminName, dirTouched]);

  const hasData = !!preflight && Object.values(preflight.counts).some((n) => n > 0);
  const dirError = dirName ? userDirNameError(dirName) : null;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await authApi.chooseMulti({
        adminName: adminName.trim(),
        rootDir: rootDir.trim(),
        dirName: dirName.trim(),
        gitName: gitName.trim(),
        gitEmail: gitEmail.trim(),
      });
      onIssued(result.key);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "转换失败");
    } finally {
      setBusy(false);
    }
  }, [adminName, rootDir, dirName, gitName, gitEmail, onIssued]);

  return (
    <form
      className="auth-multi-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="auth-field">
        <span>你的姓名</span>
        <input
          className="ui-input"
          autoFocus
          value={adminName}
          onChange={(e) => setAdminName(e.target.value)}
          placeholder="张三"
        />
      </label>

      <label className="auth-field">
        <span>根目录</span>
        <input
          className="ui-input"
          value={rootDir}
          onChange={(e) => setRootDir(e.target.value)}
          placeholder="~/ash-workspaces"
        />
        <small>
          每个人会在它下面得到一个自己的目录（<code>{rootDir || "<根目录>"}/{dirName || "<目录名>"}</code>）。
          <b>设定后锁死</b> —— 一改，所有已建项目的路径都会失效。
        </small>
      </label>

      <label className="auth-field">
        <span>你的目录名</span>
        <input
          className="ui-input"
          value={dirName}
          onChange={(e) => {
            setDirTouched(true);
            setDirName(e.target.value);
          }}
          placeholder="zhangsan"
        />
        {dirError ? <small className="auth-error">{dirError}</small> : null}
      </label>

      <div className="auth-field-row">
        <label className="auth-field">
          <span>git 署名</span>
          <input
            className="ui-input"
            value={gitName}
            onChange={(e) => setGitName(e.target.value)}
            placeholder={adminName || "张三"}
          />
        </label>
        <label className="auth-field">
          <span>git 邮箱</span>
          <input
            className="ui-input"
            value={gitEmail}
            onChange={(e) => setGitEmail(e.target.value)}
            placeholder={adminName ? suggestGitEmail(adminName) : "zhangsan@ash.local"}
          />
        </label>
      </div>
      <p className="auth-note">agent 提交时会用这对署名。不填就按姓名生成默认值，之后能改。</p>

      {hasData ? (
        <div className="auth-warning">
          <b>库里已经有数据了。</b>
          转换后这些全部归你（{Object.entries(preflight!.counts)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${LABELS[k] ?? k} ${n}`)
            .join("、")}）。<b>项目路径一律不动</b>，不会往根目录里搬。
        </div>
      ) : null}

      {preflight?.unbackedExecutors.length ? (
        <div className="auth-warning auth-warning--strong">
          <b>转换后这些执行器派不出任务：</b>
          <ul>
            {preflight.unbackedExecutors.map((x) => (
              <li key={x.id}>
                「{x.name}」（{x.type}）—— {x.reason}
              </li>
            ))}
          </ul>
          多人模式下宿主机的 CLI 订阅被彻底隔离，每人必须自带供应商 key。
          转换后到「设置 → 供应商」里配一个，再把执行器挂上去。
        </div>
      ) : null}

      <div className="auth-warning">
        <b>多人模式转不回自用模式。</b>多人的数据（各人的项目、执行器、key）没有合并回单人的语义，
        所以这条路只有单向。
      </div>

      {error ? <p className="auth-error">{error}</p> : null}
      <div className="auth-actions">
        <button type="button" className="ui-button ui-button--ghost" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          type="submit"
          className="ui-button ui-button--primary"
          disabled={busy || !adminName.trim() || !rootDir.trim() || !!dirError}
        >
          {busy ? "正在转换…" : "确认切到多人模式"}
        </button>
      </div>
    </form>
  );
}
