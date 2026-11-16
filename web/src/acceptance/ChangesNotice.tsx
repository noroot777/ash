import { SpinnerGap } from "@phosphor-icons/react";

/**
 * 走向与 diff 没有「这一版」时说什么（数据来自 useVersionedRead）。顶行那一格：还在读就转圈，
 * 读失败就说出来并给「重试」—— 上一版的走向绝不顶替上来（它指的目标可能已经不是这一按会合的那个）。
 */
export function ChangesLeadNote({ loading, error, retry }: { loading: boolean; error: string | null; retry: () => void }) {
  if (error) {
    return (
      <span className="acc-lead-note is-error">
        改动读不出来
        <button type="button" className="acc-btn is-sm" onClick={retry}>重试</button>
      </span>
    );
  }
  if (loading) return <span className="acc-lead-note"><SpinnerGap size={12} className="is-spinning" aria-hidden="true" />汇总改动</span>;
  return null;
}

/**
 * diff 区头上那一句：只在这一版读失败时出现 —— 下面若还摆着上一版就明说是上一版，并给本行重试。
 * 还在重读时不出字（每次任务更新都会重读一趟，出字就是一闪一闪的噪音），由宿主把上一版压暗、
 * 顶行转圈来表示「这不是当前的」。
 */
export function ChangesNote({ stale, error, retry }: { stale: boolean; error: string | null; retry: () => void }) {
  if (!error) return null;
  return (
    <p className="acc-changes-note" role="status">
      <span>{stale ? `最新改动读不出来，下面是上一版：${error}` : `改动读不出来：${error}`}</span>
      <button type="button" className="acc-btn is-sm" onClick={retry}>重试</button>
    </p>
  );
}
