import { useMemo, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { repoNameFromUrl, repoUrlError } from "@ash/shared/repo-url";
import { FolderOpen, FolderPlus, GitBranch } from "@phosphor-icons/react";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { DirectoryPickerButton, directoryName } from "../components/DirectoryPickerButton.tsx";
import { ScopedPathField, pathSegmentFromName, pathTailUnder } from "../components/ScopedPathField.tsx";
import { Button } from "../components/ui.tsx";
import { useAuth } from "../auth/authContext.ts";
import { hostSamplePath, joinHostPath, useHostInfo } from "../lib/useHostInfo.ts";
import { PathHealthStatus, pathHealthState, useDebouncedPathHealth } from "../settings/PathHealthStatus.tsx";
import { api } from "../lib/api.ts";

// 新建项目的两条路。它们的差别不只是「多几个输入框」，而是**目录归谁管**：
//
//  · 本地目录 —— 目录归用户。ash 只往库里记一行路径；填的目录还不存在时才顺手建出来
//    （空目录一个，不放任何东西进去）。
//  · 从 Git 检出 —— 目录由 ash 建（连同缺失的上级目录）并往里放一整个仓库。这里「目录
//    不存在」是正常情况，「已经有东西」才是错。
//
// 所以两条路的路径提示、按钮门禁、失败后果全是相反的，不能压成一个表单加一个复选框。
//
// 多人模式还加一层：路径不是随便填的，服务端只收 `rootDir/<我的目录名>` 之内的位置
// （auth/path-scope.ts）。所以这两条路的路径框在多人模式下都换成**前缀锁死**的形状 ——
// 家目录那一段画死，用户只填后面一截，而且默认跟着项目名走。实例管理员在服务端那边不
// 受钳制（§七 刻意如此），界面上给他一个「用其它路径…」的出口，默认仍落在自己目录里。
//
// 失败信息留在弹层里而不是 toast：克隆的报错是 git 的原文（鉴权失败、仓库不存在、网络
// 不通），常常好几行，而且用户多半要照着它改地址再试一次 —— 表单必须还在。

type Mode = "local" | "clone";

const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: "local", label: "本地目录", hint: "指向这台机器上的目录；不存在的话会建出来" },
  { key: "clone", label: "从 Git 检出", hint: "输入仓库地址，ash 克隆到你指定的位置" },
];

