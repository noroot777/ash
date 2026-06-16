import { useEffect } from "react";

// Close-on-Esc for overlays. Window-level so it fires regardless of focus
// (project convention: every modal/panel must be Esc-closable). Locks background
// scroll while active. `enabled` lets callers that render unconditionally (early
// return) still call the hook unconditionally.
export function useEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, enabled]);
}
