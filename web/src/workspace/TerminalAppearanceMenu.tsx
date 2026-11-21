import { useRef, useState } from "react";
import { Palette } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { terminalThemes, type TerminalAppearance, type TerminalTheme } from "./terminalAppearance.ts";

export function TerminalAppearanceMenu({ appearance, onChange }: {
  appearance: TerminalAppearance;
  onChange: (appearance: TerminalAppearance) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismissable({ enabled: open, containerRef: panel, restoreFocusRef: button, onClose: () => setOpen(false) });

  return (
    <div className="terminal-appearance">
      <button ref={button} type="button" aria-label="终端外观" aria-expanded={open}
        className="terminal-appearance__toggle" onClick={() => setOpen((value) => !value)}>
        <Palette size={16} />
      </button>
      {open && (
        <div ref={panel} className="terminal-appearance__panel" role="group" aria-label="终端外观选项">
          <div className="terminal-appearance__themes">
            {(Object.keys(terminalThemes) as TerminalTheme[]).map((theme) => (
              <button key={theme} type="button" aria-pressed={theme === appearance.theme}
                onClick={() => onChange({ ...appearance, theme })}>
                <span aria-hidden="true" style={{ background: terminalThemes[theme].colors.background, color: terminalThemes[theme].colors.foreground }}>Aa</span>
                {terminalThemes[theme].label}
              </button>
            ))}
          </div>
          <div className="terminal-appearance__sizes" role="group" aria-label="终端字号">
            {[12, 14, 16].map((fontSize) => (
              <button key={fontSize} type="button" aria-pressed={fontSize === appearance.fontSize}
                aria-label={`${fontSize} 像素`} onClick={() => onChange({ ...appearance, fontSize })}>{fontSize}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
