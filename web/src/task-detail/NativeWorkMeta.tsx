import { Fragment } from "react";
import type { NativeWorkItem } from "./nativeWorkModel.ts";
import { useNativeWorkTiming } from "./nativeWorkTiming.ts";

/**
 * 「模型」与「智能水平」是一对:实跑值优先,没上报就退到调用方点的名,两样都没有才叫未记录。
 * 内部字段是 model/effort,用户可见文案里第二项一律叫智能水平（见 web/CLAUDE.md）。
 */
const FIELDS = [
  { label: "模型", reported: "model", requested: "requestedModel" },
  { label: "智能水平", reported: "effort", requested: "requestedEffort" },
] as const;

export function fieldValues(row: NativeWorkItem) {
  if (row.kind !== "agent") return [];
  return FIELDS.map(({ label, reported, requested }) => {
    const asked = row[requested] !== "inherit" ? row[requested] : undefined;
    return { label, value: row[reported] || asked || "未记录", requestedOnly: !row[reported] && !!asked, unknown: !row[reported] && !asked };
  });
}

/**
 * 执行详情抬头里、标题底下那一条：来源会话 · 模型 · 智能水平 · 时间 · 跨度。
 * 这些原先是正文顶上一块要点开的「模型与时间」两列表格；抬头右半边一直空着，
 * 于是顺着副标题横向摊开——填上那片空白，也不必再把读者的视线掰成表格。
 *
 * 抬头是摘要,所以只摊开**问出来**的那几项;一项都没问出来时留一个「未记录」说明情况,
 * 而不是连着两个「未记录」。
 */
export function NativeWorkHeadline({ row }: { row: NativeWorkItem }) {
  const { range, duration, hasDuration } = useNativeWorkTiming(row);
  const fields = fieldValues(row);
  const known = fields.filter((field) => !field.unknown);
  // 分隔点是真节点而不是 ::before：伪元素不进 innerText，复制出来和读屏念到的会是糊成一团的
  // 「codex@fixturegpt-5.6-sol」。
  const parts = [
    <span key="session">{row.sessionLabel}</span>,
    ...(known.length ? known : fields.slice(0, 1)).map(({ label, value, requestedOnly }) =>
      <span key={label}>{value}{requestedOnly && <small>调用指定</small>}</span>),
    <span key="range" className="native-agent__headline-time">{range}</span>,
    hasDuration ? <span key="duration" className="native-agent__headline-time">{duration}</span> : null,
  ].filter((part) => part !== null);
  return <p className="native-agent__headline">
    {parts.map((part, index) => <Fragment key={part.key}>
      {index > 0 && <span className="native-agent__headline-dot" aria-hidden="true">·</span>}
      {part}
    </Fragment>)}
  </p>;
}
