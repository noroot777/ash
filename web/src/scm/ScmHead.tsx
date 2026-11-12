// 「改动」格最上面那几行：分支和目录压成一行（可复制），只读、有任务在跑这类状态降成一行灰字
// （点了才铺开解释），改到一半停下、列表可能是旧的这两种还没解除的事是提示条。
import { useState, type ReactNode } from "react";
import { CaretRight, GitBranch, WarningCircle } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { ROOT_SOURCE_LABEL } from "../files/fileModel.ts";
import { InspButton, InspCopy, InspNote } from "../inspector/parts.tsx";
import type { ScmPartialNotice } from "./scmModel.ts";

export function ScmPathLine({ branch, rootPath, rootSource, notify }: {
  branch: { head: string | null; detached: boolean; upstream: string | null; ahead: number | null; behind: number | null };
  rootPath: string;
  rootSource: keyof typeof ROOT_SOURCE_LABEL;
  notify: (message: string) => void;
}) {
  const dirTip = useHoverTip();
  const upTip = useHoverTip();
  const name = branch.detached ? "游离 HEAD" : branch.head ?? "（无分支）";
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  return (
    <p className="insp-path scm-branch">
      <GitBranch size={14} aria-hidden="true" />
      <b className="insp-cut scm-branch__name">{name}</b>
      {branch.upstream && (ahead > 0 || behind > 0) && (
        <>
          <span className="insp-num insp-faint" tabIndex={0} aria-label={`相对 ${branch.upstream}：领先 ${ahead}，落后 ${behind}`} {...upTip.anchorProps}>
            {ahead > 0 && `↑${ahead}`}{ahead > 0 && behind > 0 && " "}{behind > 0 && `↓${behind}`}
          </span>
          <HoverTip at={upTip.at}>相对 {branch.upstream}</HoverTip>
        </>
      )}
      {/* 目录可能很长：从左边截，尾巴那一截（哪个 worktree）留着。全路径指上去看。 */}
      <span className="insp-cut insp-path__dir" tabIndex={0} aria-label={`${ROOT_SOURCE_LABEL[rootSource]}：${rootPath}`} {...dirTip.anchorProps}>
        <bdi dir="ltr">{rootPath}</bdi>
      </span>
      <HoverTip at={dirTip.at}>{ROOT_SOURCE_LABEL[rootSource]}：{rootPath}</HoverTip>
      <InspCopy text={`${name}  ${rootPath}`} label="复制分支和目录" onError={notify} />
    </p>
  );
}

/** 一行灰字说「现在是什么状态」，点了才在底下铺开为什么、该怎么办。 */
export function ScmWhy({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="scm-why">
      <button type="button" className="insp-go scm-why__row" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="scm-why__icon" aria-hidden="true">{icon}</span>
        <span className="insp-cut">{label}</span>
        <CaretRight size={12} aria-hidden="true" className="insp-go__chev" />
      </button>
      {open && <InspNote>{children}</InspNote>}
    </div>
  );
}

/**
 * 「上一次操作改到一半停下了」的提示条。
 *
 * 两种情形都会到这里：分批跑的批量操作中途失败（git 给不了跨调用的事务，前面那些已经
 * 真的生效了——丢弃未跟踪文件时它们已经从磁盘上没了），以及提交时预暂存成功但 commit
 * 被拒（文件留在索引里，下一次提交会把它们带上）。这种结果不能只靠一条飘过去的提示
 * 交代：它留在面板上，直到用户自己按「知道了」，或者下一次写操作成功。
 *
 * 主文案直接用后端那句话——发生了什么只有它说得准，前端按动作名硬拼准会拼错。
 *
 * 「下面的列表已经是实际结果」这句要看 `stale`：补刷也失败时列表并不是实际结果，那句话
 * 会把用户按回错误的判断上，此时交给下面的 stale 提示条说实话。
 */
export function ScmPartialBanner({ notice, stale, onDismiss }: { notice: ScmPartialNotice; stale: boolean; onDismiss: () => void }) {
  const sample = notice.done.slice(0, 3).join("、");
  return (
    <div className="scm-banner is-danger">
      <InspNote
        tone="bad"
        icon={<WarningCircle weight="fill" />}
        action={<InspButton size="sm" className="scm-banner__dismiss" onClick={onDismiss}>知道了</InspButton>}
      >
        <p>{notice.message}</p>
        {!stale && <p>下面的列表已经是实际结果。</p>}
        {notice.done.length > 0 && (
          <p className="insp-faint">已生效：{sample}{notice.done.length > 3 ? ` 等 ${notice.done.length} 个` : ""}</p>
        )}
      </InspNote>
    </div>
  );
}
