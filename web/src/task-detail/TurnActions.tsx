import type { ReactNode } from "react";
import type { TokenUsage } from "@ash/shared";
import { hasUsage } from "@ash/shared/usage";
import { ChatsCircle, Check, Copy, GitFork, Trash, X } from "@phosphor-icons/react";
import { IconButton } from "../components/IconButton.tsx";
import { IconMenu, type IconMenuItem } from "../components/IconMenu.tsx";
import { useCopyFeedback } from "../components/CopyButton.tsx";
import { UsageRows } from "../components/TokenUsageChip.tsx";
import { useMessageDelete, type DeletableItem } from "./MessageDelete.tsx";

/**
 * 回合尾那一排：复制、派生、更多（docs/ui-ux-audit feed-2）。平时不画，指到这一回合、
 * 或键盘走进来才出现；触屏上常显（样式在 task-conversation.css 的 `.turn-acts`）。
 *
 * 这一排自己不占高度——往下探进两条消息之间的空里，出不出现会话都不跳。
 * 这一回合烧了多少 token 收在「更多」菜单底下，点开才看；会话累计、会话号、上下文水位
 * 住在右侧「信息」格。`records` 是记在这一回合上的回执（「N 条记录」），有才给。
 */
export function TurnActions({ item, markdown, usage, onFork, onAskSideChat, records }: {
  item: DeletableItem;
  markdown: string;
  /** 这一回合的用量。null = 那家 CLI 不报账，菜单里就不出这一块。 */
  usage?: TokenUsage | null;
  onFork?: () => void;
  /** 「在侧聊里问这一段」：带上这一回合最后一段的第一行去侧聊。 */
  onAskSideChat?: (quote: string) => void;
  records?: ReactNode;
}) {
  const copy = useCopyFeedback();
  const remove = useMessageDelete(item);
  const quote = lastParagraph(markdown);
  const more: IconMenuItem[] = [
    ...(onAskSideChat && quote ? [{ label: "在侧聊里问这一段", icon: <ChatsCircle size={14} aria-hidden="true" />, onPick: () => onAskSideChat(quote) }] : []),
    ...(remove.available ? [{ label: "删除这条回复", icon: <Trash size={14} aria-hidden="true" />, danger: true, onPick: remove.request }] : []),
  ];
  const copyLabel = copy.state === "done" ? "已复制" : copy.state === "failed" ? "复制失败" : "复制这条回复";
  return (
    <footer className={`turn-acts${copy.state !== "idle" ? " is-shown" : ""}`}>
      {markdown.trim() && (
        <IconButton
          size="sm"
          label={copyLabel}
          className={copy.state === "done" ? "is-copied" : copy.state === "failed" ? "is-copy-failed" : undefined}
          onClick={() => copy.copy(markdown)}
        >
          {copy.state === "done" ? <Check size={14} weight="bold" aria-hidden="true" />
            : copy.state === "failed" ? <X size={14} weight="bold" aria-hidden="true" />
              : <Copy size={14} aria-hidden="true" />}
        </IconButton>
      )}
      {onFork && (
        <IconButton size="sm" label="派生新任务" onClick={onFork}>
          <GitFork size={14} aria-hidden="true" />
        </IconButton>
      )}
      <IconMenu items={more} info={hasUsage(usage) ? <TurnUsage usage={usage} /> : undefined} />
      {records}
      {remove.dialog}
    </footer>
  );
}

function TurnUsage({ usage }: { usage: TokenUsage }) {
  return (
    <div className="turn-usage" aria-label="本轮 Token 用量">
      <span>本轮 Token</span>
      <UsageRows turn={usage} session={null} />
    </div>
  );
}

function lastParagraph(markdown: string): string {
  const blocks = markdown.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return (blocks.at(-1) ?? "").split("\n")[0]?.replace(/^[#>*\-\s]+/, "").trim() ?? "";
}
