import { useId } from "react";
import { previewCommandSamples, previewPortRef, previewPortRule, wrongPortDialectHint, type PreviewPortDialect } from "@ash/shared/preview";

/**
 * 自填启动命令旁边的端口引导。
 *
 * 这块存在的理由就是一句话：**`$PORT` 的说明在设置页里，而打开预览的人不会路过设置页。**
 * 以前这儿只有一行「端口使用 ash 提供的 PORT 环境变量」——那句话读起来像「ash 会替你处理」，
 * 可它的真实意思是「你得把它写进命令」，两者差着一次撞车。
 *
 * 判据、示例、方言全部由 shared 的 preview.ts 给（设置页那边用同一份），这里只管怎么摆：
 * 判据在最上面，示例点一下就填进输入框——新用户最需要的不是读懂规则，是先拿到一条能跑的命令。
 */
export function PreviewPortGuide({ dialect, command, onFill, disabled }: {
  dialect: PreviewPortDialect;
  command: string;
  onFill: (command: string) => void;
  disabled: boolean;
}) {
  const mismatch = wrongPortDialectHint(command, dialect);
  const rule = previewPortRule(dialect);
  const samplesId = useId();
  return <div className="preview-port-guide">
    <p className="preview-port-rule">{rule.lead}</p>
    {/* 二选一摆成两行。这块的价值全在对照上——用户要判断自己的框架属于哪一半，
        而一段三行长的连续散文读不出「这是二选一」。 */}
    <dl className="preview-port-branches">
      {rule.branches.map(({ when, then }) => <div key={when}><dt>{when}</dt><dd>{then}</dd></div>)}
    </dl>
    {/* 方言写反了才出现。零误报，所以敢直接当告警摆出来（判据见 wrongPortDialectHint）。 */}
    {mismatch && <p className="preview-port-mismatch" role="alert">{mismatch}</p>}
    <div className="preview-port-samples">
      <span id={samplesId}>起手式</span>
      <div role="group" aria-labelledby={samplesId}>
        {previewCommandSamples(dialect).map((sample) => <button
          key={sample.command} type="button" disabled={disabled}
          aria-label={`填入 ${sample.label} 的启动命令：${sample.command}`}
          onClick={() => onFill(sample.command)}
        ><b>{sample.label}</b><code>{sample.command}</code></button>)}
      </div>
    </div>
    <small>
      辅助服务另有 <code>{previewPortRef("PORT2", dialect)}</code>～<code>{previewPortRef("PORT5", dialect)}</code> 和对应的{" "}
      <code>{previewPortRef("URL2", dialect)}</code>～<code>{previewPortRef("URL5", dialect)}</code>。
      各框架完整的端口写法见「设置 → 项目设置 → 预览 → 配置说明与示例」。
    </small>
  </div>;
}
