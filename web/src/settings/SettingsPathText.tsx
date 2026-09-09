import { Fragment } from "react";
import { SECTION_ANCHORS, settingsSectionByLabel, type SettingsSection } from "./sections.ts";

/**
 * 把文案里的「设置 → 项目设置 → 预览 → 自定义脚本」变成一颗能点的链接。
 *
 * 这些话多半出现在**用户此刻做不下去**的时候（预览起不来、接力配不上），而它们给出的
 * 去处是一条要用户自己在设置页里走一遍的路径 —— 读完还得记住四段名字、退出任务、翻侧栏、
 * 找到那一节、再滚到那张卡。路已经写清楚了，就没有理由不让它自己走过去。
 *
 * 认路只认**导航上写着的名字**（sections.ts 的对照表），认不出来就原样当普通文字留着 ——
 * 后端文案改词、或者指向一节还不存在的设置时，宁可退回一句话，也不给一颗点了去错地方的链接。
 * 文字本身一个字不改（连「」都留在链接里），这样这段话仍然是可读、可复制的原话。
 */
export function SettingsPathText({ text, onOpen }: {
  text: string;
  onOpen: (section: SettingsSection, anchor: string | null) => void;
}) {
  return <>{splitSettingsPaths(text).map((part, index) => part.target
    ? <button
      key={index}
      type="button"
      className="settings-path-link"
      onClick={() => onOpen(part.target!.section, part.target!.anchor)}
    >{part.text}</button>
    : <Fragment key={index}>{part.text}</Fragment>)}</>;
}

/** 「设置 → …」那一整段（含书名号）。文案里就是这么写的，认这一种形状。 */
const SETTINGS_PATH = /「设置\s*→[^」]*」/g;

export interface SettingsPathTarget {
  section: SettingsSection;
  /** 这一节里还要停在哪张卡上；没登记的第三段就只开到这一节为止。 */
  anchor: string | null;
}

interface TextPart {
  text: string;
  target: SettingsPathTarget | null;
}

/** 把一段话切成「普通文字」和「认得出去处的路径」两种块。 */
export function splitSettingsPaths(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(SETTINGS_PATH)) {
    const start = match.index ?? 0;
    const target = parseSettingsPath(match[0]);
    if (!target) continue; // 认不出去处：留在普通文字里，连同下一段一起收。
    if (start > cursor) parts.push({ text: text.slice(cursor, start), target: null });
    parts.push({ text: match[0], target });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), target: null });
  return parts;
}

/** 「设置 → 项目设置 → 预览 → 自定义脚本」→ 哪一节、停在哪张卡。认不出来给 null。 */
export function parseSettingsPath(path: string): SettingsPathTarget | null {
  const hops = path.replace(/^「|」$/g, "").split("→").map((hop) => hop.trim());
  if (hops.shift() !== "设置") return null;
  const section = settingsSectionByLabel(hops.shift() ?? "");
  if (!section) return null;
  return { section, anchor: SECTION_ANCHORS[section]?.[hops.shift() ?? ""] ?? null };
}
