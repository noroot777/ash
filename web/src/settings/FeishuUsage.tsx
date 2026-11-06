import type { FeishuStatus, ImApiKind } from "@ash/shared";
import { API_KIND_LABELS, QUOTA_LEVELS } from "./feishuText.ts";

// 本月调用额度与发件积压。只有管理员拿得到（非管理员 usage/outbox 为 null，不渲染）。
//
// 水位四档全列出来而不是只写当前那一档：用户最常问的是「为什么这张通知没来」，答案往往是
// 「额度到了 90%，完成通知不发了」——只给当前档，他看不出下一档会少什么，也看不出是哪一档
// 把那条通知砍掉的。

const KIND_ORDER: readonly ImApiKind[] = ["send", "patch", "reaction", "info", "download", "token"];

export function FeishuUsage({ usage, outbox }: {
  usage: NonNullable<FeishuStatus["usage"]>;
  outbox: FeishuStatus["outbox"];
}) {
  const ratio = usage.quota > 0 ? usage.calls / usage.quota : 1;
  const percent = Math.min(100, Math.round(ratio * 1000) / 10);
  const current = QUOTA_LEVELS.find((item) => item.level === usage.level) ?? QUOTA_LEVELS[0];
  const kinds = KIND_ORDER.filter((kind) => (usage.byKind[kind] ?? 0) > 0);
  return (
    <>
      <div className="settings-row feishu-usage">
        <div>
          <b>本月调用额度（{usage.month}）</b>
          <small>
            按自然月（北京时间）计。飞书开放平台没有查询额度的接口，这里是 ash 自己记的次数，
            上限照「推送」卡里填的月额度；以开发者后台的用量页为准。
          </small>
        </div>
        <span className="feishu-usage-figure">
          <b>{usage.calls.toLocaleString("zh-CN")}</b> / {usage.quota.toLocaleString("zh-CN")}
          <em>（{percent}%）</em>
        </span>
      </div>
      <div className="feishu-meter" role="meter" aria-label="本月调用额度用量" aria-valuemin={0} aria-valuemax={usage.quota} aria-valuenow={usage.calls}>
        <i data-level={usage.level} style={{ width: `${percent}%` }} />
      </div>
      <div className="feishu-levels" aria-label="额度水位">
        {QUOTA_LEVELS.map((item) => (
          <div key={item.level} className={item.level === current.level ? "is-current" : ""} data-level={item.level}>
            <b>{item.label}<em>{item.threshold}</em></b>
            <span>{item.effect}</span>
            {item.level === current.level && <strong className="feishu-level-now">当前</strong>}
          </div>
        ))}
      </div>
      <details className="feishu-kinds">
        <summary>按调用种类看明细</summary>
        {kinds.length ? (
          <table>
            <tbody>
              {kinds.map((kind) => (
                <tr key={kind}>
                  <th scope="row">{API_KIND_LABELS[kind]}</th>
                  <td>{(usage.byKind[kind] ?? 0).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="settings-muted">本月还没有调用。</p>
        )}
        <p className="feishu-kinds-note">额度吃紧时按「表情回执 → 改卡片 → 查询信息 → 发消息」的顺序先砍不要紧的。</p>
      </details>
      {outbox && (
        <div className="settings-row">
          <div>
            <b>发件积压</b>
            <small>
              {outbox.dead > 0
                ? "「已放弃」是重试多次仍发不出去的消息，不会再发；对应的事要回网页处理。"
                : "要推的卡片先进发件表，再按飞书的限流一条条发出去；发不出去的会重试。"}
            </small>
          </div>
          <span className={outbox.dead > 0 ? "feishu-outbox is-dead" : "feishu-outbox"}>
            待发 {outbox.pending} 条 · 已放弃 {outbox.dead} 条
          </span>
        </div>
      )}
    </>
  );
}
