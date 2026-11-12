import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check, SpinnerGap, Warning } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { selectPanelPlacement, type SelectPlacement } from "./selectPlacement.ts";

/**
 * 全应用的下拉选择器：一个组件，两档长相。
 *
 * · `size="form"`（缺省）——表单里那一档，和输入框同高同框；
 * · `size="compact"`——表格行、键值行里那一档，无框、24 高，指到才有底色。
 *
 * 自己画而不用原生 `<select>`，理由有两条，都是被坑过的：
 * ① 原生 `<select>` 的弹层由系统画，跟应用里的菜单不是一种东西，同一页几个 select 之间
 *    也各长各的（审查时数到过十种高度）；
 * ② `input[list]+datalist` 会按当前输入值过滤候选：框里已经有 `gpt-5.6` 时点开，Chrome
 *    只剩这一个候选——看起来就是「下拉坏了」。要「列出全部 + 可输入筛选」只能自己来。
 *
 * 所以：浮层 portal 到 body、fixed 定位（表格/卡片的 overflow 裁不到它），候选永远是完整
 * 的一份，筛选是**另一个**输入框的事（`filterable`）。浮层从触发器那一侧长出来，进场
 * `--dur-2`、退场 120ms；关掉统一走 `useDismissable`（点外面、Esc、焦点回触发器）。
 *
 * 键盘和原生 select 对齐：触发器上按上下键或打字母直接展开（字母顺带跳到那一项）；浮层里
 * 上下键 / Home / End 走、回车选、Esc 关、Tab 关并回到触发器。选中的那一项右边打勾；
 * 键盘正走到的那一项只是底色，不打勾——「走到」和「选中」是两件事，`aria-selected` 只
 * 给后者，前者走 `aria-activedescendant`。
 *
 * 这里**只选一个值**。曾经有过一个 `step2`（选完模型接着在同一个浮层里选智能水平），已经
 * 撤掉：模型和档位是两件独立的事。「选谁干活 · 模型 · 智能水平」是三段胶囊
 * （components/RunTargetPicker.tsx），不走这个组件。
 *
 * 旧名 `Dropdown`（components/Dropdown.tsx）是它的别名，只是筛选框缺省开着。
 */

export type SelectOption<V extends string = string> = {
  value: V;
  label: string;
  /** 右侧灰字：模型的归属、选项的补充说明。 */
  detail?: string;
  /** 同名连续项会聚成一块，块标题就是它（例：供应商名）。 */
  group?: string;
  mono?: boolean;
  /** 仍要列出来说明情况、但不让选（例：已不可用的执行器）。 */
  disabled?: boolean;
};

export type SelectStatus = "idle" | "loading" | "ready" | "failed";

export type SelectProps<V extends string = string> = {
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  /** 可访问名称（触发器和浮层都用它）。 */
  label: string;
  /** form = 和输入框同高同框；compact = 表格和键值行里的无框紧凑档。 */
  size?: "form" | "compact";
  /** 值不在候选里时触发器上写什么。 */
  placeholder?: string;
  /** 触发器上不照搬选中项的名字时用（例：菜单里写「跟随 CLI」，格子里只写「跟随」）。 */
  display?: ReactNode;
  disabled?: boolean;
  /** 浮层顶上给一个筛选框。候选多（模型名、任务）时开。 */
  filterable?: boolean;
  /** 允许把筛选框里手打的内容直接当值提交（模型名这种候选不全的场景）。 */
  allowCustom?: boolean;
  filterPlaceholder?: string;
  emptyText?: string;
  status?: SelectStatus;
  note?: string;
  mono?: boolean;
  className?: string;
  panelClassName?: string;
  /** 只影响候选列表的附加选择控件（例如模型目录模式）。 */
  panelHeader?: ReactNode;
  /** 切换候选集时清掉上一次的筛选词。 */
  filterResetKey?: string;
  /**
   * 选中后浮层留着继续挑：用在「往一个清单里累加」的场景（例：固定模型列表），
   * 那里选一个不等于选完了。单值选择器不要开，选完还杵着会让人以为没生效。
   */
  keepOpenOnSelect?: boolean;
  /** 给一个「回到不设置」的出口；候选列表里就不必再占一行「跟随…」。 */
  onClear?: () => void;
  clearLabel?: string;
};

/** 退场动画的时长（和 select.css 里 `.is-leaving` 那一段同一个数）。 */
const LEAVE_MS = 120;
/** 连续打字算同一个词的间隔，和原生 select 差不多。 */
const TYPEAHEAD_MS = 600;

