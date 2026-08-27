// 目录树选择器:在**自己的目录里**点出一个路径。多人模式下普通用户没有系统文件
// 选择窗口(那个窗口选得到整台机器的任意路径,是实例管理员的工具),这是替代品。
//
// 形状上的两个决定:
//  · 它只展示服务端愿意给的东西 —— `/fs/browse` 自己会把路径夹在调用者的目录里,
//    前端不做第二份判断,免得两边规则漂移。
//  · 已经是 git 仓库的目录单独标出来:用户多半是来找仓库的,而不是来找空目录的。
import { useCallback, useEffect, useState } from "react";
import { FolderSimple, GitBranch, CaretRight, CaretDown } from "@phosphor-icons/react";
import { ApiError } from "../lib/apiClient.ts";
import { fsBrowseApi, type BrowseEntry } from "../lib/authApi.ts";
import { Button, TextInput } from "./ui.tsx";
import "./directory-tree.css";

type NodeState = { entries: BrowseEntry[]; open: boolean };

export function DirectoryTreePicker({
  value,
  onPick,
  onClose,
  notify,
}: {
  value: string;
  onPick: (path: string) => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [root, setRoot] = useState<{ path: string; name: string; clamped: boolean } | null>(null);
  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  const [selected, setSelected] = useState(value);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fsBrowseApi
      .root()
      .then((r) => {
        setRoot({ path: r.root, name: r.name, clamped: r.clamped });
        setNodes({ [r.root]: { entries: r.entries, open: true } });
        setSelected((prev) => prev || r.root);
      })
      .catch((e) => notify(e instanceof ApiError ? e.message : "读不出目录"));
  }, [notify]);

  const toggle = useCallback(
    async (path: string) => {
      const known = nodes[path];
      if (known) {
        setNodes((prev) => ({ ...prev, [path]: { ...known, open: !known.open } }));
        return;
      }
      try {
        const result = await fsBrowseApi.open(path);
        setNodes((prev) => ({ ...prev, [path]: { entries: result.entries, open: true } }));
      } catch (e) {
        notify(e instanceof ApiError ? e.message : "这个目录打不开");
      }
    },
    [nodes, notify],
  );

  const makeDir = useCallback(async () => {
    const name = newName.trim();
    if (!name || !selected) return;
    setBusy(true);
    try {
      const created = await fsBrowseApi.mkdir(`${selected}/${name}`);
      setNewName("");
      // 父目录已经展开过就得手动补一行,不然新建完看不见它。
      const parent = nodes[selected];
      if (parent) {
        setNodes((prev) => ({
          ...prev,
          [selected]: {
            ...parent,
            entries: [
              ...parent.entries,
              { name, path: created.path, hasChildren: false, isRepo: false },
            ].sort((a, b) => a.name.localeCompare(b.name)),
          },
        }));
      }
      setSelected(created.path);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "新建目录失败");
    } finally {
      setBusy(false);
    }
  }, [newName, selected, nodes, notify]);

  const renderLevel = (path: string, depth: number) => {
    const node = nodes[path];
    if (!node?.open) return null;
    return node.entries.map((entry) => (
      <div key={entry.path}>
        <div
          className="dtree-row"
          data-selected={selected === entry.path ? "yes" : "no"}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          <button
            type="button"
            className="dtree-caret"
            aria-label={nodes[entry.path]?.open ? "收起" : "展开"}
            disabled={!entry.hasChildren}
            onClick={() => void toggle(entry.path)}
          >
            {entry.hasChildren ? (
              nodes[entry.path]?.open ? <CaretDown size={12} /> : <CaretRight size={12} />
            ) : (
              <span className="dtree-caret-blank" />
            )}
          </button>
          <button type="button" className="dtree-name" onClick={() => setSelected(entry.path)}>
            {entry.isRepo ? <GitBranch size={14} aria-hidden="true" /> : <FolderSimple size={14} aria-hidden="true" />}
            {entry.name}
            {entry.isRepo ? <span className="dtree-repo">git 仓库</span> : null}
          </button>
        </div>
        {renderLevel(entry.path, depth + 1)}
      </div>
    ));
  };

  return (
    <div className="dtree">
      {root ? (
        <>
          <p className="dtree-root">
            {root.clamped ? "你的目录" : "根目录"} <code>{root.path}</code>
            {root.clamped ? "。只能在它里面建项目。" : null}
          </p>
          <div className="dtree-body">
            <div
              className="dtree-row"
              data-selected={selected === root.path ? "yes" : "no"}
              style={{ paddingLeft: "8px" }}
            >
              <span className="dtree-caret-blank" />
              <button type="button" className="dtree-name" onClick={() => setSelected(root.path)}>
                <FolderSimple size={14} aria-hidden="true" />
                {root.name}
              </button>
            </div>
            {renderLevel(root.path, 1)}
          </div>
          <div className="dtree-mkdir">
            <TextInput
              value={newName}
              placeholder="在选中目录里新建一个文件夹…"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void makeDir();
                }
              }}
            />
            <Button disabled={busy || !newName.trim()} onClick={() => void makeDir()}>
              新建
            </Button>
          </div>
          <div className="dtree-foot">
            <code className="dtree-selected">{selected || "还没选"}</code>
            <div className="dtree-actions">
              <Button variant="ghost" onClick={onClose}>取消</Button>
              <Button variant="primary" disabled={!selected} onClick={() => onPick(selected)}>
                用这个目录
              </Button>
            </div>
          </div>
        </>
      ) : (
        <p className="dtree-root">正在读取…</p>
      )}
    </div>
  );
}
