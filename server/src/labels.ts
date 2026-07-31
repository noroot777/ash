// 少量跨模块共用的展示文案。单独成文件是为了避免 orchestrator 与 single-run
// 各存一份（同一个映射抄两遍，改一处漏一处）。
export const FOLLOW_UP_LABEL: Record<string, string> = { done: "已完成", failed: "失败", canceled: "已取消" };
