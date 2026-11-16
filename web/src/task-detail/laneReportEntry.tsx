import type { LeftDrawerEntry } from "../components/LeftDrawer.tsx";
import { ReviewReportFileView } from "../components/MarkdownBody.tsx";
import { freeReportEntry } from "../free-workflow/FreeReviewRoundBody.tsx";
import type { ConversationReviewLane } from "./conversationReviewLanes.ts";
import { laneReportUrl } from "./reviewLaneLinks.ts";

/**
 * 会话里一轮审查的报告全文在左侧抽屉里的那一屉：自由派审照审查格同一份（跟着长、带截图），就地验证
 * 手上只有报告文件的地址，照文件本身读。
 */
export function laneReportEntry(taskId: string, report: NonNullable<ConversationReviewLane["report"]>): LeftDrawerEntry {
  if (report.kind === "free") return freeReportEntry(taskId, report.runId, report.round, null);
  const title = `第 ${report.round} 轮验证`;
  return {
    key: `lane-report:${taskId}:inline:${report.round}`,
    kind: "审查报告",
    title,
    ariaLabel: `审查报告：${title}`,
    closeLabel: "关闭审查报告",
    body: <ReviewReportFileView target={{ name: "report.md", url: laneReportUrl(taskId, report) }} />,
  };
}
