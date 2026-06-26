import { useEffect, useState } from "react";

// 轻量全局 toast —— 替代浏览器原生 alert(报错/提示):非阻塞、几秒后自动消失、可点掉。
// 模块级订阅 store,无需 Context Provider 包裹;<Toaster/> 挂在 App 根渲染一次即可,
// 任意位置 import { toast } 直接调用。约定见 CLAUDE.md:前端禁用原生弹窗。
type Kind = "error" | "info";
type Item = { id: number; message: string; kind: Kind };

let items: Item[] = [];
let seq = 0;
const listeners = new Set<(items: Item[]) => void>();
const emit = () => listeners.forEach((l) => l(items));
const dismiss = (id: number) => {
  items = items.filter((t) => t.id !== id);
  emit();
};

export function toast(message: string, kind: Kind = "error"): void {
  const id = ++seq;
  items = [...items, { id, message, kind }];
  emit();
  setTimeout(() => dismiss(id), 4500);
}

export function Toaster() {
  const [list, setList] = useState<Item[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  if (!list.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex max-w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          role="alert"
          onClick={() => dismiss(t.id)}
          className={`cursor-pointer rounded-lg px-3.5 py-2.5 text-[13px] leading-snug shadow-lg ring-1 ${
            t.kind === "error" ? "bg-red-600 text-white ring-red-700/40" : "bg-ink text-canvas ring-black/10"
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
