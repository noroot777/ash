import { useState, type SetStateAction } from "react";

export function usePaletteSelection(keys: string[]) {
  const [selection, setSelection] = useState<{ key: string | null; index: number }>({ key: null, index: 0 });
  const matched = selection.key === null ? -1 : keys.indexOf(selection.key);
  const active = matched >= 0 ? matched : Math.min(selection.index, Math.max(0, keys.length - 1));
  const select = (next: SetStateAction<number>) => {
    setSelection((previous) => {
      const matched = previous.key === null ? -1 : keys.indexOf(previous.key);
      const current = matched >= 0 ? matched : Math.min(previous.index, Math.max(0, keys.length - 1));
      const index = Math.max(0, typeof next === "function" ? next(current) : next);
      return { key: keys[index] ?? null, index };
    });
  };
  return { active, select, reset: () => setSelection({ key: null, index: 0 }) };
}
