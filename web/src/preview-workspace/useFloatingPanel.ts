import { useLayoutEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import { floatingPanelPosition } from "./floatingPanelPosition.ts";

const panels = ".preview-workspace-header, .preview-workspace-controls, .preview-workspace-notes";

export function useFloatingPanel<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T>(null);
  const offset = useRef({ x: 0, y: 0 });
  const [position, setPosition] = useState(offset.current);
  const [moving, setMoving] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const move = (x: number, y: number) => {
    const panel = ref.current;
    const workspace = panel?.closest(".preview-workspace");
    if (!panel || !workspace) return;
    const bounds = workspace.getBoundingClientRect(), box = panel.getBoundingClientRect();
    const left = box.left - offset.current.x, top = box.top - offset.current.y;
    const obstacles = [...workspace.querySelectorAll<HTMLElement>(panels)]
      .filter(other => other !== panel)
      .map(other => other.getBoundingClientRect())
      .filter(other => other.width > 0 && other.height > 0);
    const placed = floatingPanelPosition({ left: left + x, top: top + y, width: box.width, height: box.height }, bounds, obstacles);
    const next = { x: placed.left - left, y: placed.top - top };
    if (next.x !== offset.current.x || next.y !== offset.current.y) {
      offset.current = next;
      // Other panels' resize callbacks see this placement in the same observer delivery.
      panel.style.transform = `translate(${next.x}px, ${next.y}px)`;
      setPosition(next);
    }
  };
  useLayoutEffect(() => {
    if (!enabled) { offset.current = { x: 0, y: 0 }; setPosition(offset.current); return; }
    const panel = ref.current, workspace = panel?.closest(".preview-workspace");
    if (!panel || !workspace) return;
    const observer = new ResizeObserver(() => move(offset.current.x, offset.current.y));
    observer.observe(panel); observer.observe(workspace);
    workspace.querySelectorAll(panels).forEach(other => observer.observe(other));
    return () => observer.disconnect();
  }, [enabled]);
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null; setMoving(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    ref, moving,
    style: enabled ? { transform: `translate(${position.x}px, ${position.y}px)` } : undefined,
    handle: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (!enabled || event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus();
        drag.current = { id: event.pointerId, x: event.clientX - offset.current.x, y: event.clientY - offset.current.y };
        event.currentTarget.setPointerCapture(event.pointerId); setMoving(true);
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        const active = drag.current;
        if (active?.id === event.pointerId) move(event.clientX - active.x, event.clientY - active.y);
      },
      onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish,
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!enabled || !delta) return;
        event.preventDefault(); event.stopPropagation();
        const step = event.shiftKey ? 8 : 32;
        move(offset.current.x + delta[0] * step, offset.current.y + delta[1] * step);
      },
    },
  };
}
