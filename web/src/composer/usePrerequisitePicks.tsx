// 新建面板「创建并等前置」的「建在谁上面」：已选的前置（存在草稿里，见 lib/DraftStore.tsx `prerequisites`）、
// 候选、和它们连带决定的合入分支。从 TaskComposerPanel 抽出来（单文件 700 行上限），面板只拿 slot 摆进启动设置浮层。
//
// 候选和「能不能选、为什么」全听服务端（lib/prerequisiteOptions.ts 文件头）。已选的每一次变动都重问一遍：选了第一条，
// 合入分支就跟着它走，合入别的分支的那些随即置灰；工作目录改了（不用 worktree 拿不到分支上的代码）也一样。
// 已选里有一条此刻不成立的，不悄悄去掉，标出原因、发送键说得出差什么，由用户自己去掉；只有从草稿恢复回来的那一刻，
// 自己就失效的直接去掉（那是上一次留下的，用户此刻还没看过它们）。只是跟别的已选项合入分支对不上的（`conflict`）
// 不去：两条都还能用，留哪条由用户定。恢复时判据用的工作目录选择跟已选的前置存在同一份草稿里（lib/DraftStore.tsx）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { Group } from "@navi/shared";
import type { PrerequisiteCandidate, PrerequisiteCandidates } from "@navi/shared/prerequisites";
import { prerequisiteNeedsUser } from "@navi/shared/prerequisites";
import { X } from "@phosphor-icons/react";
import { Dropdown } from "../components/Dropdown.tsx";
import { api } from "../lib/api.ts";
import type { DraftHandle } from "../lib/DraftStore.tsx";
import { candidateStepText, prerequisiteOptions } from "../lib/prerequisiteOptions.ts";
import "./composer-prerequisites.css";

type Loaded = { key: string; projectId: string; result: PrerequisiteCandidates };

export function usePrerequisitePicks({ draft, projectId, useWorktree, groups, enabled, notify }: {
  draft: Pick<DraftHandle, "prerequisites" | "setPrerequisites">;
  projectId: string;
  /** 这条新任务实际用不用独立工作区（非 git 项目恒为 false）。 */
  useWorktree: boolean;
  groups: Group[];
  /** 启动方式此刻就是「创建并等前置」。 */
  enabled: boolean;
  notify: (message: string) => void;
}) {
  const picks = draft.prerequisites?.ids ?? [];
  const setPicks = (ids: string[]) => draft.setPrerequisites((current) => current && { ...current, ids });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);
  // 从草稿恢复回来的那一份只核一次（每个项目一次）：之后再变成不成立的，标出来让用户自己去掉。
  const restored = useRef<string | null>(null);
  const key = `${projectId}|${useWorktree ? 1 : 0}|${picks.join(",")}`;

  const load = useCallback(() => {
    if (!enabled) return;
    const seq = ++latest.current;
    setFailed(false);
    api.prerequisiteCandidates(projectId, { useWorktree, selected: picks }).then((result) => {
      if (seq === latest.current) setLoaded({ key, projectId, result });
    }).catch(() => {
      if (seq === latest.current) setFailed(true);
    });
    // picks 已经收在 key 里。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  useEffect(load, [load]);

  const current = loaded?.projectId === projectId ? loaded.result : null;
  const fresh = loaded?.key === key;
  const byId = new Map((current?.candidates ?? []).map((item) => [item.taskId, item] as const));

  useEffect(() => {
    if (!current || !fresh || restored.current === projectId) return;
    restored.current = projectId;
    const dropped = picks.filter((id) => {
      const item = byId.get(id);
      return !item || (!!item.problem && !item.conflict);
    });
    if (!dropped.length) return;
    setPicks(picks.filter((id) => !dropped.includes(id)));
    const names = dropped.map((id) => byId.get(id)?.title).filter(Boolean).map((title) => `「${title}」`).join("");
    notify(names ? `草稿里的前置${names}已经不能选了，已去掉` : "草稿里有前置已经不在了，已去掉");
    // 只在拿到这一份候选的那一刻核一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, fresh, projectId]);

  const picked = picks.map((id) => byId.get(id) ?? null);
  const invalid = picked.find((item): item is PrerequisiteCandidate => !!item?.problem);
  const blockReason = !enabled ? null
    : !picks.length ? "选择要建在哪几条任务上面"
      : failed && !fresh ? "前置读取失败，展开「建在谁上面」重试"
        : !fresh ? "正在核对前置…"
          : invalid ? `「${invalid.title}」${invalid.problem}，去掉它才能创建`
            : picked.includes(null) ? "有一条前置已经不在了，去掉它才能创建" : null;

  const add = (taskId: string) => {
    if (taskId && !picks.includes(taskId)) setPicks([...picks, taskId]);
  };
  const remove = (taskId: string) => setPicks(picks.filter((id) => id !== taskId));

  const slot = (
    <div className="composer-field composer-prerequisites">
      <span>建在谁上面</span>
      {picks.length > 0 && <ul className="composer-prereq-list" aria-label="已选的前置">
        {picks.map((id, index) => {
          const item = picked[index];
          const title = item?.title ?? "已不在的任务";
          const note = item ? item.problem ?? candidateStepText(item) : "已不在";
          const attn = !item || !!item.problem || (!!item.step && prerequisiteNeedsUser(item.step));
          return (
            <li key={id}>
              <span className="insp-cut">{title}</span>
              <em className={attn ? "is-attn" : undefined}>{note}</em>
              <button type="button" aria-label={`去掉前置：${title}`} onClick={() => remove(id)}><X size={12} /></button>
            </li>
          );
        })}
      </ul>}
      <Dropdown label="建在某任务上面" value="" placeholder={picks.length ? "再加一条…" : "选择一个任务…"}
        filterPlaceholder="筛选任务…" keepOpenOnSelect status={failed && !current ? "failed" : current ? "ready" : "loading"}
        options={prerequisiteOptions(current?.candidates ?? [], groups, picks)} onOpen={load} onChange={add} />
    </div>
  );

  return {
    picks,
    slot,
    /** 正在核对已选的前置（候选还没回来）：发送键先挡着，但这不是「没配好」。 */
    checking: enabled && picks.length > 0 && !fresh && !failed,
    blockReason,
    /** 建任务时照写的合入分支（跟着已选的前置走）；null = 不限制，照常按项目分支定。 */
    mergeTargetBranch: fresh ? current?.mergeTargetBranch ?? null : null,
    /** 已选里此刻还没站稳的那几条的名字（建好之后提示「等谁」）。 */
    waitingTitles: () => picked.flatMap((item) => item && item.step !== "settled" ? [item.title] : []),
  };
}
