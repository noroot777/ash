import { useEffect, useMemo, useState } from "react";
import { Copy, FolderOpen, SpinnerGap, Warning, X } from "@phosphor-icons/react";
import { api, type FileContent } from "../lib/api.ts";
import { formatSize } from "./fileModel.ts";
import { OpenWithMenu } from "./OpenWithMenu.tsx";

function TextBody({ file }: { file: FileContent }) {
  const lines = useMemo(() => (file.text ?? "").split("\n"), [file.text]);
  return (
    <div className="file-viewer__code">
      <div className="file-viewer__gutter" aria-hidden="true">
        {lines.map((_line, index) => <span key={index}>{index + 1}</span>)}
      </div>
      <pre className="file-viewer__text"><code>{file.text}</code></pre>
    </div>
  );
}

function Body({ taskId, file }: { taskId: string; file: FileContent }) {
  const rawUrl = api.taskFileRawUrl(taskId, file.path);
  if (file.kind === "image") {
    return (
      <div className="file-viewer__media">
        <img src={rawUrl} alt={file.name} />
      </div>
    );
  }
  if (file.kind === "pdf") {
    // iframe 的无障碍名用 aria-label 而不是 title：原生 title 在这个仓库是受管控的存量。
    return <iframe className="file-viewer__pdf" src={rawUrl} aria-label={`${file.name} 预览`} />;
  }
  if (file.kind === "binary") {
    return (
      <div className="file-viewer__placeholder">
        <b>这是一个二进制文件</b>
        <p>网页里没法有意义地显示它的内容。用上方的「打开方式」交给本机的应用，或者在文件夹中查看。</p>
      </div>
    );
  }
  return <TextBody file={file} />;
}

/**
 * 会话区里的文件查看器。
 *
 * 摆在中间那一栏而不是另开弹层：看文件时通常要对着 agent 说话，弹层会把回复框盖住。
 * 关掉它就回到会话，跟审查工作区是同一套「中间区换一块内容」的做法。
 */
export function FileViewer({
  taskId,
  path,
  onClose,
  notify,
}: {
  taskId: string;
  path: string;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealing, setRevealing] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.taskFile(taskId, path)
      .then((result) => { if (alive) setFile(result.file); })
      .catch((reason) => {
        if (!alive) return;
        setFile(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, taskId]);

  const reveal = async () => {
    setRevealing(true);
    try {
      await api.revealTaskFile(taskId, path);
      notify("已在文件管理器中定位");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRevealing(false);
    }
  };

  return (
    <div className="file-viewer" aria-label="文件查看">
      <header className="file-viewer__bar">
        <div className="file-viewer__title">
          <b>{file?.name ?? path.split("/").pop()}</b>
          <small>{path}{file ? ` · ${formatSize(file.size)}` : ""}</small>
        </div>
        <button
          type="button"
          className="file-viewer__action"
          disabled={revealing}
          onClick={() => void reveal()}
        >
          <FolderOpen size={13} aria-hidden="true" />
          在文件夹中查看
        </button>
        <OpenWithMenu taskId={taskId} path={path} notify={notify} />
        <button
          type="button"
          className="file-viewer__action"
          aria-label="复制文件的完整路径"
          disabled={!file}
          onClick={async () => {
            if (!file) return;
            try {
              await navigator.clipboard.writeText(file.absPath);
              notify("已复制文件路径");
            } catch {
              notify("浏览器不允许写剪贴板");
            }
          }}
        >
          <Copy size={13} aria-hidden="true" />
        </button>
        <button type="button" className="file-viewer__action" aria-label="关闭文件，回到会话" onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </button>
      </header>

      {file?.truncated && (
        <p className="file-viewer__notice">
          <Warning size={12} aria-hidden="true" />
          文件超过 2 MB，只显示了前面一部分。要看全文请用本机应用打开。
        </p>
      )}

      <div className="file-viewer__body">
        {loading && <p className="file-viewer__state"><SpinnerGap size={14} aria-hidden="true" />正在读取…</p>}
        {error && <p className="file-viewer__state is-error"><Warning size={14} aria-hidden="true" />{error}</p>}
        {!loading && !error && file && <Body taskId={taskId} file={file} />}
      </div>
    </div>
  );
}
