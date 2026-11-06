import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject, type WheelEvent } from "react";
import { Paperclip } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import {
  REQUIREMENT_INPUT_ID,
  conversationInputHeadline,
  conversationInputSelector,
  type ConversationInput,
} from "../task-detail/conversationInputs.ts";
import { formatInstant } from "../task-detail/utils.ts";
import { CONVERSATION_INPUTS_SHORTCUT, registerConversationInputsTarget } from "./conversationInputNav.ts";
import { TICK_ACTIVE_EXTRA, activeInput, nearestTick, railPitch, tickWidth } from "./conversationInputRailGeometry.ts";

/** 刻度簇上下至少留这么多空：别顶到会话区的边。 */
const RAIL_MARGIN = 28;
/** 刻度条的可指范围比刻度本身上下各多出这么多，指在两端那一格附近也算指到了。 */
const STRIP_PAD = 10;
/** 悬停卡片、列表离会话区上下边至少这么远。 */
const EDGE_GAP = 8;
/** 跳过去之后，那颗气泡的顶边离视口顶边留多少：贴死在边上不好认。 */
const JUMP_OFFSET = 16;

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * 会话左侧的输入导航：每一条横线是我说过的一句话（原始需求 + 每次追问），从上到下按时间排。
 *
 * - 指上去：附近几条横线像程序坞那样鼓起来，旁边浮出那条输入的全文；
 * - 点一下（横线或那张卡片）：会话直接跳到那颗气泡，并闪一下认出是哪一颗；
 * - 按 Q：整条摊开成一张列表，每条一行，方向键挑、回车跳，Esc / Q 收起。
 *
 * 读到哪一条，哪一格就亮一些长一些（滚动时跟着走），不指上去也看得出自己在哪。
 */
