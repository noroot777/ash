import { TerminalWindow } from "@phosphor-icons/react";

export function TerminalToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`terminal-toggle${open ? " is-active" : ""}`}
      aria-label={open ? "隐藏 CLI" : "打开 CLI"}
      aria-pressed={open}
      onClick={onToggle}
    >
      <TerminalWindow size={16} aria-hidden="true" />
    </button>
  );
}
