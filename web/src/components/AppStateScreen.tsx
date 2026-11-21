import type { ReactNode } from "react";
import { NaviLoader } from "../brand/NaviLoader.tsx";
import { NaviMark } from "../brand/NaviMark.tsx";

export function AppStateScreen({ title, busy = false, children, actions, className = "", alert = false }: {
  title: string;
  busy?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  alert?: boolean;
}) {
  return (
    <main className={`app-state-screen ${className}`} role={alert ? "alert" : "status"}>
      <div className="app-state-screen__content">
        <div className="app-state-screen__mark" aria-hidden="true">
          {busy ? <NaviLoader size={80} /> : <NaviMark size={80} />}
        </div>
        <h1>{title}</h1>
        {children && <div className="app-state-screen__detail">{children}</div>}
        {actions && <div className="app-state-screen__actions">{actions}</div>}
      </div>
    </main>
  );
}
