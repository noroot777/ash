import { useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowsClockwise, CaretDown } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import type { PullStrategy } from "../lib/api.ts";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import type { ProjectGitHandle } from "./useProjectGit.ts";
import { defaultRemote, fetchBlocker, PULL_OPTIONS, pullBlocker, pushBlocker, pushLabelFor } from "./projectGitModel.ts";

// ⟳ 更新 / ↓ 拉取 / ↑ 推送 这三颗按钮。侧栏胶囊的浮层和命令面板 `/git` 都用这一份——
// 两个入口按同一颗按钮，得是同一段代码，否则迟早一边修了另一边没修。
//
// 按钮的禁用一律用 `aria-disabled` 而不是 `disabled`：Chrome 不给 `disabled` 元素派发
// `mouseenter`，真按 `disabled` 写，「为什么这颗是灰的」那句话就永远没人看得到。

export function ActionButton({
  label,
  blocked,
  busy,
  onClick,
  children,
}: {
  label: string;
  blocked: string | null;
  busy: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const tip = useHoverTip();
  return (
    <>
      <button
        type="button"
        className="project-git-action"
        aria-label={label}
        aria-disabled={!!blocked || busy}
        {...tip.anchorProps}
        onClick={() => { if (!blocked && !busy) onClick(); }}
      >
        {busy ? <ArrowsClockwise size={13} className="is-spinning" /> : children}
      </button>
      <HoverTip at={tip.at}>{blocked ?? label}</HoverTip>
    </>
  );
}

export function ProjectGitActions({
  projectId,
  git,
  onChanged,
}: {
  projectId: string;
  git: ProjectGitHandle;
  /** 操作成功后通知外面：胶囊上的分支名是从 `ProjectHealth` 来的，不刷就停在操作之前。 */
  onChanged: () => void;
}) {
  const { state, busy } = git;
  const [pulling, setPulling] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const pullMenu = useRef<HTMLDivElement>(null);
  const pullButton = useRef<HTMLButtonElement>(null);
  const remoteMenu = useRef<HTMLDivElement>(null);
  const pullTip = useHoverTip();
  useDismissable({ enabled: pulling, containerRef: pullMenu, onClose: () => setPulling(false), restoreFocusRef: pullButton });
  useDismissable({ enabled: publishing, containerRef: remoteMenu, onClose: () => setPublishing(false) });

  const run = async (kind: string, action: () => Promise<Awaited<ReturnType<typeof api.projectGitFetch>>>) => {
    if (await git.run(kind, action)) onChanged();
  };

  const pullStop = pullBlocker(state);
  const pullBusy = busy === "pull";
  const pushStop = pushBlocker(state);
  const pushBusy = busy === "push";

  // 门禁同时落在按钮和提交函数上：菜单是先展开、后点的，展开期间状态可能已经变了（另一次
  // 拉取跑起来、分支切到没有 upstream 的那条）。只锁按钮的话，菜单里那几条就成了绕过口，
  // 服务端会退 409，用户看到的是一次莫名其妙的失败。
  const pull = (strategy: PullStrategy) => {
    setPulling(false);
    if (pullStop || pullBusy) return;
    void run("pull", () => api.projectGitPull(projectId, strategy));
  };
  const push = (remote: string | null) => {
    setPublishing(false);
    if (pushStop || pushBusy) return;
    void run("push", () => api.projectGitPush(projectId, remote));
  };

  // 还没 upstream 又配了多个远端时，「发布到哪儿」得让用户自己挑，不能替他猜。
  const needsRemotePick = !!state && !state.branch.upstream && state.remotes.length > 1;

  return (
    <div className="project-git-panel__tools">
      <ActionButton
        label="更新远端信息（fetch --prune）"
        blocked={fetchBlocker(state)}
        busy={busy === "fetch"}
        onClick={() => void run("fetch", () => api.projectGitFetch(projectId, null))}
      >
        <ArrowsClockwise size={13} />
      </ActionButton>

      <div className="project-git-pull" ref={pullMenu}>
        <ActionButton
          label="快进拉取（--ff-only）"
          blocked={pullStop}
          busy={pullBusy}
          onClick={() => pull("ff-only")}
        >
          <ArrowDown size={13} weight="bold" />
        </ActionButton>
        <button
          ref={pullButton}
          type="button"
          className="project-git-pull__more"
          aria-label="选择拉取方式"
          aria-expanded={pulling}
          aria-disabled={!!pullStop || pullBusy}
          {...pullTip.anchorProps}
          onClick={() => { if (!pullStop && !pullBusy) setPulling((open) => !open); }}
        >
          <CaretDown size={9} weight="bold" aria-hidden="true" />
        </button>
        <HoverTip at={pullTip.at}>{pullStop ?? "选择拉取方式"}</HoverTip>
        {pulling && (
          <div className="project-git-menu" role="menu" aria-label="拉取方式">
            {PULL_OPTIONS.map((option) => (
              <button key={option.strategy} type="button" role="menuitem" onClick={() => pull(option.strategy)}>
                <b>{option.label}</b>
                <small>{option.hint}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="project-git-publish" ref={remoteMenu}>
        <ActionButton
          label={pushStop ?? pushLabelFor(state)}
          blocked={pushStop}
          busy={pushBusy}
          onClick={() => {
            if (needsRemotePick) { setPublishing((open) => !open); return; }
            push(state?.branch.upstream ? null : defaultRemote(state));
          }}
        >
          <ArrowUp size={13} weight="bold" />
        </ActionButton>
        {publishing && (
          <div className="project-git-menu" role="menu" aria-label="选择要发布到的远端">
            <p>发布这条分支到</p>
            {(state?.remotes ?? []).map((remote) => (
              <button key={remote} type="button" role="menuitem" onClick={() => push(remote)}>
                <b>{remote}</b>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
