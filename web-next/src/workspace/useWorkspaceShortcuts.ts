import { useEffect } from "react";
import type { Task } from "@harness/shared";

type ShortcutOptions = {
  enabled: boolean;
  paletteOpen: boolean;
  composerOpen: boolean;
  spreadOpen: boolean;
  orderedTasks: Task[];
  selectedTaskId: string | null;
  onTogglePalette: () => void;
  onCreate: () => void;
  onTask: (task: Task) => void;
  onToggleSpread: () => void;
  onCloseSpread: () => void;
};

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function hasBlockingLayer(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]') !== null;
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
}: ShortcutOptions): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandPalette = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (commandPalette) {
        // The palette is global; enabled only gates the workspace navigation keys below.
        if (!paletteOpen && hasBlockingLayer()) return;
        event.preventDefault();
        onTogglePalette();
        return;
      }
      if (!enabled || paletteOpen || isTextEntry(event.target) || hasBlockingLayer()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // 大图开着时 hasBlockingLayer() 已经把这里整段挡掉了，所以 Esc 只关大图、
      // 不会顺手把铺开也收了 —— 这条不需要在这里再判一次。
      if (event.key === "Escape" && spreadOpen) {
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
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const next = orderedTasks[Math.min(index + 1, orderedTasks.length - 1)];
        if (next) onTask(next);
        return;
      }
      if (event.key === "k" || event.key === "ArrowUp") {
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
  }, [composerOpen, enabled, onCloseSpread, onCreate, onTask, onToggleSpread, onTogglePalette, orderedTasks, paletteOpen, selectedTaskId, spreadOpen]);

  useEffect(() => {
    if (!selectedTaskId) return;
    document.querySelector(`[data-task-id="${CSS.escape(selectedTaskId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedTaskId]);
}
