import { useState } from "react";
import { Warning, Copy, Check } from "@phosphor-icons/react";
import type { PreviewServiceState } from "@ash/shared/preview";
import { previewPortDrift, previewPortRef, type PreviewPortDialect } from "@ash/shared/preview";

/**
 * 「这次预览起在 5173，不是 ash 借的 45843。」
 *
 * 这条跟填字时那些提示**不是一类东西**：那些是说明（用户可以不读，而且多半不读），这条是
 * 已经发生的事实。它零误报、不挑语言，而且**命令写对时根本不出现**——所以它敢占版面，也
 * 不会变成背景噪音。判读在 shared 的 previewPortDrift，这里只管怎么摆和给什么动作。
 *
 * 动作分两档，由 `fixed` 是不是 null 决定，这一刀很要紧：
 *   · 端口写在命令里 → 把那个数字换成 $PORT 是一次**确定的改写**（那个数字就是它实际绑上
 *     的端口，不是猜的），所以敢给整行命令让他复制走。
 *   · 端口写在配置文件里（vite.config.ts / application.yml…）→ ash 编不出改法，就老实说
 *     「它不在这条命令里」。编一条看着像对的命令比不给更坏。
 *
 * 可以关掉：预览照常能用，用户有权让服务听一个固定端口。关掉只管这一次（不落盘）——
 * 下次真撞上了还是该提醒他。
 */
export function PreviewPortDriftNotice({ services, dialect }: {
  services: readonly PreviewServiceState[];
  dialect: PreviewPortDialect;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [copied, setCopied] = useState("");
  const drifts = previewPortDrift(services, dialect).filter((drift) => !dismissed.includes(drift.serviceId));
  if (!drifts.length) return null;
  const copy = async (drift: { serviceId: string; fixed: string | null }) => {
    if (!drift.fixed) return;
    try {
      await navigator.clipboard.writeText(drift.fixed);
      setCopied(drift.serviceId);
      window.setTimeout(() => setCopied((current) => current === drift.serviceId ? "" : current), 2000);
    } catch { /* 浏览器不给剪贴板时命令仍在页面上，选中复制即可。 */ }
  };
  return <div className="preview-port-drift" role="status">
    {drifts.map((drift) => <div key={drift.serviceId} className="preview-port-drift-item">
      <Warning size={15} aria-hidden="true" />
      <div>
        <b>{services.length > 1 ? `${drift.serviceName}：` : ""}这次预览起在 {drift.actual}，不是 ash 借给它的 {drift.lent}。</b>
        <small>能接上是因为 ash 照日志里印的地址接的。但端口是命令自己定死的：同一个项目再开一份预览、或者你本机已经有一份在跑，两边就会抢 {drift.actual}。</small>
        {drift.fixed
          ? <>
            <small>命令里那个 {drift.actual} 换成 {previewPortRef("PORT", dialect)} 就错得开：</small>
            <div className="preview-port-drift-fix">
              <code>{drift.fixed}</code>
              <button type="button" onClick={() => void copy(drift)} aria-label={`复制改好的启动命令：${drift.fixed}`}>
                {copied === drift.serviceId ? <><Check size={13} aria-hidden="true" />已复制</> : <><Copy size={13} aria-hidden="true" />复制</>}
              </button>
            </div>
            <small>把它存进「设置 → 项目设置 → 预览」，以后这个项目就不用再想这件事。</small>
          </>
          : <small>
            {drift.actual} 不在这条启动命令里，它来自项目的配置文件（vite.config.ts、application.yml 之类）。
            改法是让那处读 ash 给的端口，或者在启动命令上追加覆盖参数（例如 <code>--port {previewPortRef("PORT", dialect)}</code>）。
          </small>}
      </div>
      <button type="button" className="preview-port-drift-dismiss" onClick={() => setDismissed([...dismissed, drift.serviceId])}
        aria-label={`知道了，不再提示 ${drift.serviceName} 的端口`}>知道了</button>
    </div>)}
  </div>;
}
