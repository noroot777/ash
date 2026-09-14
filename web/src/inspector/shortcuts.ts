import { KEY_CHORD_TIMEOUT_MS, createKeyChordSequence } from "../lib/keyChord.ts";
import type { KeyChordDecision } from "../lib/keyChord.ts";

// 第二键按面板名取首字母：i 信息 / f 文件 / g Git 改动 / s 子智能体 / c 侧聊 / w 工作流 /
// r 审查 / p 预览指正 / e 执行者 / t 时间轴。同一套面板里不许撞键——撞了只有排在前面的
// 那一格开得出来，后面那个的 kbd 提示就是句假话。
export type InspectorShortcutKey = "i" | "f" | "g" | "w" | "r" | "e" | "s" | "c" | "p" | "t";

export const INSPECTOR_SHORTCUT_PREFIX = "i";
export const INSPECTOR_SHORTCUT_TIMEOUT_MS = KEY_CHORD_TIMEOUT_MS;

const SHORTCUT_KEYS = new Set<InspectorShortcutKey>(["i", "f", "g", "w", "r", "e", "s", "c", "p", "t"]);

export function inspectorShortcutLabel(key: InspectorShortcutKey): string {
  return `${INSPECTOR_SHORTCUT_PREFIX.toUpperCase()} ${key.toUpperCase()}`;
}

export function isInspectorShortcutKey(key: string): key is InspectorShortcutKey {
  return SHORTCUT_KEYS.has(key as InspectorShortcutKey);
}

export type InspectorShortcutDecision = KeyChordDecision<InspectorShortcutKey>;

export function createInspectorShortcutSequence(timeoutMs = INSPECTOR_SHORTCUT_TIMEOUT_MS) {
  return createKeyChordSequence(INSPECTOR_SHORTCUT_PREFIX, isInspectorShortcutKey, timeoutMs);
}

type InspectorShortcutTarget = (key: InspectorShortcutKey) => boolean;
const shortcutTargets: InspectorShortcutTarget[] = [];

export function registerInspectorShortcutTarget(target: InspectorShortcutTarget): () => void {
  shortcutTargets.push(target);
  return () => {
    const index = shortcutTargets.lastIndexOf(target);
    if (index >= 0) shortcutTargets.splice(index, 1);
  };
}

export function hasInspectorShortcutTarget(): boolean {
  return shortcutTargets.length > 0;
}

export function activateInspectorShortcut(key: InspectorShortcutKey): boolean {
  return shortcutTargets.at(-1)?.(key) ?? false;
}
