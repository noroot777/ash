import { useEffect, useRef } from "react";
import type { TaskListItem } from "@ash/shared";
import {
  activateInspectorShortcut,
  createInspectorShortcutSequence,
  hasInspectorShortcutTarget,
} from "../inspector/shortcuts.ts";
import { createKeyChordSequence } from "../lib/keyChord.ts";
import { hasOpenLayer } from "../lib/useDismissable.ts";
import { GO_CHORD_KEYS, GO_CHORD_PREFIX, isGoChordKey } from "./goChord.ts";

// enabled 只关**列表导航那几颗单键**（j/k/f/c/r 和铺开态的 Esc/Enter）：它们要么改选中行、
// 要么按在主工作区的按钮上，换了界面就没有落点。`G …` 一族相反 —— 它的整个存在理由就是
// 「在任何界面上都按得到」（见 goChord.ts），所以它排在 enabled 之前，聊天 / 助手 / 设置页
// 照样认。护栏仍然有：在输入框里打字、命令面板开着、模态层盖着、带修饰键，一律不算数。
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
  onOpenSettings: () => void;
};

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function hasBlockingLayer(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]') !== null;
}

function previewOwnsNavigation(target: EventTarget | null): boolean {
  // Expanded preview covers the workspace even with focus on its opener. Compact preview
  // owns only its own events; its controls handle keys after this window capture listener.
  return document.querySelector(".preview-workspace.is-expanded") !== null
    || (target instanceof Element && target.closest(".preview-workspace") !== null);
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
  onOpenSettings,
}: ShortcutOptions): void {
  const inspectorSequence = useRef(createInspectorShortcutSequence());
  const goSequence = useRef(createKeyChordSequence(GO_CHORD_PREFIX, isGoChordKey));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandPalette = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (commandPalette) {
        inspectorSequence.current.reset();
        goSequence.current.reset();
        // The palette is global; enabled only gates the workspace navigation keys below.
        if (!paletteOpen && hasBlockingLayer()) return;
        event.preventDefault();
        onTogglePalette();
        return;
      }
      if (paletteOpen || isTextEntry(event.target) || hasBlockingLayer() || previewOwnsNavigation(event.target)) {
        inspectorSequence.current.reset();
        goSequence.current.reset();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        inspectorSequence.current.reset();
        goSequence.current.reset();
        return;
      }

      // Inspector 的 `I …` 先跑：g 是它的第二键（`I G` 是 Git 那一档），任务模式的和弦要是
      // 抢在前面把 g 吞了，那一档就再也开不出来。反过来让它先跑不吃亏 —— Inspector 手上
      // 没有半截序列时，handle 会把 g 原样让下去。
      if (enabled && hasInspectorShortcutTarget() && !event.repeat) {
        const inspectorShortcut = inspectorSequence.current.handle(event.key);
        if (inspectorShortcut.kind === "prefix") {
          goSequence.current.reset();
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (inspectorShortcut.kind === "chord") {
          goSequence.current.reset();
          event.preventDefault();
          event.stopImmediatePropagation();
          activateInspectorShortcut(inspectorShortcut.key);
          return;
        }
      } else if (!enabled || !hasInspectorShortcutTarget()) {
        inspectorSequence.current.reset();
      }

      // `G …` 那一族（G T 切任务模式、G S 进项目设置）。两条序列互相清对方的半截状态：
      // 不清的话 `g i f t` 会被串成一次切换 —— 中间整条 Inspector 序列本该把那个 g 作废掉。
      if (!event.repeat) {
        const goChord = goSequence.current.handle(event.key);
        if (goChord.kind === "prefix") {
          inspectorSequence.current.reset();
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (goChord.kind === "chord") {
          inspectorSequence.current.reset();
          event.preventDefault();
          event.stopImmediatePropagation();
          if (goChord.key === GO_CHORD_KEYS.taskMode) onToggleTaskMode();
          else if (goChord.key === GO_CHORD_KEYS.settings) onOpenSettings();
          return;
        }
      }

      // 到这儿为止都是全局键。下面几颗单键只在主工作区认 —— 聊天 / 助手 / 设置页里
      // 它们没有落点（既没有那份列表，也没有主区那颗运行按钮）。
      if (!enabled) return;

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
  }, [composerOpen, enabled, onCloseSpread, onCreate, onOpenSettings, onTask, onToggleSpread, onToggleTaskMode, onTogglePalette, orderedTasks, paletteOpen, selectedTaskId, spreadOpen]);

  useEffect(() => {
    if (!selectedTaskId) return;
    document.querySelector(`[data-task-id="${CSS.escape(selectedTaskId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedTaskId]);
}
