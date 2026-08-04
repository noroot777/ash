import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, CaretDown, Check, SpinnerGap, Warning } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

/**
 * 全项目统一的下拉选择器 / 组合框。
 *
 * 存在的理由有两条，都来自被 `<select>` 和 `input[list]+datalist` 坑过：
 *
 * ① **原生 `<select>` 的弹层由系统画**，跟 `.ui-menu` / `.ui-select-trigger` 那套
 *    设计语言没有任何关系，同一页面里几个 select 之间也各长各的。
 * ② **`datalist` 会按当前输入值过滤候选**：输入框里已经有 `gpt-5.6` 时点开下拉，
 *    Chrome 只剩这一个候选——看起来就是「下拉框坏了」。要「列出全部 + 可输入筛选」
 *    就不能用它。
 *
 * 所以这里自己画：trigger 用 `.ui-select-trigger`，浮层用 `.ui-menu` 的观感，
 * 浮层 portal 到 body 且 fixed 定位（表格/卡片的 overflow 裁不到它），候选永远是
 * 完整的一份，筛选是**另一个**输入框的事。
 *
 * `step2` 让同一个浮层带出**第二步**（模型 → 思考强度）：档位是跟着模型走的，
 * 「先定模型再定强度」比并排两个下拉更接近实情，也免得用户在模型还没定时先挑了
 * 一个该模型根本不支持的档位。
 */

export type DropdownOption = {
  value: string;
  label: string;
  /** 右侧灰字：模型的归属、选项的补充说明。 */
  detail?: string;
  /** 同名连续项会聚成一块，块标题就是它（例：供应商名）。 */
  group?: string;
  mono?: boolean;
  /** 仍要列出来说明情况、但不让选（例：已不可用的执行器）。 */
  disabled?: boolean;
};

export type DropdownStatus = "idle" | "loading" | "ready" | "failed";

type Placement = { left: number; top: number; width: number; maxHeight: number };

const GAP = 4;
const MIN_PANEL = 160;

