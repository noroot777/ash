import { useState } from "react";
import { Check, Copy, Warning } from "@phosphor-icons/react";
import type { GitJournalEntry } from "@ash/shared/git-workbench";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import type { Workbench } from "./useWorkbench.ts";
import { WorkbenchMenu } from "./WorkbenchMenu.tsx";
import { pullMenuItems } from "./pullMenu.ts";

// 推送失败那一条：一句原因 + 一个对应的动作 + 原始输出收在「查看详情」里，只说这一次
// （useWorkbench 不再为推送失败另弹提示）。它挂在操作日志最新那一条上，所以刷新页面还在；
// 下一次操作落了日志，它就被那一句结果顶掉。

type PushFailureCopy = {
  /** 「推送被拒」是远端说了不，「推送失败」是没走到那一步。 */
  title: "推送被拒" | "推送失败";
  reason: string;
  /** git 的原话。服务端自己写的中文提示已经是人话，不再收进详情。 */
  raw: string | null;
  /** 远端有本地没有的提交：对应的动作是先拉取。 */
  pull: boolean;
};

const gitOutput = /\b(?:error|fatal|hint|remote):|\[(?:remote )?rejected\]|^To |Command failed|\bgit\b/im;

export function describePushFailure(message: string): PushFailureCopy {
  const body = message.replace(/^推送失败：/, "").trim();
  // 服务端把多行的 git 输出压成一行、用全角分号连起来（oneLine）；详情里拆回原来的行。
  const raw = body.replace(/；/g, "\n");
  if (/\[rejected\]|fetch first|non-fast-forward|tip of your current branch is behind/i.test(body))
    return { title: "推送被拒", reason: "远端有你本地没有的提交。", raw, pull: true };
  if (/stale info/i.test(body))
    return { title: "推送被拒", reason: "远端在你确认之后又有了新提交，保护强推没有覆盖它。", raw, pull: false };
  if (/\[remote rejected\]|pre-receive hook declined|protected branch/i.test(body))
    return { title: "推送被拒", reason: "远端拒收了这次推送（分支保护或服务端钩子）。", raw, pull: false };
  if (/Authentication failed|Permission denied|could not read Username|returned error: 40[13]/i.test(body))
    return { title: "推送失败", reason: "远端没有接受这份凭据。", raw, pull: false };
  if (/Could not resolve host|Connection (?:timed out|refused)|Network is unreachable|Operation timed out/i.test(body))
    return { title: "推送失败", reason: "连不上远端。", raw, pull: false };
  if (!gitOutput.test(body) && /[一-鿿]/.test(body))
    return { title: "推送失败", reason: body, raw: null, pull: false };
  return { title: "推送失败", reason: "Git 没有接受这次推送。", raw, pull: false };
}

export function PushFailure({
  entry,
  workbench: w,
  canPull,
  managed,
}: {
  entry: GitJournalEntry;
  workbench: Workbench;
  /** 有上游才拉得了。 */
  canPull: boolean;
  managed: boolean;
}) {
  const copy = describePushFailure(entry.message);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTip = useHoverTip();
  const raw = copy.raw && `${entry.command ? `$ ${entry.command}\n` : ""}${copy.raw}`;
  return (
    <div className="gwb-push-fail" role="alert">
      <Warning size={15} className="gwb-push-fail-icon" aria-hidden="true" />
      <div className="gwb-push-fail-main">
        <p>
          <b>{copy.title}：</b>
          {copy.reason}
        </p>
        {open && raw && (
          <div className="gwb-push-raw">
            <pre tabIndex={0} aria-label="git 的原始输出">{raw}</pre>
            <button
              type="button"
              className="icon-btn"
              aria-label={copied ? "已复制" : "复制"}
              onClick={() => {
                void navigator.clipboard?.writeText(raw).then(
                  () => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1400);
                  },
                  () => {},
                );
              }}
              {...copyTip.anchorProps}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <HoverTip at={copyTip.at}>{copied ? "已复制" : "复制"}</HoverTip>
          </div>
        )}
      </div>
      <div className="gwb-push-fail-acts">
        {copy.pull && canPull && (
          <WorkbenchMenu
            className="ui-btn primary gwb-push-fail-pull"
            label="先拉取"
            disabled={w.blocked}
            items={pullMenuItems(w, managed)}
          >
            先拉取
          </WorkbenchMenu>
        )}
        {raw && (
          <button
            type="button"
            className="gwb-push-fail-more"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "收起" : "查看详情"}
          </button>
        )}
      </div>
    </div>
  );
}
