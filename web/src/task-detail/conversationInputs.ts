import { isUserFollowUp } from "@ash/shared";
import { annotationBatchDisplayText } from "@ash/shared/page-annotation-display";
import { attachmentView, parseAttachmentText } from "./utils.ts";

/**
 * 会话左侧那条输入导航上的一格：**我说过的话**——原始需求打头，后面是每一次追问。
 *
 * 判据跟信息面板的「后续追问」、侧边栏铺开那一列是同一份（shared 的 isUserFollowUp）：
 * 哨兵投喂、审查打回、验收冲突、答复提问这些系统代写的输入一律不进来，
 * 导航条上的每一格都是我自己打的字。
 */
export type ConversationInput = {
  /** 原始需求是 REQUIREMENT_INPUT_ID；追问是它那颗气泡的条目 id（气泡上的 CONVERSATION_INPUT_ATTRIBUTE）。 */
  id: string;
  /** 给人读的正文：附件清单已经剥掉，标注批次换成了展示文本。 */
  text: string;
  attachments: string[];
  at?: string;
};

/**
 * 原始需求在会话流里没有气泡（首条会话直接从 agent 的回复开始），它的位置就是会话顶端。
 */
export const REQUIREMENT_INPUT_ID = "requirement";

/** 用户气泡上挂这个属性、值是条目 id：导航条按它找到那颗气泡，滚过去。 */
const CONVERSATION_INPUT_ATTRIBUTE = "data-conversation-input";

/** 摊到用户气泡（画出那块底色的元素，跳过去时闪的就是它）上：`<div {...conversationInputAnchor(id)}>`。 */
export function conversationInputAnchor(id: string): { [CONVERSATION_INPUT_ATTRIBUTE]: string } {
  return { [CONVERSATION_INPUT_ATTRIBUTE]: id };
}

type InputSource = {
  kind: string;
  id: string;
  text?: string | null;
  attachments?: readonly string[];
  at?: string | null;
  bySystem?: boolean;
};

function displayed(raw: string, extra: readonly string[] = []): { text: string; attachments: string[] } {
  const parsed = parseAttachmentText(raw);
  return {
    text: (annotationBatchDisplayText(parsed.body) ?? parsed.body).trim(),
    attachments: [...parsed.paths, ...extra],
  };
}

export function conversationInputs(
  requirement: { text: string; at?: string | null } | null | undefined,
  items: readonly InputSource[],
): ConversationInput[] {
  const inputs: ConversationInput[] = [];
  if (requirement) {
    const shown = displayed(requirement.text);
    if (shown.text || shown.attachments.length) {
      inputs.push({ id: REQUIREMENT_INPUT_ID, ...shown, ...(requirement.at ? { at: requirement.at } : {}) });
    }
  }
  for (const item of items) {
    if (!isUserFollowUp({ kind: item.kind, text: item.text, bySystem: item.bySystem })) continue;
    const shown = displayed(item.text ?? "", item.attachments ?? []);
    inputs.push({ id: item.id, ...shown, ...(item.at ? { at: item.at } : {}) });
  }
  return inputs;
}

/** 一句话认出这条输入：正文第一行；只发了附件的，报附件名。 */
export function conversationInputHeadline(input: ConversationInput): string {
  const line = input.text.split("\n").find((candidate) => candidate.trim())?.trim();
  if (line) return line;
  return input.attachments.map((path) => attachmentView(path).name).join("、");
}

/**
 * 第一行（headline）之后的正文，Q 摊开的列表里接在 headline 下面整段给出：开头一样的两次追问
 * 靠它分得开，长输入也读得到结尾。只有一行的是空串；中间的空行、缩进原样留着。
 */
export function conversationInputRest(input: ConversationInput): string {
  const lines = input.text.split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return "";
  return lines.slice(first + 1).join("\n").replace(/^\s*\n/, "").trimEnd();
}

/** 气泡选择器：值里有冒号这类字符（条目 id 是 `persisted:user:…`），必须转义。 */
export function conversationInputSelector(id: string): string {
  return `[${CONVERSATION_INPUT_ATTRIBUTE}="${CSS.escape(id)}"]`;
}
