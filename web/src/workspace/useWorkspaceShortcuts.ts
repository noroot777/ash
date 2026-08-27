import { useEffect, useRef } from "react";
import type { TaskListItem } from "@ash/shared";
import {
  activateInspectorShortcut,
  createInspectorShortcutSequence,
  hasInspectorShortcutTarget,
} from "../inspector/shortcuts.ts";
import { createKeyChordSequence } from "../lib/keyChord.ts";
import { hasOpenLayer } from "../lib/useDismissable.ts";
import { TASK_MODE_CHORD_KEY, isTaskModeChordKey } from "./taskScope.ts";

type ShortcutOptions = {
  enabled: boolean;
  paletteOpen: boolean;
  composerOpen: boolean;
  spreadOpen: boolean;
  orderedTasks: TaskListItem[];
  selectedTaskId: string | null;
  onTogglePalette: () => void;
  onCreate: () => void;
  onTask: (task: TaskListItem) => void;
  onToggleSpread: () => void;
  onCloseSpread: () => void;
  onToggleTaskMode: () => void;
};

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function hasBlockingLayer(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]') !== null;
}

// 竖排 tablist（Inspector 的图标条）里，上下键是它自己的漫游键。这个监听挂在 window 的
// **捕获**阶段，控件自己的 preventDefault 来不及拦，得在这里先让开。让开的只有方向键：
// j/k 是全应用的任务导航，焦点在哪儿都照旧。
function ownsArrowKeys(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.closest('[role="tablist"][aria-orientation="vertical"]') !== null;
}

function clickVisibleRunAction(): void {
  // The page owns eligibility and busy state; R only activates its opted-in button.
  const action = document.querySelector<HTMLButtonElement>("button[data-workspace-run-action]:not(:disabled)");
  action?.click();
}

export function workspaceModifierLabel(): "Cmd" | "Ctrl" {
  return /Mac|iPhone|iPad|iPod/.test(window.navigator.platform) ? "Cmd" : "Ctrl";
}

export function useWorkspaceShortcuts({
  enabled,
  paletteOpen,
  composerOpen,
  spreadOpen,
  orderedTasks,
  selectedTaskId,
  onTogglePalette,
  onCreate,
  onTask,
  onToggleSpread,
  onCloseSpread,
  onToggleTaskMode,
}: ShortcutOptions): void {
  const inspectorSequence = useRef(createInspectorShortcutSequence());
  const taskModeSequence = useRef(createKeyChordSequence(TASK_MODE_CHORD_KEY, isTaskModeChordKey));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandPalette = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (commandPalette) {
        inspectorSequence.current.reset();
        taskModeSequence.current.reset();
        // The palette is global; enabled only gates the workspace navigation keys below.
        if (!paletteOpen && hasBlockingLayer()) return;
        event.preventDefault();
        onTogglePalette();
        return;
      }
      if (!enabled || paletteOpen || isTextEntry(event.target) || hasBlockingLayer()) {
        inspectorSequence.current.reset();
        taskModeSequence.current.reset();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        inspectorSequence.current.reset();
        taskModeSequence.current.reset();
        return;
      }

      // T T 在「任务模式」和当前项目之间来回切。放在 Inspector 那套之前跑：t 不是它的
      // 前缀也不是它的第二键，抢不走；反过来若让 `I …` 先跑，`t i f t` 这种连打会把两条
      // 序列串在一起 —— 最后那个 t 被算成 TT 的第二下。谁先跑，决定了「按了别的键就作废」
      // 这条对两边同时成立。
      if (!event.repeat) {
        const taskModeChord = taskModeSequence.current.handle(event.key);
        if (taskModeChord.kind === "prefix") {
          inspectorSequence.current.reset();
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (taskModeChord.kind === "chord") {
          inspectorSequence.current.reset();
          event.preventDefault();
          event.stopImmediatePropagation();
          onToggleTaskMode();
          return;
        }
      }

      if (hasInspectorShortcutTarget() && !event.repeat) {
        const inspectorShortcut = inspectorSequence.current.handle(event.key);
        if (inspectorShortcut.kind === "prefix") {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (inspectorShortcut.kind === "chord") {
          event.preventDefault();
          event.stopImmediatePropagation();
          activateInspectorShortcut(inspectorShortcut.key);
          return;
        }
      } else if (!hasInspectorShortcutTarget()) {
        inspectorSequence.current.reset();
      }

      // 大图开着时 hasBlockingLayer() 已经把这里整段挡掉了，所以 Esc 只关大图、
      // 不会顺手把铺开也收了 —— 这条不需要在这里再判一次。
      if (event.key === "Escape" && spreadOpen) {
        // Esc 是「一次退一层」的键：还有浮层开着（悬停弹出的全文卡片、下拉…）就让给它，
        // 由 useDismissable 那摞关掉最上面一层。铺开是最外层，轮到它是最后一下。
        if (hasOpenLayer()) return;
        event.preventDefault();
        onCloseSpread();
        return;
      }
      // 铺开态里 J/K 只挪选中行（详情已经在背后跟着换了），Enter 表示「就它了」：收起铺开露出详情。
      if (event.key === "Enter" && spreadOpen) {
        event.preventDefault();
        onCloseSpread();
        return;
      }
      if (event.key === "f" || event.key === "\\") {
        event.preventDefault();
        onToggleSpread();
        return;
      }

      const index = orderedTasks.findIndex((task) => task.id === selectedTaskId);
      const arrowsTaken = ownsArrowKeys(event.target);
      if (event.key === "j" || (event.key === "ArrowDown" && !arrowsTaken)) {
        event.preventDefault();
        const next = orderedTasks[Math.min(index + 1, orderedTasks.length - 1)];
        if (next) onTask(next);
        return;
      }
      if (event.key === "k" || (event.key === "ArrowUp" && !arrowsTaken)) {
        event.preventDefault();
        const previous = orderedTasks[Math.max(index - 1, 0)];
        if (previous) onTask(previous);
        return;
      }
      if (event.key === "c") {
        event.preventDefault();
        onCreate();
        return;
      }
      if (event.key === "r" && !composerOpen) {
        event.preventDefault();
        clickVisibleRunAction();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [composerOpen, enabled, onCloseSpread, onCreate, onTask, onToggleSpread, onToggleTaskMode, onTogglePalette, orderedTasks, paletteOpen, selectedTaskId, spreadOpen]);

  useEffect(() => {
    if (!selectedTaskId) return;
    document.querySelector(`[data-task-id="${CSS.escape(selectedTaskId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedTaskId]);
}
