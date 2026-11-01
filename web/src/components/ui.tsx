import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { useRovingChoice } from "../lib/useRovingChoice.ts";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", className = "", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`ui-button ui-button--${variant} ${className}`.trim()}
      {...props}
    />
  );
});

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className = "", ...props }, ref) {
    return <input ref={ref} className={`ui-input ${className}`.trim()} {...props} />;
  },
);

export function SelectTrigger({
  children,
  open = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { open?: boolean }) {
  return (
    <button
      type="button"
      className={`ui-select-trigger ${className}`.trim()}
      aria-expanded={open}
      {...props}
    >
      <span>{children}</span>
      <span className="ui-select-caret" aria-hidden="true">
        {open ? "⌃" : "⌄"}
      </span>
    </button>
  );
}

export function Menu({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`ui-menu ${className}`.trim()} role="menu">
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  shortcut,
  danger = false,
  selected = false,
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  shortcut?: string;
  danger?: boolean;
  selected?: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`ui-menu-item${danger ? " is-danger" : ""}${selected ? " is-selected" : ""} ${className}`.trim()}
      role="menuitem"
    >
      <span>{children}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="ui-menu-separator" role="separator" />;
}

export type TabItem<T extends string> = { value: T; label: string };

export function PillTabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  // 键盘契约与别处的按钮单选共用一份(lib/useRovingChoice.ts):方向键换页、整组
  // 一个 Tab 停靠点。分页项一律可选,所以不必再管禁用。
  const { groupProps, itemProps } = useRovingChoice(
    items.map((item) => item.value), value, onChange, "tab",
  );
  return (
    <div className="ui-tabs" {...groupProps} aria-label={label}>
      {items.map((item) => (
        <button key={item.value} type="button" {...itemProps(item.value)} onClick={() => onChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className="ui-choice"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={`ui-checkbox${checked ? " is-checked" : ""}`} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className="ui-choice"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={`ui-toggle${checked ? " is-on" : ""}`} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

type StatusTone = "neutral" | "green" | "amber" | "red" | "accent" | "cyan";

export function StatusChip({ children, tone = "neutral" }: { children: ReactNode; tone?: StatusTone }) {
  return (
    <span className="ui-status-chip">
      <i className={`ui-status-dot ui-status-dot--${tone}`} aria-hidden="true" />
      {children}
    </span>
  );
}

export function SelectableRow({
  selected = false,
  children,
}: {
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="ui-selectable ui-selectable-row"
      aria-selected={selected}
    >
      {children}
    </button>
  );
}
