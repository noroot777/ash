import type { Issue } from "@harness/shared";

// 事项列表(IssuesWorkspace)和事项详情(IssueDetail)共用的几个小件。单独放一个文件,
// 免得两边互相 import 兜圈子。
export const ISSUE_STATUS_META: Record<Issue["status"], { label: string; cls: string }> = {
  open: { label: "待办", cls: "border-line2" },
  in_progress: { label: "进行中", cls: "border-amber-400 bg-[conic-gradient(theme(colors.amber.400)_62%,transparent_0)]" },
  done: { label: "已完成", cls: "border-emerald-500 bg-emerald-500" },
  canceled: { label: "已取消", cls: "border-line2 bg-line2" },
};

// 状态点。`staged` = 还没归到项目(AI 正在识别或识别不出),画成琥珀虚线圈。
export function IssueDot({ status, staged, size = 13 }: { status: Issue["status"]; staged?: boolean; size?: number }) {
  const m = ISSUE_STATUS_META[status];
  return (
    <span
      className={`inline-block shrink-0 rounded-full border-2 ${staged ? "border-dashed border-amber-400" : m.cls}`}
      style={{ width: size, height: size }}
    />
  );
}

// 正文恒为用户原文(逐行记的 1、2、3…)。markdown 会把段内单换行折叠成一行,所以把
// 段内单换行转成硬换行(行尾两空格),空行(段落分隔)保持不变 —— 不引第三方插件。
export const mdBreaks = (s: string) => s.replace(/([^\n])\n(?!\n)/g, "$1  \n");
