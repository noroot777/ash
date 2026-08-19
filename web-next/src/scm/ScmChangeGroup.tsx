import { ArrowCounterClockwise, Minus, Plus, Trash } from "@phosphor-icons/react";
import type { ScmChange, ScmGroupId } from "../lib/api.ts";
import { CONFLICT_LABEL, KIND_BADGE, KIND_LABEL, dirName, fileName } from "./scmModel.ts";

// 一个改动分组（冲突 / 已暂存 / 更改 / 未跟踪）。条目本身是按钮——点它开 diff，跟
// 文件树点文件开查看器是同一套手势；逐条的操作按钮浮在右侧，不抢主点击区。

export interface ScmGroupActions {
  onOpen: (change: ScmChange) => void;
  onStage?: (paths: string[]) => void;
  onUnstage?: (paths: string[]) => void;
  onDiscard?: (changes: ScmChange[]) => void;
}

function RowActions({
  change,
  group,
  actions,
}: {
  change: ScmChange;
  group: ScmGroupId;
  actions: ScmGroupActions;
}) {
  const name = fileName(change.path);
  return (
    <span className="scm-row__actions">
      {actions.onDiscard && (
        <button
          type="button"
          aria-label={group === "untracked" ? `删除 ${name}` : `丢弃 ${name} 的改动`}
          onClick={() => actions.onDiscard?.([change])}
        >
          {group === "untracked" ? <Trash size={13} /> : <ArrowCounterClockwise size={13} />}
        </button>
      )}
      {actions.onUnstage && (
        <button
          type="button"
          aria-label={`取消暂存 ${name}`}
          onClick={() => actions.onUnstage?.([change.path])}
        >
          <Minus size={13} />
        </button>
      )}
      {actions.onStage && (
        <button
          type="button"
          aria-label={group === "merge" ? `把 ${name} 标记为已解决并暂存` : `暂存 ${name}`}
          onClick={() => actions.onStage?.([change.path])}
        >
          <Plus size={13} />
        </button>
      )}
    </span>
  );
}

export function ScmChangeGroup({
  group,
  title,
  changes,
  activePath,
  activeGroup,
  actions,
  hint,
}: {
  group: ScmGroupId;
  title: string;
  changes: ScmChange[];
  activePath: string | null;
  activeGroup: ScmGroupId | null;
  actions: ScmGroupActions;
  hint?: string;
}) {
  if (!changes.length) return null;
  return (
    <section className={`scm-group is-${group}`}>
      <header>
        <b>{title}</b>
        <span className="scm-group__count">{changes.length}</span>
        <span className="scm-group__bulk">
          {actions.onDiscard && (
            <button
              type="button"
              aria-label={`${title}：全部${group === "untracked" ? "删除" : "丢弃"}`}
              onClick={() => actions.onDiscard?.(changes)}
            >
              {group === "untracked" ? <Trash size={13} /> : <ArrowCounterClockwise size={13} />}
            </button>
          )}
          {actions.onUnstage && (
            <button
              type="button"
              aria-label={`${title}：全部取消暂存`}
              onClick={() => actions.onUnstage?.(changes.map((change) => change.path))}
            >
              <Minus size={13} />
            </button>
          )}
          {actions.onStage && (
            <button
              type="button"
              aria-label={`${title}：全部暂存`}
              onClick={() => actions.onStage?.(changes.map((change) => change.path))}
            >
              <Plus size={13} />
            </button>
          )}
        </span>
      </header>
      {hint && <p className="scm-group__hint">{hint}</p>}
      <ul>
        {changes.map((change, index) => {
          const dir = dirName(change.path);
          const active = activeGroup === group && activePath === change.path;
          return (
            <li key={`${change.path}-${index}`}>
              {/* 操作按钮是主按钮的**兄弟**而不是子元素：按钮套按钮是非法 HTML，
                  浏览器会把里层拎出去，点「丢弃」就变成点了整行。 */}
              <div className={`scm-row${active ? " is-active" : ""}`}>
                <button
                  type="button"
                  className="scm-row__open"
                  onClick={() => actions.onOpen(change)}
                >
                  <span className="scm-row__name">
                    {fileName(change.path)}
                    {change.origPath && <i className="scm-row__from">← {change.origPath}</i>}
                  </span>
                  {dir && <span className="scm-row__dir">{dir}</span>}
                  <span className="scm-row__meta">
                    {change.conflict && (
                      <em className="scm-row__conflict">{CONFLICT_LABEL[change.conflict] ?? "冲突"}</em>
                    )}
                    <span className={`scm-row__badge is-${change.kind}`} aria-label={KIND_LABEL[change.kind]}>
                      {KIND_BADGE[change.kind]}
                    </span>
                  </span>
                </button>
                <RowActions change={change} group={group} actions={actions} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
