import { ArrowRight, CirclesThreePlus } from "@phosphor-icons/react";
import { ComponentsPage } from "./dev/ComponentsPage.tsx";

function HomePage() {
  return (
    <main className="next-home">
      <section className="next-home-card">
        <span className="next-home-mark" aria-hidden="true">
          <CirclesThreePlus weight="bold" />
        </span>
        <p className="next-home-eyebrow">Harness Web Next</p>
        <h1>新版前端地基已就绪</h1>
        <p>
          这里将承载新的三栏工作区。当前阶段先固定 Linear 视觉变量、基础控件与独立数据访问层。
        </p>
        <a className="ui-button ui-button--primary" href="/dev/components">
          查看控件样板 <ArrowRight aria-hidden="true" />
        </a>
      </section>
    </main>
  );
}

export function App() {
  return window.location.pathname === "/dev/components" ? <ComponentsPage /> : <HomePage />;
}
