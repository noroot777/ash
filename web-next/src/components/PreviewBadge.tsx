/**
 * 「你看的是预览实例」的角标。
 *
 * 预览起的是这个分支的**整套**——它自己的后端、自己的空库（见 `scripts/dev.mjs`），
 * 所以任务列表跟你平时那份不是一回事。不说清楚，第一反应会是「我的任务怎么没了」，
 * 那比不显示更糟。
 *
 * 标记由 dev.mjs 起 vite 时用 `VITE_HARNESS_PREVIEW` 递进来：「这个前端是谁起的」属于
 * 启动期的事实，不必绕后端问一趟，也就不会出现「后端还没起来所以角标先不显示」。
 */
export function PreviewBadge() {
  const label = import.meta.env.VITE_HARNESS_PREVIEW;
  if (!label) return null;
  return (
    <div className="preview-badge" role="status">
      {label}
    </div>
  );
}
