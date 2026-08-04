import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, CaretDown, CaretRight, Check, SpinnerGap, Warning } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

/**
 * 全项目统一的下拉选择器 / 组合框，可以是**多步**的。
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
 * `steps` 让同一个浮层依次问几件事（执行器 → 模型 → 思考强度）：这几件是**一次**
 * 决定的几半，而且后一步的候选由前一步决定（档位表跟着 CLI 走、模型目录跟着执行器
 * 走），并排摆三个下拉只会让人先挑出一个根本不成立的组合。第 0 步由组件的顶层
 * props 描述，`steps` 里每一步都可以有自己的候选、筛选和状态。
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

/** 多步下拉里的一步；第 0 步由 Dropdown 的顶层 props 拼出来。 */
export type DropdownStep = {
  label: string;
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  filterable?: boolean;
  filterPlaceholder?: string;
  allowCustom?: boolean;
  mono?: boolean;
  status?: DropdownStatus;
  note?: string;
  emptyText?: string;
};

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
  steps,
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
  /** trigger 上跟在主值后面的小标（例：模型 · 思考强度）。 */
  displaySuffix?: string;
  /** 给一个「回到不设置」的出口；候选列表里就不必再占一行「跟随…」。 */
  onClear?: () => void;
  clearLabel?: string;
  /** 第 0 步选完后接着问的几步（例：执行器 → 模型 → 思考强度）。 */
  steps?: DropdownStep[];
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState(0);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const levels: DropdownStep[] = [
    { label, options, value, onChange, filterable, filterPlaceholder, allowCustom, mono, status, note, emptyText },
    ...(steps ?? []),
  ];
  const level = levels[Math.min(stage, levels.length - 1)]!;
  const canFilter = level.filterable ?? false;

  const close = () => {
    setOpen(false);
    setStage(0);
    setQuery("");
  };

  useDismissable({
    enabled: open,
    containerRef: panelRef,
    onClose: close,
    restoreFocusRef: triggerRef,
  });

  const rows = useMemo<DropdownOption[]>(() => {
    const keyword = query.trim().toLowerCase();
    const hit = keyword
      ? level.options.filter((option) => (
        option.label.toLowerCase().includes(keyword) || option.value.toLowerCase().includes(keyword)
      ))
      : level.options;
    // 手打的内容没跟任何候选重名时，补一行「用它」，否则自由输入无处落地。
    const custom = level.allowCustom && query.trim() && !hit.some((option) => option.value === query.trim())
      ? [{ value: query.trim(), label: query.trim(), detail: "直接使用", mono: true }]
      : [];
    return [...hit, ...custom];
  }, [level.allowCustom, level.options, query]);

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
    if (canFilter) inputRef.current?.focus();
    else panelRef.current?.focus();
  }, [canFilter, open, stage]);

  // 进入某一步时把高亮落到这一步的当前值上。放在 effect 里是因为前一步的 onChange
  // 刚刚才发生，父组件的新值要等这次渲染之后才拿得到。
  useEffect(() => {
    if (!open) return;
    setIndex(Math.max(0, level.options.findIndex((option) => option.value === level.value)));
  }, [open, stage]);

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
    level.onChange(next);
    // 还有下一步：不关浮层，接着问。
    if (stage < levels.length - 1) {
      setQuery("");
      setStage(stage + 1);
      return;
    }
    close();
    triggerRef.current?.focus();
  };

  const handleKey = (key: string): boolean => {
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (rows.length) setIndex((active + (key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
      return true;
    }
    if (key === "Enter") {
      const row = rows[active];
      if (row && !row.disabled) commit(row.value);
      return true;
    }
    if (key === "Backspace" && stage > 0 && !query) {
      setQuery("");
      setStage(stage - 1);
      return true;
    }
    return false;
  };

  // 没有筛选框的那几步（思考强度这类），焦点会落在刚被卸载的那一行上、被浏览器退回
  // body，挂在浮层上的 React onKeyDown 就再也收不到冒泡——↑↓ 当场失灵而 Esc 还好用
  // （它是 useDismissable 的 document 级监听）。所以这几步的键盘也挂到 document 上。
  const keyRef = useRef(handleKey);
  keyRef.current = handleKey;
  useEffect(() => {
    if (!open || canFilter) return;
    const onKey = (event: KeyboardEvent) => {
      if (!keyRef.current(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [canFilter, open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (handleKey(event.key)) event.preventDefault();
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
          setStage(0);
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
          {stage > 0 && (
            <div className="ui-dropdown-step">
              <button
                type="button"
                onClick={() => { setQuery(""); setStage(stage - 1); }}
                aria-label="返回上一步"
              >
                <ArrowLeft size={11} weight="bold" />
              </button>
              <b>{level.label}</b>
              <span>
                {levels.slice(0, stage).map((done, order) => (
                  <span key={done.label}>
                    {order > 0 && <CaretRight size={8} weight="bold" aria-hidden="true" />}
                    {done.options.find((option) => option.value === done.value)?.label || done.value || "跟随"}
                  </span>
                ))}
              </span>
            </div>
          )}
          {canFilter && (
            <div className="ui-dropdown-search">
              <input
                ref={inputRef}
                value={query}
                placeholder={level.filterPlaceholder ?? "筛选…"}
                aria-label={`${level.label} · 筛选`}
                onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
              />
            </div>
          )}
          {level.note && (
            <p className={`ui-dropdown-note${level.status === "failed" ? " is-error" : ""}`}>{level.note}</p>
          )}
          <div
            className="ui-dropdown-rows"
            role="listbox"
            aria-label={level.label}
            style={{
              maxHeight: place.maxHeight - (canFilter ? 42 : 0) - (stage > 0 ? 30 : 0) - (onClear ? 28 : 0),
            }}
          >
            {!rows.length && <p className="ui-dropdown-empty">{level.emptyText ?? "没有匹配项"}</p>}
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
                    className={`ui-dropdown-row${row.value === level.value ? " is-current" : ""}${row.mono ?? level.mono ? " is-mono" : ""}${row.disabled ? " is-disabled" : ""}`}
                    onMouseEnter={() => setIndex(rowIndex)}
                    onClick={() => { if (!row.disabled) commit(row.value); }}
                  >
                    <b>{row.label}</b>
                    {row.detail && <span>{row.detail}</span>}
                    {row.value === level.value && <Check size={11} weight="bold" aria-hidden="true" />}
                  </button>
                </div>
              );
            })}
          </div>
          {onClear && stage === 0 && (
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
