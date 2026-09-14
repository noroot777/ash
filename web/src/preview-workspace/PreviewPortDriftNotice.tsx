import { useEffect, useState } from "react";
import { Warning, Copy, Check } from "@phosphor-icons/react";
import type { PreviewServiceState } from "@ash/shared/preview";
import { previewPortDrift, previewPortRef, type PreviewPortDialect, type PreviewPortDrift } from "@ash/shared/preview";

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
 * 可以关掉：预览照常能用，用户有权让服务听一个固定端口。**但一次关闭只活到它关掉的那条
 * 事实还在为止**——第 1 轮审查 P1 记的就是这里：dismiss 原先只按服务 id 存，而这个组件在
 * 页面里一直挂着不卸载，于是点一次「知道了」等于「这个服务这辈子别再提」，下一趟重开预览
 * 再漂移也被自己吞了。现在两道一起管：key 里带上「哪一趟（gen）、借的哪个、实际哪个」，
 * 并且那条漂移一消失就把这次关闭作废（见下面的 effect）。
 */
export function PreviewPortDriftNotice({ services, dialect, gen }: {
  services: readonly PreviewServiceState[];
  dialect: PreviewPortDialect;
  /** 这一趟预览的代次；换一趟就是换一条事实，先前关掉的不算数。 */
  gen?: string | null;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [copied, setCopied] = useState("");
  const scope = (drift: PreviewPortDrift) => `${gen ?? ""}:${drift.serviceId}:${drift.lent}:${drift.actual}`;
  const all = previewPortDrift(services, dialect);
  const live = all.map(scope);
  // 一次关闭只活到**它关掉的那条事实还在**为止。这条漂移一旦不在了（预览重开、命令改对、
  // 服务停掉），这次关闭当场作废；以后再出现就是又一次事实，得重新提醒——这正是上面那句
  // 「关掉只管眼前这一条」的落点，光靠 key 里带 gen 是不够的（同一趟里它消失又回来，
  // key 没变，会被自己吞掉）。清理放在 effect 里：它在渲染之后跑，那时那条漂移确实不在了，
  // 所以不会误删一条正活着的关闭记录。
  const liveKey = live.join("|");
  useEffect(() => {
    setDismissed((current) => {
      const kept = current.filter((key) => live.includes(key));
      return kept.length === current.length ? current : kept;
    });
    // 依赖只写 liveKey：它和 live 同源（就是它 join 出来的），拿字符串当依赖才不会因为
    // 每次渲染都新建数组而白跑一遍。返回原引用是为了「没变化就不触发重渲染」。
  }, [liveKey]);
  const drifts = all.filter((drift) => !dismissed.includes(scope(drift)));
  const copy = async (drift: PreviewPortDrift) => {
    if (!drift.fixed) return;
    try {
      await navigator.clipboard.writeText(drift.fixed);
      setCopied(drift.serviceId);
      window.setTimeout(() => setCopied((current) => current === drift.serviceId ? "" : current), 2000);
    } catch { /* 浏览器不给剪贴板时命令仍在页面上，选中复制即可。 */ }
  };
  if (!drifts.length) return null;
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
      <button type="button" className="preview-port-drift-dismiss" onClick={() => setDismissed([...dismissed, scope(drift)])}
        aria-label={`知道了，不再提示 ${drift.serviceName} 的端口`}>知道了</button>
    </div>)}
  </div>;
}
