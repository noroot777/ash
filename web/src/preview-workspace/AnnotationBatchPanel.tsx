import { annotationBatchPrompt, batchStateLabels, evidenceLabels } from "@ash/shared/page-annotation-batch";
import { useAnnotationBatch } from "./useAnnotationBatch.ts";
import "./annotation-batch.css";

type BatchController = ReturnType<typeof useAnnotationBatch>;
export function AnnotationBatchPanel({ controller: c, selectedId }: { controller: BatchController; selectedId: string | null }) {
  const { batch, record } = c;
  const saved = JSON.stringify(record?.batch) === JSON.stringify(batch);
  return <div className="annotation-batch-panel">
    <p role="status">{!c.loaded ? "正在恢复批次…" : record?.messageId ? batchStateLabels[record.state] : saved ? "已保存 · 草稿" : batch ? "正在保存草稿…" : "新标注将自动保存为批次"}</p>
    {batch && <small>批次 {batch.id} · gen {batch.gen} · 服务 {batch.serviceId}</small>}
    {record?.state === "delivered" && <p>消息已进入投递队列，尚未确认开始修改。运行中的任务会先完成当前回合。</p>}
    {record?.state === "modifying" && <p>本批次已进入智能体会话，等待当前回合释放和后续消息投递完成。</p>}
    {record?.state === "reviewable" && <p>本批次已处理到可复看阶段，可重新打开预览检查。此状态不代表修改已经验收通过。</p>}
    {(c.error || record?.error) && <p role="alert" className="preview-workspace-error">{c.error || record?.error}</p>}
    {batch && !record?.messageId && <>
      <div className="annotation-batch-paste" tabIndex={0} role="group" aria-label="粘贴现场截图" onPaste={(event) => {
        const file = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"))?.getAsFile();
        if (file && selectedId && !c.locked) { event.preventDefault(); event.stopPropagation(); void c.paste(file, selectedId); }
      }}>
        <strong>粘贴现场截图（最可靠的现场图像）</strong>
        <p>{selectedId ? "点击这里后按 ⌘V / Ctrl+V，将截图附到选中的批注。" : "先选中一条标注，再在这里粘贴截图。"}</p>
        <small>页面转图可能缺少输入值、Canvas、Shadow DOM、登录态、外部图片或字体。服务端参考图是非用户现场，失败也可发送。</small>
      </div>
      <button type="button" disabled={c.locked || !batch.items.length || batch.items.some((item) => !item.comment.trim())} onClick={c.preview}>预览批次并发送</button>
    </>}
    {c.review && batch && <section className="annotation-batch-review" aria-label="发送前批次预览">
      <h4>确认发送 {batch.items.length} 条批注</h4>
      <p>沿当前任务的回复链路投递，使用任务现有执行器配置。</p>
      <ol>{batch.items.map((item) => <li key={item.id}><strong>#{item.number} {item.comment}</strong><br />
        <code>{item.context.route}</code> · {item.context.viewport.width} × {item.context.viewport.height}<br />
        滚动 {Math.round(item.context.scroll.x)}, {Math.round(item.context.scroll.y)} · {new Date(item.context.capturedAt).toLocaleString()}
      </li>)}</ol>
      <details><summary>查看将投递的完整文本</summary><pre>{annotationBatchPrompt(batch)}</pre></details>
      <button type="button" disabled={c.busy} onClick={c.cancelReview}>继续编辑</button>
      <button type="button" disabled={c.busy} onClick={() => void c.send()}>{c.busy ? "正在投递…" : "确认发送此批次"}</button>
    </section>}
    {!!batch?.evidence.length && <details open={c.review} className="annotation-batch-evidence"><summary>图像证据与缺失说明（{batch.evidence.filter((e) => e.path).length} 张图）</summary>
      {batch.evidence.map((entry) => <figure key={entry.id}>
        <figcaption>#{batch.items.find((item) => item.id === entry.annotationId)?.number} · {evidenceLabels[entry.source]}<br />{new Date(entry.capturedAt).toLocaleString()}</figcaption>
        {entry.path && <img src={`/api/uploads/${encodeURIComponent(entry.path.split(/[\\/]/).pop()!)}`} alt={`${evidenceLabels[entry.source]}，批注 ${entry.annotationId}`} loading="lazy" />}
        {!entry.path && <strong>未附图</strong>}
        <small>{entry.missing.join("；")}</small>
      </figure>)}
    </details>}
    {batch && <div className="annotation-batch-actions">
      <button type="button" disabled={c.busy || c.review} onClick={() => void c.fresh()}>新建批次</button>
      {(c.error || record?.error) && <button type="button" disabled={c.busy || c.review} onClick={() => void c.copy()}>复制草稿重试</button>}
    </div>}
    {!!c.records.length && <details><summary>已保存批次（{c.records.length}）</summary>
      {c.records.map((entry) => <button className="annotation-batch-history" type="button" key={entry.batch.id} disabled={c.busy || c.review}
        onClick={() => void c.select(entry)}>{batchStateLabels[entry.state]} · {entry.batch.items.length} 条 · {new Date(entry.batch.createdAt).toLocaleString()}</button>)}
    </details>}
  </div>;
}
