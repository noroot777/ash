import { useState, type ReactNode } from "react";
import { CheckCircle, GitBranch, SpinnerGap, Trash, Warning } from "@phosphor-icons/react";
import { ApiError, api, type FileEntryOverview } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { formatSize } from "./fileModel.ts";

// 删一个文件 / 一整个文件夹的确认框。
//
// 它不问「确定吗」，而是把**后果**摆出来，因为这三件事在不同情况下差别极大：
//   ① 去向：默认移到系统废纸篓（访达里能放回原处）；这台机器没有废纸篓时只剩永久删除。
//   ② 找不找得回来：**已跟踪文件真正的后悔药是 git** 而不是废纸篓——删完它会在「源代码
//      管理」里变成一条 deleted 改动，丢弃那条就回来了。未跟踪的则一点备份都没有。
//   ③ 有没有人正在写这个目录：agent 此刻可能正往里写，删掉的可能是它刚做出来的东西。
//
// 升一档的判据是「点错了回不来」：非空文件夹、或者没有废纸篓可用，就要求抄一遍名字。
// 单个已跟踪文件不折腾——它在 git 里有备份。

function typeToConfirmNeeded(overview: FileEntryOverview, mode: "trash" | "permanent"): boolean {
  if (mode === "permanent") return true;
  const stats = overview.stats;
  return overview.target.kind === "dir" && !!stats && stats.files + stats.dirs > 0;
}

function Fact({
  tone,
  icon,
  title,
  children,
}: {
  tone?: "danger" | "warn" | "ok";
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`file-delete__fact${tone ? ` is-${tone}` : ""}`}>
      <span aria-hidden="true">{icon}</span>
      <div>
        <b>{title}</b>
        {children}
      </div>
    </div>
  );
}

