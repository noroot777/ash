import { useState, useEffect } from "react";
import type { ProjectView } from "@harness/shared";
import { Modal, ConfirmModal, fieldCls, primaryCls } from "./Modal";
import { PathHealth } from "./ui";
import { api } from "./api";

// Project settings — the canonical home for editing a project's name + repoPath
// (load-bearing: it's the cwd of every run), with live path validation and a
// danger-zone delete. Opened from the switcher and Cmd-K.
export function ProjectSettings({
  project,
  onClose,
  onSave,
  onDelete,
}: {
  project: ProjectView;
  onClose: () => void;
  onSave: (patch: { name: string; repoPath: string }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [repoPath, setRepoPath] = useState(project.repoPath);
  const [confirmDel, setConfirmDel] = useState(false);
  // 大模型 API Key（事项的「直连大模型」解析用，存在项目上）。只读出「是否已配置」，
  // 永不回传明文；留空保存表示不改动那一项。
  const [keyHas, setKeyHas] = useState<{ anthropic: boolean; openai: boolean }>({ anthropic: false, openai: false });
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [keyMsg, setKeyMsg] = useState("");
  useEffect(() => {
    api.projectApiKeys(project.id).then(setKeyHas).catch(() => {});
  }, [project.id]);
  const saveKeys = async () => {
    const patch: { anthropic?: string; openai?: string } = {};
    if (anthropicKey) patch.anthropic = anthropicKey;
    if (openaiKey) patch.openai = openaiKey;
    if (!Object.keys(patch).length) return;
    await api.setProjectApiKeys(project.id, patch);
    setKeyHas(await api.projectApiKeys(project.id).catch(() => keyHas));
    setAnthropicKey("");
    setOpenaiKey("");
    setKeyMsg("已保存");
    setTimeout(() => setKeyMsg(""), 2000);
  };
  const dirty = name.trim() !== project.name || repoPath.trim() !== project.repoPath;
  const save = () => name.trim() && onSave({ name: name.trim(), repoPath: repoPath.trim() });
  return (
    <>
      <Modal
        title="项目设置"
        onClose={onClose}
        footer={(close) => (
          <>
            <button
              onClick={() => setConfirmDel(true)}
              className="mr-auto rounded-md px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
            >
              删除项目
            </button>
            <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
            <button disabled={!name.trim() || !dirty} onClick={save} className={primaryCls}>保存</button>
          </>
        )}
      >
        <div className="flex flex-col gap-3" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && save()}>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">项目名称</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如 my-app" className={fieldCls} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">git 仓库路径</span>
            <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/Users/you/code/my-app" className={`${fieldCls} font-mono`} />
            <PathHealth path={repoPath} />
          </label>

          <div className="mt-1 border-t border-line pt-3">
            <div className="text-[12px] font-medium text-ink">大模型 API Key</div>
            <div className="mb-2.5 mt-0.5 text-[11px] text-faint">
              用于事项的「直连大模型」解析(本机存储,不上传)。本地 CLI 智能体(@claude/@codex)不需要。
            </div>
            <label className="mb-2 flex flex-col gap-1">
              <span className="text-[11px] text-muted">
                Anthropic{keyHas.anthropic && <span className="ml-1.5 text-emerald-600">· 已配置</span>}
              </span>
              <input
                type="password"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder={keyHas.anthropic ? "已配置(留空不改)" : "sk-ant-…"}
                className={`${fieldCls} font-mono`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted">
                OpenAI{keyHas.openai && <span className="ml-1.5 text-emerald-600">· 已配置</span>}
              </span>
              <input
                type="password"
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                placeholder={keyHas.openai ? "已配置(留空不改)" : "sk-…"}
                className={`${fieldCls} font-mono`}
              />
            </label>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={saveKeys}
                disabled={!anthropicKey && !openaiKey}
                className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink hover:bg-raised disabled:opacity-40"
              >
                保存 Key
              </button>
              {keyMsg && <span className="text-[12px] text-emerald-600">{keyMsg}</span>}
            </div>
          </div>
        </div>
      </Modal>
      {confirmDel && (
        <ConfirmModal
          title="删除项目"
          message={`确定删除「${project.name}」？该项目下的所有任务、分组、运行记录都会一并删除，无法撤销。`}
          confirmLabel="删除"
          danger
          onConfirm={onDelete}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </>
  );
}