export function CreateProjectDialog({ projects, reason = null, onClose, onCreated, notify }: {
  /** 已有项目，用来在填到一条已登记的路径时当场提醒，而不是造出第二个同仓库项目。 */
  projects: ProjectView[];
  /**
   * 这层不是用户主动点开、而是被「没有项目」的门禁弹出来时，这里写清是哪个动作把他领到
   * 这儿的。toast 两秒多就没了，弹层却一直开着 —— 因果只写在 toast 上，等于没写。
   */
  reason?: string | null;
  onClose: () => void;
  onCreated: (project: ProjectView) => void;
  notify: (message: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 占位符按**服务端**那台机器的形状给：路径要落在跑 server 的机器上，
  // 在 Windows 上照着 `/Users/you/...` 填是填不出能用的目录的。
  const host = useHostInfo();

  // 多人模式下这个人的目录。它一存在，两条路的路径框就都锁前缀。
  const { state: auth } = useAuth();
  const homeDir = auth.mode === "multi" ? (auth.homeDir ?? "").trim() : "";
  const isAdmin = auth.user?.role === "admin";
  // 管理员的出口：服务端本来就不钳他（§七），界面不该比服务端更严。普通用户没有这个
  // 开关 —— 对他们来说「其它路径」是一条必然 403 的死路。
  const [freePath, setFreePath] = useState(false);
  const scopedHome = homeDir && !(isAdmin && freePath) ? homeDir : null;

  const [name, setName] = useState("");
  // 名字被手打过就不再被自动推导覆盖 —— 自动填只该在用户没表态的时候帮忙。
  const [nameTouched, setNameTouched] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  // 锁前缀那条路上，输入框里只剩家目录之后的一截。
  const [localTail, setLocalTail] = useState("");
  const [localTailTouched, setLocalTailTouched] = useState(false);

  const [url, setUrl] = useState("");
  const [parentDir, setParentDir] = useState("");
  const [parentTail, setParentTail] = useState("");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [branch, setBranch] = useState("");
  const [cloneUser, setCloneUser] = useState("");
  const [cloneSecret, setCloneSecret] = useState("");

  // 本地那条路：锁前缀时后面那一截**必须有** —— 服务端明确拒绝「目录根本身」，所以留空
  // 时干脆算作没填路径（探测不跑、按钮不亮），而不是拼出一条注定被拒的路径。
  const localPath = scopedHome
    ? (localTail.trim() ? joinHostPath(host, scopedHome, localTail) : "")
    : repoPath;
  // 克隆那条路：上级目录留空是正常的，那就是「直接放在我的目录下」。
  const parentPath = scopedHome ? joinHostPath(host, scopedHome, parentTail) : parentDir;
  const target = joinHostPath(host, parentPath, folder);
  const probePath = mode === "local" ? localPath : target;
  const purpose = mode === "local" ? "existing-or-new" : "clone-target";
  const pathHealth = useDebouncedPathHealth(probePath);
  const verdict = pathHealthState(pathHealth, probePath, purpose);
  const urlProblem = mode === "clone" ? repoUrlError(url) : null;
  // 凭证只对 HTTPS 有意义：SSH 那条走的是私钥，填了用户名密码也没人会去问。
  const httpsUrl = /^https?:\/\//i.test(url.trim());

  // 只在**确知**目录不存在时才请服务端建 —— 探测没回来/失败时按老行为走（照记不误，不动
  // 磁盘）。这样按钮上写的和真正会发生的事永远是同一件：写着「创建目录」就一定建，
  // 写着「创建项目」就一定不建。路径被一个文件占着时 `exists` 同样是 false，但那条路建
  // 不出来（服务端 409），所以要把它排掉，否则按钮会承诺一件做不到的事。
  const willCreateDir = mode === "local"
    && pathHealth.health?.exists === false
    && !pathHealth.health.occupied;

  const takenBy = useMemo(() => {
    const value = probePath.trim().replace(/[\\/]+$/, "");
    if (!value) return null;
    // 前端只做「长得一样」的粗判（服务端按物理路径认，见 repoKey）。克隆那条路服务端会
    // 真的拒绝，所以这里也拦；本地那条路服务端允许重复登记，就只提醒不拦 —— 用户可能
    // 真的想给同一个目录开第二个项目，那是他的事，但他得知道自己在做什么。
    return projects.find((p) => p.repoPath.trim().replace(/[\\/]+$/, "") === value) ?? null;
  }, [projects, probePath]);

  const setNameFrom = (value: string) => {
    if (!nameTouched) setName(value);
  };

  /**
   * 项目名 → 目录名。锁前缀时才这么推：那条路上目录名是「家目录下的一截」，跟项目名同名
   * 是唯一不用解释的默认；自由填路径时用户心里的目录多半和项目名无关，别去猜。
   *
   * 两个方向各自认自己的 touched 标志，所以不会来回覆盖：先打名字就路径跟着名字走，
   * 先填路径就名字跟着路径走，手动改过的那一侧永远不再被自动填动。
   */
  const applyName = (value: string) => {
    setName(value);
    setNameTouched(true);
    if (!scopedHome) return;
    const segment = pathSegmentFromName(value);
    // 两条路一起填：切模式时看到的仍然是同一个默认，不用再填一遍。
    if (!localTailTouched) setLocalTail(segment);
    if (!folderTouched) setFolder(segment);
  };

  // 手打路径和用「浏览…」挑路径走同一条:项目名默认就是目录名。只有挑不填、打字要自己填
  // 的话,用户填完一条长路径还会撞上一个禁用的按钮,而原因在另一个字段上。
  const applyPickedLocal = (picked: string) => {
    setRepoPath(picked);
    setNameFrom(directoryName(picked));
  };

  const applyLocalTail = (tail: string) => {
    setLocalTail(tail);
    setLocalTailTouched(true);
    setNameFrom(directoryName(tail));
  };

  /**
   * 管理员那把钥匙的两个方向都要**带着当前这条路径走**：跳出去时把已经填好的路径灌进
   * 自由输入框，跳回来时若那条路径还在自己的目录里就还原成后面那一截。否则每按一下开关
   * 都得从空框重打一遍，而这个开关本来就是给「改一改前缀」用的。
   */
  const toggleFreePath = (next: boolean) => {
    if (next) {
      if (!repoPath.trim()) setRepoPath(localPath || scopedHome || homeDir);
      if (!parentDir.trim()) setParentDir(parentPath);
    } else {
      const localBack = pathTailUnder(homeDir, repoPath, host?.platform === "win32");
      if (localBack) {
        setLocalTail(localBack);
        setLocalTailTouched(true);
      }
      const parentBack = pathTailUnder(homeDir, parentDir, host?.platform === "win32");
      if (parentBack !== null) setParentTail(parentBack);
    }
    setFreePath(next);
  };

  const applyUrl = (value: string) => {
    setUrl(value);
    const derived = repoNameFromUrl(value);
    if (!derived) return;
    if (!folderTouched) {
      setFolder(derived);
      setNameFrom(derived);
    }
  };

  const canSubmit = mode === "local"
    ? !!name.trim() && !!localPath.trim() && !verdict.blocked
    : !!name.trim() && !!url.trim() && !!parentPath.trim() && !!folder.trim() && !urlProblem && !verdict.blocked && !takenBy;

  const submit = async () => {
    if (!canSubmit || busy || pathHealth.checking) return;
    setBusy(true);
    setError(null);
    try {
      const created = mode === "local"
        ? await api.createProject(name.trim(), localPath.trim(), willCreateDir)
        : await api.cloneProject({
          url: url.trim(),
          targetPath: target,
          branch: branch.trim(),
          name: name.trim(),
          // 两个都填了才递 —— 服务端也是这么判的（`credentialInjection`），只填一半
          // 等于没填，别让用户以为自己配上了。
          ...(httpsUrl && cloneUser.trim() && cloneSecret
            ? { username: cloneUser.trim(), secret: cloneSecret }
            : {}),
        });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "项目创建失败");
    } finally {
      setBusy(false);
    }
  };

  return <ConfirmDialog
    className="create-project-dialog"
    title="新建项目"
    eyebrow="PROJECT SETUP"
    icon={<FolderPlus size={21} weight="duotone" />}
    message={reason ? `${reason}项目目录会成为任务的默认运行位置。` : "项目目录会成为任务的默认运行位置。"}
    confirmLabel={mode === "clone" ? "克隆并创建" : willCreateDir ? "创建目录并创建项目" : "创建项目"}
    busy={busy}
    confirmDisabled={!canSubmit || pathHealth.checking}
    onClose={onClose}
    onConfirm={() => void submit()}
  >
    <div className="create-project-modes" role="group" aria-label="新建项目的方式">
      {MODES.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`create-project-mode${mode === item.key ? " is-on" : ""}`}
          aria-pressed={mode === item.key}
          disabled={busy}
          onClick={() => { setMode(item.key); setError(null); }}
        >
          <span aria-hidden="true">{item.key === "local" ? <FolderOpen size={19} weight="duotone" /> : <GitBranch size={19} weight="duotone" />}</span>
          <span><b>{item.label}</b><small>{item.hint}</small></span>
        </button>
      ))}
    </div>

    <div className="quick-create-fields">
      {mode === "clone" && <>
        <label><span>仓库地址</span><input
          autoFocus
          className="mono"
          value={url}
          onChange={(event) => applyUrl(event.target.value)}
          placeholder="https://github.com/owner/repo.git"
        /></label>
        <label><span>克隆到（上级目录）</span>{scopedHome
          ? <ScopedPathField
            home={scopedHome}
            host={host}
            value={parentTail}
            onChange={setParentTail}
            placeholder="留空 = 直接放在你的目录下"
            disabled={busy}
            notify={notify}
          />
          : <span className="path-field"><input
            className="mono"
            value={parentDir}
            onChange={(event) => setParentDir(event.target.value)}
            placeholder={hostSamplePath(host, ["code"])}
          /><DirectoryPickerButton startIn={parentDir} onPick={setParentDir} disabled={busy} notify={notify} /></span>}</label>
        {homeDir && isAdmin && <FreePathToggle free={freePath} onToggle={toggleFreePath} disabled={busy} />}
        <div className="create-project-row">
          <label><span>目录名</span><input
            className="mono"
            value={folder}
            onChange={(event) => { setFolder(event.target.value); setFolderTouched(true); setNameFrom(event.target.value); }}
            placeholder="repo"
          /></label>
          <label><span>分支（可选）</span><input
            className="mono"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="留空 = 远端默认分支"
          /></label>
        </div>
        {/* 目标路径是两个字段拼出来的，紧跟在它们后面给一眼结果，别让用户自己在脑子里拼。 */}
        {target && <p className="create-project-target"><span>克隆到</span><code>{target}</code></p>}

        {/* 私有仓库的凭证得在**这一刻**给：项目设置页里那份要等项目建出来才有，而克隆
            正是最先撞上鉴权的一步。公开仓库留空即可。 */}
        {httpsUrl && <>
          <div className="create-project-row">
            <label><span>用户名（可选）</span><input
              value={cloneUser}
              autoComplete="off"
              onChange={(event) => setCloneUser(event.target.value)}
              placeholder="私有仓库才需要"
            /></label>
            <label><span>令牌 / 密码</span><input
              type="password"
              value={cloneSecret}
              autoComplete="new-password"
              onChange={(event) => setCloneSecret(event.target.value)}
              placeholder="GitHub / GitLab 的 access token"
            /></label>
          </div>
          <p className="create-project-mode-hint">
            填了就在克隆时用上，并存到新项目的 Git 凭证里，之后的拉取和推送都跟着用；只存在
            ash 自己的库里，不写进仓库。
          </p>
        </>}
      </>}

      <label><span>项目名称</span><input
        autoFocus={mode === "local"}
        value={name}
        onChange={(event) => applyName(event.target.value)}
        placeholder="如 ash"
      /></label>

      {mode === "local" && <>
        <label><span>工作目录</span>{scopedHome
          ? <ScopedPathField
            home={scopedHome}
            host={host}
            value={localTail}
            onChange={applyLocalTail}
            placeholder="目录名，默认跟项目名一样"
            disabled={busy}
            notify={notify}
          />
          : <span className="path-field"><input
            className="mono"
            value={repoPath}
            onChange={(event) => applyPickedLocal(event.target.value)}
            placeholder={hostSamplePath(host, ["code", "project"])}
          /><DirectoryPickerButton startIn={repoPath} onPick={applyPickedLocal} disabled={busy} notify={notify} /></span>}</label>
        {/* 拼出来的完整路径给一眼结果 —— 前缀那一截可能被输入框挤到省略号里，别让人猜。 */}
        {scopedHome && localPath && <p className="create-project-target"><span>创建在</span><code>{localPath}</code></p>}
        {homeDir && isAdmin && <FreePathToggle free={freePath} onToggle={toggleFreePath} disabled={busy} />}
      </>}

      {/* 地址不合法就先说地址 —— 路径体检那句在地址还没成形时说不出有用的话。
          克隆那侧路径已被项目占着时也只说这一条：磁盘那句（「这里已经是个仓库」）和它
          说的是同一件事的两个侧面，两个红框叠着只是噪音，而登记那句更能指出下一步。
          锁前缀而目录名还空着时，体检那句（「填写目录后会检查…」）说不出**为什么不能
          就用我的目录本身**，而这正是按钮不亮的原因，所以那一格换成它。 */}
      {urlProblem
        ? <div className="settings-health is-error create-project-health" role="status"><i aria-hidden="true" />{urlProblem}</div>
        : (mode === "clone" && takenBy) ? null
        : (mode === "local" && scopedHome && !localTail.trim())
        ? <div className="settings-health create-project-health" role="status"><i aria-hidden="true" />在你的目录下起一个目录名；项目不能直接落在目录本身上</div>
        : <PathHealthStatus
          path={probePath}
          state={pathHealth}
          purpose={purpose}
          className="create-project-health"
        />}

      {takenBy && <div
        className={`settings-health create-project-health${mode === "clone" ? " is-error" : ""}`}
        role="status"
      >
        <i aria-hidden="true" />
        {mode === "clone"
          ? `这个目录已经登记为项目「${takenBy.name}」了；换个目录名`
          : `这个目录已经登记为项目「${takenBy.name}」了；继续创建会得到两个指向同一目录的项目`}
      </div>}

      {busy && mode === "clone" && <p className="create-project-note">正在克隆…大仓库可能要几分钟，别关这个窗口。</p>}
      {error && <div className="create-project-error" role="alert">{error}</div>}
    </div>
  </ConfirmDialog>;
}

/**
 * 实例管理员那把「跳出自己目录」的钥匙。只画给管理员：服务端对他不设钳制（§七），
 * 界面比服务端更严就成了他自己给自己上的锁；对普通用户则相反 —— 给他这个开关等于
 * 请他去撞一堵 403 的墙。
 */
function FreePathToggle({ free, onToggle, disabled }: {
  free: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
}) {
  return <p className="create-project-free-path">
    <span>{free ? "正在使用自定义路径（管理员可以放到根目录之外）" : "默认放在你自己的目录里"}</span>
    <Button variant="ghost" disabled={disabled} onClick={() => onToggle(!free)}>
      {free ? "回到我的目录" : "用其它路径…"}
    </Button>
  </p>;
}