export function Dropdown({
  value,
  options,
  onChange,
  label,
  placeholder = "请选择",
  disabled = false,
  filterable = true,
  allowCustom = false,
  filterPlaceholder = "筛选…",
  emptyText = "没有匹配项",
  status = "ready",
  note = "",
  mono = false,
  className = "",
  displaySuffix = "",
  onClear,
  clearLabel = "清空",
  step2,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** 无可见标题时的可访问名称。 */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  filterable?: boolean;
  /** 允许把筛选框里手打的内容直接当值提交（模型名这种候选不全的场景）。 */
  allowCustom?: boolean;
  filterPlaceholder?: string;
  emptyText?: string;
  status?: DropdownStatus;
  note?: string;
  mono?: boolean;
  className?: string;
  /** trigger 上跟在主值后面的小标（例：思考强度）。 */
  displaySuffix?: string;
  /** 给一个「回到不设置」的出口；候选列表里就不必再占一行「跟随…」。 */
  onClear?: () => void;
  clearLabel?: string;
  /** 选完第一步后接着选的第二步（例：模型选完选思考强度）。 */
  step2?: {
    label: string;
    options: DropdownOption[];
    value: string;
    onChange: (value: string) => void;
    emptyText?: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<1 | 2>(1);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setStage(1);
    setQuery("");
  };

  useDismissable({
    enabled: open,
    containerRef: panelRef,
    onClose: close,
    restoreFocusRef: triggerRef,
  });

  const onStep2 = stage === 2 && !!step2;
  const stepOptions = onStep2 ? step2.options : options;
  const canFilter = filterable && !onStep2;

  const rows = useMemo<DropdownOption[]>(() => {
    const keyword = query.trim().toLowerCase();
    const hit = keyword
      ? stepOptions.filter((option) => (
        option.label.toLowerCase().includes(keyword) || option.value.toLowerCase().includes(keyword)
      ))
      : stepOptions;
    // 手打的内容没跟任何候选重名时，补一行「用它」，否则自由输入无处落地。
    const custom = allowCustom && !onStep2 && query.trim() && !hit.some((option) => option.value === query.trim())
      ? [{ value: query.trim(), label: query.trim(), detail: "直接使用", mono: true }]
      : [];
    return [...hit, ...custom];
  }, [allowCustom, onStep2, stepOptions, query]);

  const stepValue = onStep2 ? step2.value : value;
  const active = Math.min(index, Math.max(0, rows.length - 1));
  const current = options.find((option) => option.value === value);
  const display = current?.label ?? (value || "");

  const measure = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 10;
    const above = rect.top - 10;
    const flip = below < MIN_PANEL && above > below;
    const maxHeight = Math.max(MIN_PANEL, Math.min(320, flip ? above : below));
    setPlace({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
      top: flip ? rect.top - GAP - maxHeight : rect.bottom + GAP,
      width: Math.max(rect.width, 200),
      maxHeight,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    inputRef.current?.focus();
    if (!canFilter) panelRef.current?.focus();
  }, [canFilter, open, stage]);

  // 页面滚动/尺寸变化时跟着走：浮层是 fixed 的，不重算就会飘到别处。
  useEffect(() => {
    if (!open) return;
    const sync = () => measure();
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [open]);

  const commit = (next: string) => {
    if (onStep2) {
      step2.onChange(next);
    } else if (step2) {
      // 第一步落定后不关浮层：紧接着在同一个浮层里选第二步（强度）。
      onChange(next);
      setQuery("");
      setIndex(Math.max(0, step2.options.findIndex((option) => option.value === step2.value)));
      setStage(2);
      return;
    } else {
      onChange(next);
    }
    close();
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setIndex((active + delta + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row && !row.disabled) commit(row.value);
    }
  };

  let lastGroup: string | undefined;

  return (
    <div className={`ui-dropdown ${className}`.trim()}>
      <button
        type="button"
        ref={triggerRef}
        className={`ui-select-trigger ui-dropdown-trigger${mono ? " is-mono" : ""}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setStage(1);
          setIndex(Math.max(0, options.findIndex((option) => option.value === value)));
          setOpen((current) => !current);
        }}
      >
        <span className={display ? "" : "is-placeholder"}>{display || placeholder}</span>
        {displaySuffix && <em className="ui-dropdown-suffix">{displaySuffix}</em>}
        {status === "loading" && <SpinnerGap size={11} className="is-spinning" aria-hidden="true" />}
        {status === "failed" && <Warning size={11} className="ui-dropdown-warn" aria-hidden="true" />}
        <CaretDown size={11} weight="bold" className="ui-select-caret" aria-hidden="true" />
      </button>

      {open && place && createPortal(
        <div
          className="ui-dropdown-panel"
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          style={{ left: place.left, top: place.top, width: place.width }}
        >
          {onStep2 && (
            <div className="ui-dropdown-step">
              <button type="button" onClick={() => { setStage(1); setIndex(0); }} aria-label="返回上一步">
                <ArrowLeft size={11} weight="bold" />
              </button>
              <b>{step2.label}</b>
              <span>{display || placeholder}</span>
            </div>
          )}
          {canFilter && (
            <div className="ui-dropdown-search">
              <input
                ref={inputRef}
                value={query}
                placeholder={filterPlaceholder}
                aria-label={`${label} · 筛选`}
                onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
              />
            </div>
          )}
          {note && (
            <p className={`ui-dropdown-note${status === "failed" ? " is-error" : ""}`}>{note}</p>
          )}
          <div
            className="ui-dropdown-rows"
            role="listbox"
            aria-label={onStep2 ? step2.label : label}
            style={{ maxHeight: place.maxHeight - (canFilter ? 42 : 0) - (onStep2 ? 30 : 0) - (onClear ? 28 : 0) }}
          >
            {!rows.length && <p className="ui-dropdown-empty">{(onStep2 ? step2.emptyText : emptyText) ?? emptyText}</p>}
            {rows.map((row, rowIndex) => {
              const head = row.group && row.group !== lastGroup ? row.group : "";
              lastGroup = row.group;
              return (
                <div key={`${row.group ?? ""}:${row.value}:${rowIndex}`}>
                  {head && <div className="ui-dropdown-group">{head}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={rowIndex === active}
                    aria-disabled={row.disabled}
                    className={`ui-dropdown-row${row.value === stepValue ? " is-current" : ""}${row.mono ?? mono ? " is-mono" : ""}${row.disabled ? " is-disabled" : ""}`}
                    onMouseEnter={() => setIndex(rowIndex)}
                    onClick={() => { if (!row.disabled) commit(row.value); }}
                  >
                    <b>{row.label}</b>
                    {row.detail && <span>{row.detail}</span>}
                    {row.value === stepValue && <Check size={11} weight="bold" aria-hidden="true" />}
                  </button>
                </div>
              );
            })}
          </div>
          {onClear && !onStep2 && (
            <button
              type="button"
              className="ui-dropdown-clear"
              onClick={() => { onClear(); close(); triggerRef.current?.focus(); }}
            >
              {clearLabel}
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
