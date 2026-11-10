import { Component, type ReactNode } from "react";

// React 只有类组件能当错误边界。渲染里抛出的错误一路没人接,React 会卸载整棵树,页面只剩
// body 底色、连一句报错都没有 —— 懒加载分块拉取失败就是这样把整个工作台弄没的。
type Props = { fallback: (error: Error) => ReactNode; children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

// React.lazy 会把失败的那次导入缓存住,原地重试拿到的还是同一个失败,只有重新加载页面才会
// 换一份新入口去拉新分块。
export function LoadFailure({ what, onClose }: { what: string; onClose?: () => void }) {
  return (
    <div className="workspace-load-error" role="alert">
      {what}加载失败,刷新页面后重试
      <button onClick={() => window.location.reload()}>刷新</button>
      {onClose && <button onClick={onClose}>关闭</button>}
    </div>
  );
}

// 根上的兜底:哪一块都没接住时,至少留下报错和一个刷新按钮,而不是一页空白。
export function AppCrash({ error }: { error: Error }) {
  return (
    <div className="app-crash" role="alert">
      <p>页面出错了</p>
      <pre>{error.message}</pre>
      <button onClick={() => window.location.reload()}>刷新</button>
    </div>
  );
}
