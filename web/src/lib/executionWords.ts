// 执行过程那一串怎么说成人话:每一行(describeEvent)、在跑时折叠条上那一句(liveLabel)、
// 做完以后的过去式摘要(pastSummary)。工具那一部分的翻译在 toolPhrase.ts。
//
// 摘要的说法照样机(docs/ui-ux-audit/demo/live-words.js 的 summarize):「读了 3 个文件，搜了 1 次，
// 改了 2 个文件，另有 1 步」。读、改按文件去重;只说前三类,其余并成「另有 N 步」;相邻两类
// 都是「文件」时后一类省掉名词。只有一步时直接说那一步:「读了 ReplyBox.tsx」。
import { isVisibleExecutionEvent, type ExecutionEvent } from "./executionTrace.ts";
import { describeTool, joinVerb, type StepKind, type StepPhrase } from "./toolPhrase.ts";

export type StepView = StepPhrase & { tone: "tool" | "thinking" | "error" | "notice" };

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function plain(tone: StepView["tone"], verb: string, text: string): StepView {
  const line = collapse(text);
  const object = clip(line, 220);
  return {
    tone, kind: "other", verb, now: verb, past: verb, object, short: clip(line, 48), mono: false,
    files: [], failed: tone === "error",
    // 一行装得下就不必再点开;装不下的,点开是原文。
    fields: [],
    raw: text.trim() && object !== text.trim() ? text.trim() : undefined,
  };
}

/** 执行过程里一行的全部说法。 */
export function describeEvent(event: ExecutionEvent): StepView {
  if (event.kind === "tool") return { ...describeTool(event), tone: "tool" };
  if (event.kind === "thinking") return plain("thinking", "思考", event.detail ?? "");
  // 提示的正文在 detail 里(label 恒为「提示」,见 conversationSegments 的 auxEvent)。
  if (event.kind === "notice") return plain("notice", event.label || "提示", event.detail ?? "");
  // 异常的话在 label 里;有 detail 的(少见)点开看。
  const view = plain("error", "异常", event.label);
  return event.detail?.trim() ? { ...view, raw: event.detail.trim() } : view;
}

/** 这一行能不能点开:有字段、或者有一行装不下的原文。 */
export function isFlatStep(view: StepView): boolean {
  return !view.fields.length && !view.raw;
}

/**
 * 在跑时折叠条上那一句:跟着最新的一步走,现在进行时。
 *
 * `awaiting` = 此刻正卡在上游等回话:那句提示(「上游返回 502，正在重试」)就是此刻的状态,
 * 常驻在这一行上。不在等的时候提示不算「正在做的事」—— 上游恢复后正文接着流,而那条提示
 * 仍是列表里最新的一条;照它说就会一直写着正在重试(第 1 轮审查 F2),所以跳过它往前找。
 */
export function liveLabel(events: ExecutionEvent[], awaiting: boolean): string {
  const visible = events.filter(isVisibleExecutionEvent);
  const latest = visible.at(-1);
  if (awaiting && latest?.kind === "notice") return collapse(latest.detail ?? "") || "正在等上游回话";
  const step = [...visible].reverse().find((event) => event.kind !== "notice");
  if (!step) return pastSummary(visible);
  // 跟进行条那一档同一个说法(样机 live-words.js 的 thinkWord):在想 / 想了一会儿。
  if (step.kind === "thinking") return "在想";
  if (step.kind === "error") return `异常：${collapse(step.label)}`;
  const view = describeEvent(step);
  if (view.failed) return `${view.object} 失败了`;
  return joinVerb(view.now, view.short);
}

const ORDER: { kind: StepKind; past: string; unit: string; noun: string; byFile: boolean }[] = [
  { kind: "read", past: "读了", unit: "个", noun: "文件", byFile: true },
  { kind: "search", past: "搜了", unit: "次", noun: "", byFile: false },
  { kind: "edit", past: "改了", unit: "个", noun: "文件", byFile: true },
  { kind: "run", past: "跑了", unit: "条", noun: "命令", byFile: false },
  { kind: "web", past: "看了", unit: "个", noun: "网页", byFile: false },
  { kind: "dispatch", past: "派了", unit: "个", noun: "子智能体", byFile: false },
];

/** 做完以后的那一句。一步都没有(只有思考)时说「想了一会儿」;什么都没有时退回「执行过程」。 */
export function pastSummary(events: ExecutionEvent[]): string {
  const visible = events.filter(isVisibleExecutionEvent);
  const tools = visible.filter((event) => event.kind === "tool").map(describeTool);
  const done = tools.filter((step) => !step.failed);
  const failed = tools.length - done.length;
  const notices = visible.filter((event) => event.kind === "notice").length;
  const errors = visible.filter((event) => event.kind === "error").length;
  const thinking = visible.some((event) => event.kind === "thinking");

  let head: string[] = [];
  if (done.length === 1) {
    const [step] = done as [StepPhrase];
    head = [joinVerb(step.past, step.short)];
  } else if (done.length) {
    const parts = ORDER.map((group) => {
      // 写新文件和改旧文件在摘要里是一回事:「改了 2 个文件」。
      const mine = done.filter((step) => step.kind === group.kind || (group.kind === "edit" && step.kind === "write"));
      const n = group.byFile ? new Set(mine.flatMap((step) => step.files.length ? step.files : [step.object])).size : mine.length;
      return { ...group, n };
    }).filter((group) => group.n);
    const said = parts.slice(0, 3);
    const counted = said.reduce((sum, group) => sum + done.filter((step) =>
      step.kind === group.kind || (group.kind === "edit" && step.kind === "write")).length, 0);
    head = said.map((group, index) =>
      `${group.past} ${group.n} ${group.unit}${index && said[index - 1]!.noun === group.noun ? "" : group.noun}`);
    const rest = done.length - counted;
    if (rest) head.push(said.length ? `另有 ${rest} 步` : `做了 ${rest} 步`);
  } else if (thinking && !failed && !notices && !errors) {
    return "想了一会儿";
  }
  const tail = [
    failed ? `${failed} 步失败` : "",
    notices ? `${notices} 条提示` : "",
    errors ? `${errors} 处异常` : "",
  ].filter(Boolean);
  return [...head, ...tail].join("，") || "执行过程";
}
