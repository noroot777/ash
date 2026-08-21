import { useMemo, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { repoNameFromUrl, repoUrlError } from "@ash/shared/repo-url";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { DirectoryPickerButton, directoryName } from "../components/DirectoryPickerButton.tsx";
import { hostSamplePath, joinHostPath, useHostInfo } from "../lib/useHostInfo.ts";
import { PathHealthStatus, pathHealthState, useDebouncedPathHealth } from "../settings/PathHealthStatus.tsx";
import { api } from "../lib/api.ts";

// 新建项目的两条路。它们的差别不只是「多几个输入框」，而是**目录归谁管**：
//
//  · 本地已有目录 —— 目录是用户的，ash 只往库里记一行路径。目录不存在就是填错了。
//  · 从 Git 检出 —— 目录由 ash 建（连同缺失的上级目录）。这里「目录不存在」反而是正常
//    情况，「已经有东西」才是错。
//
// 所以两条路的路径提示、按钮门禁、失败后果全是相反的，不能压成一个表单加一个复选框。
//
// 失败信息留在弹层里而不是 toast：克隆的报错是 git 的原文（鉴权失败、仓库不存在、网络
// 不通），常常好几行，而且用户多半要照着它改地址再试一次 —— 表单必须还在。

type Mode = "local" | "clone";

const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: "local", label: "本地已有目录", hint: "目录已经在这台机器上（不管是不是 Git 仓库）" },
  { key: "clone", label: "从 Git 检出", hint: "输入仓库地址，ash 克隆到你指定的位置" },
];

export function CreateProjectDialog({ projects, onClose, onCreated, notify }: {
  /** 已有项目，用来在填到一条已登记的路径时当场提醒，而不是造出第二个同仓库项目。 */
  projects: ProjectView[];
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

  const [name, setName] = useState("");
  // 名字被手打过就不再被自动推导覆盖 —— 自动填只该在用户没表态的时候帮忙。
  const [nameTouched, setNameTouched] = useState(false);
  const [repoPath, setRepoPath] = useState("");

  const [url, setUrl] = useState("");
  const [parentDir, setParentDir] = useState("");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [branch, setBranch] = useState("");

  const target = joinHostPath(host, parentDir, folder);
  const probePath = mode === "local" ? repoPath : target;
  const pathHealth = useDebouncedPathHealth(probePath);
  const verdict = pathHealthState(pathHealth, probePath, mode === "local" ? "existing" : "clone-target");
  const urlProblem = mode === "clone" ? repoUrlError(url) : null;

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

  // 手打路径和用「浏览…」挑路径走同一条:项目名默认就是目录名。只有挑不填、打字要自己填
  // 的话,用户填完一条长路径还会撞上一个禁用的按钮,而原因在另一个字段上。
  const applyPickedLocal = (picked: string) => {
    setRepoPath(picked);
    setNameFrom(directoryName(picked));
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
    ? !!name.trim() && !!repoPath.trim()
    : !!name.trim() && !!url.trim() && !!parentDir.trim() && !!folder.trim() && !urlProblem && !verdict.blocked && !takenBy;

  const submit = async () => {
    if (!canSubmit || busy || pathHealth.checking) return;
    setBusy(true);
    setError(null);
    try {
      const created = mode === "local"
        ? await api.createProject(name.trim(), repoPath.trim())
        : await api.cloneProject({ url: url.trim(), targetPath: target, branch: branch.trim(), name: name.trim() });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "项目创建失败");
    } finally {
      setBusy(false);
    }
  };

  const activeHint = MODES.find((m) => m.key === mode)?.hint ?? "";

  return <ConfirmDialog
    title="新建项目"
    message="项目目录会成为任务的默认运行位置。"
    confirmLabel={mode === "local" ? "创建项目" : "克隆并创建"}
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
          {item.label}
        </button>
      ))}
    </div>
    <p className="create-project-mode-hint">{activeHint}</p>

    <div className="quick-create-fields">
      {mode === "clone" && <>
        <label><span>仓库地址</span><input
          autoFocus
          className="mono"
          value={url}
          onChange={(event) => applyUrl(event.target.value)}
          placeholder="https://github.com/owner/repo.git"
        /></label>
        <label><span>克隆到（上级目录）</span><span className="path-field"><input
          className="mono"
          value={parentDir}
          onChange={(event) => setParentDir(event.target.value)}
          placeholder={hostSamplePath(host, ["code"])}
        /><DirectoryPickerButton startIn={parentDir} onPick={setParentDir} disabled={busy} notify={notify} /></span></label>
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
      </>}

      <label><span>项目名称</span><input
        autoFocus={mode === "local"}
        value={name}
        onChange={(event) => { setName(event.target.value); setNameTouched(true); }}
        placeholder="如 ash"
      /></label>

      {mode === "local" && <label><span>工作目录</span><span className="path-field"><input
        className="mono"
        value={repoPath}
        onChange={(event) => applyPickedLocal(event.target.value)}
        placeholder={hostSamplePath(host, ["code", "project"])}
      /><DirectoryPickerButton startIn={repoPath} onPick={applyPickedLocal} disabled={busy} notify={notify} /></span></label>}

      {/* 地址不合法就先说地址 —— 路径体检那句在地址还没成形时说不出有用的话。
          克隆那侧路径已被项目占着时也只说这一条：磁盘那句（「这里已经是个仓库」）和它
          说的是同一件事的两个侧面，两个红框叠着只是噪音，而登记那句更能指出下一步。 */}
      {urlProblem
        ? <div className="settings-health is-error create-project-health" role="status"><i aria-hidden="true" />{urlProblem}</div>
        : (mode === "clone" && takenBy) ? null
        : <PathHealthStatus
          path={probePath}
          state={pathHealth}
          purpose={mode === "local" ? "existing" : "clone-target"}
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
