// 「切到多人模式」的表单本体。首启向导和设置页危险区**共用这一份** —— 那几条警告
// (转不回、根目录锁死)一旦有两份拷贝,迟早只改一边。
//
// 它只负责「填完 → 拿到 key」;拿到之后展示还是跳转由调用方决定。
import { useCallback, useEffect, useState } from "react";
import { suggestDirName, suggestGitEmail, userDirNameError } from "@ash/shared/multiuser";
import { ApiError } from "../lib/apiClient.ts";
import { authApi, type SetupPreflight } from "../lib/authApi.ts";
import { HostCliChoice } from "./HostCliChoice.tsx";

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
  lockedRootDir,
}: {
  /** 不给 = 这一屏没有退路(补做首启),不渲染返回按钮。 */
  onCancel?: () => void;
  onIssued: (key: string) => void;
  cancelLabel?: string;
  /** 补做首启时:根目录早已锁死,只能原样填回去,所以直接给出来并禁编辑。 */
  lockedRootDir?: string;
}) {
  const [preflight, setPreflight] = useState<SetupPreflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [adminName, setAdminName] = useState("");
  const [rootDir, setRootDir] = useState(lockedRootDir ?? "");
  const [dirName, setDirName] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  // CLI 额度(§八之二)。默认**隔离** —— 那是更保守的一档:选错了顶多是「还得各自配
  // 供应商」,而默认成共用则意味着每个新成员一进来就能烧宿主的订阅,一个不留神的选择
  // 变成了默认行为。之后随时能在「设置 → 实例模式」里改。
  const [sharedHostCli, setSharedHostCli] = useState(false);

  useEffect(() => {
    // 补做首启时不问盘点:那一刻实例已经是 multi、又还没人能登录,这条端点在闸外
    // 会被挡成 401(闸只放行 state / setup 两条,见 auth/middleware.ts)。而且盘点讲的是
    // 「转换后这些归你」—— 转换上一次已经发生过了,这一屏只负责把管理员补出来。
    if (lockedRootDir) return;
    void authApi.setupPreflight().then(setPreflight).catch(() => {});
  }, [lockedRootDir]);

  // 目录名默认从姓名推,用户一旦手改过就不再覆盖他。
  useEffect(() => {
    if (!dirTouched) setDirName(adminName.trim() ? suggestDirName(adminName) : "");
  }, [adminName, dirTouched]);

  const hasData = !!preflight && Object.values(preflight.counts).some((n) => n > 0);
  // 姓名推不出目录名(中文名必然如此)时,当场把原因说出来 —— 不要等提交后才回一句
  // 「目录名必填」:那时用户看到的是一张自己已经填了姓名的表单在说「必填」。
  const dirError = dirName ? userDirNameError(dirName) : adminName.trim() ? "自己填一个英文目录名（中文名推不出来），比如 zhangsan" : null;

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
        sharedHostCli,
      });
      onIssued(result.key);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "转换失败");
    } finally {
      setBusy(false);
    }
  }, [adminName, rootDir, dirName, gitName, gitEmail, sharedHostCli, onIssued]);

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
          readOnly={!!lockedRootDir}
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
            placeholder={adminName ? suggestGitEmail(adminName, dirName) : "zhangsan@ash.local"}
          />
        </label>
      </div>
      <p className="auth-note">agent 提交时会用这对署名。不填就按姓名生成默认值，之后能改。</p>

      {/* CLI 额度(§八之二)。补做首启时不问:那一屏只负责把管理员补出来,额度那一档
          上一次转换时已经定过了,再问一遍只会把它悄悄改掉。 */}
      {lockedRootDir ? null : (
        <div className="auth-field">
          <span>CLI 额度怎么算</span>
          <HostCliChoice value={sharedHostCli} onChange={setSharedHostCli} />
          <small>之后随时能在「设置 → 默认规则 → 实例模式」里改，不锁死。</small>
        </div>
      )}

      {hasData ? (
        <div className="auth-warning">
          <b>库里已经有数据了。</b>
          转换后这些全部归你（{Object.entries(preflight!.counts)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${LABELS[k] ?? k} ${n}`)
            .join("、")}）。<b>项目路径一律不动</b>，不会往根目录里搬。
        </div>
      ) : null}

      {/* 「没挂供应商就派不出任务」只在**隔离**那一档成立。选了共用宿主机 CLI 的话,
          这些执行器照跑不误 —— 那时把它们列成一屏红色警告是彻头彻尾的假警报。 */}
      {!sharedHostCli && preflight?.unbackedExecutors.length ? (
        <div className="auth-warning auth-warning--strong">
          <b>转换后这些执行器派不出任务：</b>
          <ul>
            {preflight.unbackedExecutors.map((x) => (
              <li key={x.id}>
                「{x.name}」（{x.type}）—— {x.reason}
              </li>
            ))}
          </ul>
          你选的是「每人自带 key」，宿主机的 CLI 订阅会被隔离。
          转换后到「设置 → 供应商」里配一个，再把执行器挂上去 —— 或者上面改选「共用这台机器的 CLI 额度」。
        </div>
      ) : null}

      <div className="auth-warning">
        <b>多人模式转不回自用模式。</b>多人的数据（各人的项目、执行器、key）没有合并回单人的语义，
        所以这条路只有单向。
      </div>

      {error ? <p className="auth-error">{error}</p> : null}
      <div className="auth-actions">
        {onCancel ? (
          <button type="button" className="ui-button ui-button--ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
        ) : null}
        <button
          type="submit"
          className="ui-button ui-button--primary"
          disabled={busy || !adminName.trim() || !rootDir.trim() || !!dirError}
        >
          {busy ? "正在转换…" : lockedRootDir ? "建出管理员" : "确认切到多人模式"}
        </button>
      </div>
    </form>
  );
}