export function DeleteEntryDialog({
  taskId,
  overview,
  onDeleted,
  onClose,
}: {
  taskId: string;
  overview: FileEntryOverview;
  /** 删成功了。调用方负责关掉这块内容、刷新文件树、说那句提示。 */
  onDeleted: (result: { name: string; kind: "dir" | "file"; mode: "trash" | "permanent"; files: number }) => void;
  onClose: () => void;
}) {
  const { target, stats, git, trash } = overview;
  const isDir = target.kind === "dir";
  // 废纸篓用不了（这台机器没有 / 送进去失败了）之后，用户可以改点永久删除——那是另一次
  // 明确的选择，不是自动降级。
  const [mode, setMode] = useState<"trash" | "permanent">(trash.available ? "trash" : "permanent");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trashFailed, setTrashFailed] = useState<string | null>(null);

  const needsTyping = typeToConfirmNeeded(overview, mode);
  const fileCount = stats ? stats.files : 1;
  const countText = stats
    ? `${stats.files.toLocaleString()} 个文件、${stats.dirs.toLocaleString()} 个子文件夹，合计 ${formatSize(stats.bytes)}${stats.truncated ? "（还没数完，实际更多）" : ""}`
    : formatSize(target.size);

  const remove = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteTaskFile(taskId, target.path, { mode, force });
      onDeleted({ name: result.name, kind: result.kind, mode: result.mode, files: fileCount });
    } catch (reason) {
      const body = reason instanceof ApiError ? reason.body as Record<string, unknown> | null : null;
      if (body?.trashFailed === true) {
        // 送进废纸篓失败：换成永久删除是**用户的下一次点击**，这里只把情况说清楚。
        setTrashFailed(reason instanceof Error ? reason.message : String(reason));
        setMode("permanent");
        setTyped("");
      } else if (body?.needsForce === true && !force) {
        // 「有人正在写这个目录」那一档本来就该在这个框里说清楚（下面的红卡），所以不再
        // 套第二个框：用户看着那张卡点的这一下，就是 force。
        await remove(true);
        return;
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const noBackup = mode === "permanent"
    ? "删掉之后就真没了——git 里没有，废纸篓也没有。"
    : `删掉之后只剩${trash.label ?? "废纸篓"}这一份。`;

  return (
    <ConfirmDialog
      className="file-delete-dialog"
      icon={<Trash size={19} weight="fill" />}
      title={isDir ? `删除 ${target.name} 文件夹` : `删除 ${target.name}`}
      message={isDir
        ? `${target.path}/ 里有 ${countText}，会整个${mode === "trash" ? `移到${trash.label ?? "废纸篓"}` : "从磁盘上删掉"}。`
        : `会把 ${target.path}（${countText}）从任务工作目录里${mode === "trash" ? `移到${trash.label ?? "废纸篓"}` : "删掉"}。${target.symlink ? "这是一条软链，只删链接本身，不碰它指向的目标。" : ""}`}
      confirmLabel={overview.busy.running ? "仍然删除" : isDir ? "删除整个文件夹" : "删除文件"}
      danger
      busy={busy}
      confirmDisabled={needsTyping && typed !== target.name}
      onConfirm={() => void remove(overview.busy.running)}
      onClose={onClose}
    >
      {overview.busy.running && (
        <Fact tone="danger" icon={<Warning size={16} weight="fill" />} title="有任务正在这个工作目录里运行">
          <p>{overview.busy.reason}。删掉的可能是它刚写出来、还没提交的成果。</p>
        </Fact>
      )}

      {mode === "trash" ? (
        <Fact tone="ok" icon={<CheckCircle size={16} weight="fill" />} title={`去向：${trash.label}`}>
          <p>在访达里能「放回原处」。ash 不做自己的回收站——系统那个用户本来就会用。</p>
        </Fact>
      ) : (
        <Fact tone="warn" icon={<Warning size={16} />} title="永久删除，没有兜底">
          <p>{trashFailed ?? trash.reason ?? "这台机器上没有可用的废纸篓"}。删除会直接落到磁盘上，所以下面要求抄一遍名字。</p>
          {trash.available && !trashFailed && (
            <button type="button" className="file-delete__switch" onClick={() => { setMode("trash"); setTyped(""); }}>
              改回移到{trash.label}
            </button>
          )}
        </Fact>
      )}

      {git.untracked > 0 || (!isDir && git.repo && git.tracked === 0) ? (
        <Fact tone="danger" icon={<Warning size={16} weight="fill" />} title="有未跟踪内容，git 里没有备份">
          <p>
            {isDir
              ? `这个文件夹里有 ${git.untracked.toLocaleString()} 个未跟踪文件。`
              : `${target.path} 还没进过任何提交。`}
            {noBackup}
          </p>
          {/* 只有文件夹才列样例：单个文件的「样例」就是它自己，抄一遍没意义。 */}
          {isDir && git.untrackedSamples.length > 0 && (
            <ul>
              {git.untrackedSamples.map((path) => <li key={path}>{path}</li>)}
              {git.untracked > git.untrackedSamples.length && (
                <li>…… 还有 {(git.untracked - git.untrackedSamples.length).toLocaleString()} 个</li>
              )}
            </ul>
          )}
        </Fact>
      ) : git.repo && git.tracked > 0 ? (
        <Fact icon={<GitBranch size={16} />} title="被 git 跟踪的部分删掉了也能找回来">
          <p>
            删除后它会在「源代码管理」里变成一条 deleted 改动，丢弃那条改动就恢复到上次提交的样子；
            {git.dirty > 0 ? `这里面有 ${git.dirty} 个文件的改动还没提交，那部分只能去${mode === "trash" ? (trash.label ?? "废纸篓") : "……没地方"}找。` : "没有未提交的改动。"}
          </p>
        </Fact>
      ) : null}

      {git.error && (
        <Fact tone="warn" icon={<Warning size={16} />} title="git 状态没读出来">
          <p>{git.error}。所以「删了还找不找得回来」这句话这次说不准。</p>
        </Fact>
      )}

      {needsTyping && (
        <div className="file-delete__type">
          <label htmlFor="file-delete-typed">
            抄一遍名字确认：输入 <b>{target.name}</b>
          </label>
          <input
            id="file-delete-typed"
            type="text"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={typed}
            disabled={busy}
            placeholder="在这里一个字一个字地敲"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      )}

      {error && (
        <p className="file-delete__error" role="alert">
          <Warning size={13} aria-hidden="true" />
          {error}
        </p>
      )}
      {busy && (
        <p className="file-delete__error is-busy" role="status">
          <SpinnerGap size={13} aria-hidden="true" />
          正在删除…
        </p>
      )}
    </ConfirmDialog>
  );
}
