import { useEffect, useRef } from "react";

// Overlays can stack (notes modal over the groups panel, a confirm dialog over
// the notes modal). Every instance listens on window, and stopPropagation can't
// silence sibling listeners on the same target — so without coordination one
// Esc closes the whole stack. Enabled hooks register here in mount order
// (mount order == visual stacking order in App), and only the top entry reacts.
const escapeStack: { close: () => void }[] = [];

// Close-on-Esc for overlays. Window-level so it fires regardless of focus
// (project convention: every modal/panel must be Esc-closable). Locks background
// scroll while active. `enabled` lets callers that render unconditionally (early
// return) still call the hook unconditionally.
export function useEscape(onClose: () => void, enabled = true) {
  // The stack entry must live for the whole mount — re-pushing on every onClose
  // identity change would shuffle a re-rendered lower layer to the top.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const entry = { close: () => closeRef.current() };
    escapeStack.push(entry);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && escapeStack[escapeStack.length - 1] === entry) {
        e.stopPropagation();
        entry.close();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      const at = escapeStack.indexOf(entry);
      if (at >= 0) escapeStack.splice(at, 1);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [enabled]);
}