export function Select<V extends string = string>({
  value,
  options,
  onChange,
  label,
  size = "form",
  placeholder = "请选择",
  display,
  disabled = false,
  filterable = false,
  allowCustom = false,
  filterPlaceholder = "筛选…",
  emptyText = "没有匹配项",
  status = "ready",
  note = "",
  mono = false,
  className = "",
  panelClassName = "",
  panelHeader,
  filterResetKey,
  keepOpenOnSelect = false,
  onClear,
  clearLabel = "清空",
}: SelectProps<V>) {
  const [open, setOpen] = useState(false);
  // 关掉之后还要留 120ms 放完退场：mounted 管「在不在 DOM 里」，open 管「是不是开着」。
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<SelectPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (rowIndex: number) => `${baseId}-opt-${rowIndex}`;

  useEffect(() => {
    setQuery("");
    setIndex(0);
  }, [filterResetKey]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  useDismissable({
    enabled: open,
    containerRef: panelRef,
    onClose: close,
    restoreFocusRef: triggerRef,
  });

  const rows = useMemo<SelectOption<V>[]>(() => {
    const keyword = query.trim().toLowerCase();
    const hit = keyword
      ? options.filter((option) => (
        option.label.toLowerCase().includes(keyword) || option.value.toLowerCase().includes(keyword)
      ))
      : [...options];
    // 手打的内容没跟任何候选重名时，补一行「用它」，否则自由输入无处落地。
    const custom = allowCustom && query.trim() && !hit.some((option) => option.value === query.trim())
      ? [{ value: query.trim() as V, label: query.trim(), detail: "直接使用", mono: true }]
      : [];
    return [...hit, ...custom];
  }, [allowCustom, options, query]);

  const active = Math.min(index, Math.max(0, rows.length - 1));
  const current = options.find((option) => option.value === value);
  const shown = display ?? current?.label ?? (value || "");

  const measure = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setPlace(selectPanelPlacement(trigger, {
      reserve: (panelHeader ? 80 : 0) + (note ? 50 : 0),
    }));
  };

  // 候选数量变了（异步探测回来、累加选走一个）浮层高度跟着变，得重新量一遍翻转方向。
  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [filterable, open, options.length]);
  // 焦点要等浮层真的挂上再给，判据就是下面渲染浮层的那个条件（挂着 + 量过位置）：只看量没量
  // 过不够——关掉之后位置还留着，再开时这一拍浮层要等 mounted 才回到 DOM 里，焦点给早了落空，
  // 之后又没有东西再触发一次，键盘只能停在触发键上干瞪眼（第 1 轮审查 F3）。
  const panelShown = mounted && place !== null;
  useLayoutEffect(() => {
    if (!open || !panelShown) return;
    if (filterable) inputRef.current?.focus();
    else panelRef.current?.focus();
  }, [filterable, open, panelShown]);

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

  // 键盘走到哪一项，那一项就得在可视范围里（列表比浮层高时会滚走）。
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const enabledRow = (from: number, step: 1 | -1) => {
    for (let n = 1; n <= rows.length; n += 1) {
      const at = (from + step * n + rows.length * n) % rows.length;
      if (!rows[at]?.disabled) return at;
    }
    return from;
  };

  /** 按打的字找下一项：同一个字母连按就在以它开头的几项之间轮转，和原生 select 一样。 */
  const matchTyped = (key: string, from: number) => {
    const now = Date.now();
    const text = now - typed.current.at < TYPEAHEAD_MS ? typed.current.text + key.toLowerCase() : key.toLowerCase();
    typed.current = { text, at: now };
    const cycling = text.length > 1 && [...text].every((char) => char === text[0]);
    const needle = cycling ? text[0] : text;
    const start = needle.length === 1 ? from + 1 : from;
    for (let n = 0; n < rows.length; n += 1) {
      const at = (start + n) % rows.length;
      const row = rows[at];
      if (row && !row.disabled && row.label.toLowerCase().startsWith(needle)) return at;
    }
    return -1;
  };

  const openPanel = (startAt?: number) => {
    if (disabled) return;
    setQuery("");
    const selected = options.findIndex((option) => option.value === value);
    setIndex(startAt ?? Math.max(0, selected));
    setOpen(true);
  };

  const commit = (next: V) => {
    onChange(next);
    if (keepOpenOnSelect) {
      // 累加场景：筛选词留着接着挑——选中的那个会从候选里消失，剩下的原地不动。
      // 手打的自由值没有「剩下的」，清空，否则刚打完的那串会赖在筛选框里。
      if (!options.some((option) => option.value === next)) setQuery("");
      setIndex(0);
      inputRef.current?.focus();
      return;
    }
    close();
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (open || disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openPanel();
      return;
    }
    if (event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const selected = Math.max(0, options.findIndex((option) => option.value === value));
      const hit = matchTyped(event.key, selected);
      event.preventDefault();
      openPanel(hit >= 0 ? hit : undefined);
    }
  };

  const onPanelKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).closest(".ui-dropdown-header")) return;
    if (!rows.length) return;
    const move = {
      ArrowDown: () => enabledRow(active, 1),
      ArrowUp: () => enabledRow(active, -1),
      Home: () => enabledRow(-1, 1),
      End: () => enabledRow(rows.length, -1),
    }[event.key];
    if (move && !(filterable && (event.key === "Home" || event.key === "End"))) {
      event.preventDefault();
      setIndex(move());
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row && !row.disabled) commit(row.value);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close();
      triggerRef.current?.focus();
      return;
    }
    // 有筛选框时字母归筛选框；没有时按首字母跳。
    if (!filterable && event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const hit = matchTyped(event.key, active);
      if (hit >= 0) setIndex(hit);
    }
  };

  const flipped = place?.bottom !== undefined;
  const leaving = mounted && !open;
  let lastGroup: string | undefined;

  return (
    <div className={`ui-dropdown${size === "compact" ? " is-compact" : ""} ${className}`.trim()}>
      <button
        type="button"
        ref={triggerRef}
        className={`ui-select-trigger ui-dropdown-trigger${mono ? " is-mono" : ""}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-value={value}
        disabled={disabled}
        onKeyDown={onTriggerKeyDown}
        onClick={() => (open ? close() : openPanel())}
      >
        <span className={shown ? "" : "is-placeholder"}>{shown || placeholder}</span>
        {status === "loading" && <SpinnerGap size={12} className="is-spinning" aria-hidden="true" />}
        {status === "failed" && <Warning size={12} className="ui-dropdown-warn" aria-hidden="true" />}
        <CaretDown size={12} weight="bold" className="ui-select-caret" aria-hidden="true" />
      </button>

      {panelShown && place && createPortal(
        <div
          className={`ui-dropdown-panel${leaving ? " is-leaving" : ""}${flipped ? " is-up" : ""} ${panelClassName}`.trim()}
          ref={panelRef}
          tabIndex={-1}
          aria-activedescendant={!filterable && rows.length ? optionId(active) : undefined}
          onKeyDown={onPanelKeyDown}
          style={{ left: place.left, top: place.top, bottom: place.bottom, width: place.width, maxHeight: place.maxHeight, zIndex: place.zIndex }}
        >
          {panelHeader && <div className="ui-dropdown-header">{panelHeader}</div>}
          {filterable && (
            <div className="ui-dropdown-search">
              <input
                ref={inputRef}
                value={query}
                placeholder={filterPlaceholder}
                aria-label={`${label} · 筛选`}
                aria-controls={listId}
                aria-activedescendant={rows.length ? optionId(active) : undefined}
                onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
              />
            </div>
          )}
          {note && (
            <p className={`ui-dropdown-note${status === "failed" ? " is-error" : ""}`}>{note}</p>
          )}
          <div className="ui-dropdown-rows" role="listbox" id={listId} aria-label={label}>
            {!rows.length && <p className="ui-dropdown-empty">{emptyText}</p>}
            {rows.map((row, rowIndex) => {
              const head = row.group && row.group !== lastGroup ? row.group : "";
              lastGroup = row.group;
              const selected = row.value === value;
              return (
                <div key={`${row.group ?? ""}:${row.value}:${rowIndex}`} role="presentation">
                  {head && <div className="ui-dropdown-group" role="presentation">{head}</div>}
                  <button
                    type="button"
                    role="option"
                    id={optionId(rowIndex)}
                    data-value={row.value}
                    tabIndex={-1}
                    aria-selected={selected}
                    aria-disabled={row.disabled || undefined}
                    data-active={rowIndex === active || undefined}
                    className={`ui-dropdown-row${selected ? " is-current" : ""}${row.mono ?? mono ? " is-mono" : ""}${row.disabled ? " is-disabled" : ""}`}
                    onMouseEnter={() => setIndex(rowIndex)}
                    onClick={() => { if (!row.disabled) commit(row.value); }}
                  >
                    <b>{row.label}</b>
                    {row.detail && <span>{row.detail}</span>}
                    {selected && <Check size={13} weight="bold" className="ui-dropdown-check" aria-hidden="true" />}
                  </button>
                </div>
              );
            })}
          </div>
          {onClear && (
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