export function ConversationInputRail({
  inputs,
  scrollRef,
  onReaderScroll,
}: {
  inputs: readonly ConversationInput[];
  scrollRef: RefObject<HTMLElement | null>;
  /**
   * 读者自己挪了视口（点了一条跳过去、在导航条上滚了滚轮）：交给贴底逻辑记下来。
   * true = 往回看了，下一条新消息不许把他拽回底部。
   */
  onReaderScroll: (detachFromBottom: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);
  // 指针离第一格多远（像素）；null = 没指在导航条上。
  const [pointerY, setPointerY] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const count = inputs.length;
  const pitch = railPitch(count, Math.max(0, height - RAIL_MARGIN * 2));
  const span = pitch * (count - 1);
  const firstTickY = Math.max(RAIL_MARGIN, (height - span) / 2);
  const hovered = pointerY === null || menuOpen ? null : nearestTick(pointerY, count, pitch);
  const hoveredInput = hovered === null ? undefined : inputs[hovered];

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => setHeight(root.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // 读到哪一条了。滚动、会话区尺寸变化、输入增减都要重算；量的是真实气泡的位置，
  // 气泡上面的内容长高了（图片加载完、折叠块展开），浏览器的滚动锚定会补一次 scroll，照样跟得上。
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  // 刚点过的那一条：跳过去的路上、落定之后都标它。只按位置推的话，下一颗气泡离得近（连着
  // 追问了两句、中间只回了一句「好的」）或者落点被夹在了底部，标出来的就成了别的那条。
  // 读者自己再一挪（落定之后位置变了、在会话上滚了滚轮），就交还给按位置推。
  const pinRef = useRef<{ index: number; top: number; landed: boolean } | null>(null);
  const measure = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !container.clientHeight) return;
    const pin = pinRef.current;
    if (pin) {
      const there = Math.abs(container.scrollTop - pin.top) <= 1;
      if (there) pin.landed = true;
      if (there || !pin.landed) {
        setActive(pin.index);
        return;
      }
      pinRef.current = null;
    }
    const view = container.getBoundingClientRect();
    const tops = inputsRef.current.map((input) => {
      if (input.id === REQUIREMENT_INPUT_ID) return -container.scrollTop;
      const bubble = container.querySelector(conversationInputSelector(input.id));
      return bubble ? bubble.getBoundingClientRect().top - view.top : null;
    });
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
    setActive(activeInput(tops, container.clientHeight, atBottom));
  }, [scrollRef]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const release = () => {
      pinRef.current = null;
    };
    container.addEventListener("scroll", schedule, { passive: true });
    container.addEventListener("wheel", release, { passive: true });
    container.addEventListener("touchmove", release, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("scroll", schedule);
      container.removeEventListener("wheel", release);
      container.removeEventListener("touchmove", release);
      observer.disconnect();
    };
  }, [measure, scrollRef]);

  useEffect(() => measure(), [inputs, measure]);

  const jump = (index: number) => {
    const container = scrollRef.current;
    const input = inputs[index];
    if (!container || !input) return;
    let top = 0;
    let bubble: HTMLElement | null = null;
    if (input.id !== REQUIREMENT_INPUT_ID) {
      bubble = container.querySelector<HTMLElement>(conversationInputSelector(input.id));
      if (!bubble) return;
      top = bubble.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - JUMP_OFFSET;
    }
    const target = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
    pinRef.current = { index, top: target, landed: false };
    setActive(index);
    // 落点就是底部（点的是最后一条）也一样脱离跟随：人是来看这颗气泡的，接着长出来的回复
    // 要是把视口往下带，它转眼就被顶出屏幕。想接着跟，按 ↓ 或者自己滚到底。
    onReaderScroll(true);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({ top: target, behavior: reducedMotion ? "auto" : "smooth" });
    if (bubble) flash(bubble);
  };

  // 刻度带和卡片盖在会话区上，却不在滚动容器里头：滚轮落在它们身上，浏览器顺着祖先找可滚的，
  // 找不到会话那一层。替它滚，并照会话自己的滚轮那样记一笔意图（往上滚 = 往回看）。
  // 摊开的列表自己能滚，不转。
  const forwardWheel = (event: WheelEvent<HTMLDivElement>) => {
    const container = scrollRef.current;
    if (!container || !event.deltaY || menuRef.current?.contains(event.target as Node)) return;
    pinRef.current = null;
    onReaderScroll(event.deltaY < 0);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1;
    container.scrollBy({ top: event.deltaY * unit });
  };

  const openMenu = () => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    setPointerY(null);
    setMenuOpen(true);
  };
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    const previous = returnFocusRef.current;
    returnFocusRef.current = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    else if (menuRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }, []);

  const toggleRef = useRef(() => {});
  toggleRef.current = () => (menuOpen ? closeMenu() : openMenu());
  useEffect(() => registerConversationInputsTarget({
    // 拿刻度条正中那一点做命中测试：面板藏起来了量不出框，被抽屉 / 遮罩盖住了点到的是别人。
    available: () => {
      const strip = stripRef.current;
      const box = strip?.getBoundingClientRect();
      if (!strip || !box?.width || !box.height) return false;
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && rootRef.current?.contains(hit) === true;
    },
    toggle: () => toggleRef.current(),
  }), []);

  useDismissable({ enabled: menuOpen, containerRef: menuRef, onClose: closeMenu });

  // 摊开时焦点落在「正读着的那一条」上，并把它挪到列表中间：人按 Q 多半是想去它前后几条。
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    const current = menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[active];
    if (!menu || !current) return;
    current.focus({ preventScroll: true });
    menu.scrollTop = current.offsetTop - (menu.clientHeight - current.offsetHeight) / 2;
    // 只在摊开那一下对准；摊开期间滚动带动的 active 变化不该把焦点抢走，所以不依赖 active。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  // 摊开期间的键：这时工作区的单键被这张菜单挡住了（role="menu" 算阻挡层），Q 得自己收。
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      // 下面认下的键一律截断在这里（stopImmediatePropagation，不只是 stopPropagation）：工作区快捷键
      // 也挂在 window 的捕获阶段，它每次重挂都会排到这个监听后面。只停传播的话，收起列表的那下 Q
      // 照样落到它手上，而那时列表已经撤掉、挡不住它，于是又被它摊开。
      const menu = menuRef.current;
      if (!menu) return;
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const focusAt = (index: number) => {
        const item = items[(index + items.length) % items.length];
        if (!item) return;
        item.focus({ preventScroll: true });
        item.scrollIntoView({ block: "nearest" });
      };
      if (event.key === "ArrowDown") focusAt(at < 0 ? active : at + 1);
      else if (event.key === "ArrowUp") focusAt(at < 0 ? active : at - 1);
      else if (event.key === "Home") focusAt(0);
      else if (event.key === "End") focusAt(items.length - 1);
      else if (event.key === CONVERSATION_INPUTS_SHORTCUT && !isTextEntry(event.target)) closeMenu();
      else if (event.key === "Tab") {
        // 菜单不留 Tab 停靠点：Tab 出去就当是不挑了，焦点照常往下走。
        returnFocusRef.current = null;
        setMenuOpen(false);
        return;
      } else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, closeMenu, menuOpen]);

  // 卡片跟着指着的那一格上下走，碰到会话区的边就停住；高度要等它画出来才量得到。
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || hovered === null) return;
    const tickY = firstTickY + hovered * pitch;
    const cardHeight = card.offsetHeight;
    const top = Math.min(tickY - cardHeight / 2, height - cardHeight - EDGE_GAP);
    card.style.top = `${Math.max(EDGE_GAP, top)}px`;
  });

  const pointAt = (event: PointerEvent<HTMLDivElement>) => {
    setPointerY(event.clientY - event.currentTarget.getBoundingClientRect().top - STRIP_PAD);
  };
  const clickStrip = (event: MouseEvent<HTMLDivElement>) => {
    jump(nearestTick(event.clientY - event.currentTarget.getBoundingClientRect().top - STRIP_PAD, count, pitch));
  };

  return (
    <div ref={rootRef} className="conversation-input-rail" onPointerLeave={() => setPointerY(null)} onWheel={forwardWheel}>
      <div
        ref={stripRef}
        className="conversation-input-strip"
        style={{ top: firstTickY - STRIP_PAD, height: span + STRIP_PAD * 2 }}
        onPointerDown={pointAt}
        onPointerMove={pointAt}
        onClick={clickStrip}
      >
        {inputs.map((input, index) => {
          const y = index * pitch;
          const width = tickWidth(y, menuOpen ? null : pointerY) + (index === active ? TICK_ACTIVE_EXTRA : 0);
          return (
            <button
              key={input.id}
              type="button"
              tabIndex={-1}
              className={`conversation-input-tick${index === active ? " is-active" : ""}${index === hovered ? " is-hovered" : ""}`}
              style={{ top: STRIP_PAD + y, width: Math.round(width * 10) / 10 }}
              aria-label={conversationInputHeadline(input)}
              aria-current={index === active ? "location" : undefined}
              onClick={(event) => {
                // 鼠标点不到这里（横线不接指针，点的是外面那条带子）；这条路给辅助技术直接激活用。
                event.stopPropagation();
                jump(index);
              }}
            />
          );
        })}
      </div>
      {hoveredInput && hovered !== null && (
        <div ref={cardRef} className="conversation-input-card" onClick={() => jump(hovered)}>
          <div>
            <p>{hoveredInput.text || conversationInputHeadline(hoveredInput)}</p>
            <footer>
              {hoveredInput.at && <time dateTime={hoveredInput.at}>{formatInstant(hoveredInput.at)}</time>}
              {hoveredInput.attachments.length > 0 && (
                <span><Paperclip size={11} aria-hidden="true" />{hoveredInput.attachments.length}</span>
              )}
              <kbd>{CONVERSATION_INPUTS_SHORTCUT.toUpperCase()}</kbd>
            </footer>
          </div>
        </div>
      )}
      {menuOpen && (
        <div ref={menuRef} className="conversation-input-menu" role="menu" aria-label="我的输入">
          {inputs.map((input, index) => (
            <button
              key={input.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={index === active ? "is-current" : undefined}
              aria-current={index === active ? "location" : undefined}
              onClick={() => {
                returnFocusRef.current = null;
                setMenuOpen(false);
                jump(index);
              }}
            >
              <span>{conversationInputHeadline(input)}</span>
              {input.at && <time dateTime={input.at}>{formatInstant(input.at)}</time>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 跳到之后闪一下那颗气泡：一屏里常常不止一颗我的气泡，不标出来分不清落在了哪一颗。
 * 走 class 不走 inline style：动画结束自己摘掉，不跟 React 管的属性打架。
 */
function flash(bubble: HTMLElement) {
  bubble.classList.remove("is-jump-target");
  void bubble.offsetWidth;
  bubble.classList.add("is-jump-target");
  bubble.addEventListener("animationend", () => bubble.classList.remove("is-jump-target"), { once: true });
}
