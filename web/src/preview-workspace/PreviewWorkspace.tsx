import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowUUpLeft, Browser, Cursor, PencilSimple, PushPin, Rectangle, Trash, X } from "@phosphor-icons/react";
import type { PreviewAnnotation, PreviewAnnotationEvent, PreviewAnnotationTool, PreviewPageContext } from "@ash/shared/page-annotation";
import { usePreviewChannel } from "./usePreviewChannel.ts";
import { usePreviewServices } from "./usePreviewServices.ts";
import { useAnnotationBatch } from "./useAnnotationBatch.ts";
import { AnnotationBatchPanel } from "./AnnotationBatchPanel.tsx";
import type { AnnotationDraft as Draft } from "@ash/shared/page-annotation-batch";
import "./preview-workspace.css";

const tools = [
  { id: "element", label: "点选", icon: Cursor },
  { id: "rectangle", label: "矩形", icon: Rectangle },
  { id: "pen", label: "画笔", icon: PencilSimple },
  { id: "pin", label: "Pin", icon: PushPin },
] satisfies Array<{ id: PreviewAnnotationTool; label: string; icon: typeof Cursor }>;
const labels: Record<PreviewAnnotationTool, string> = { element: "元素", rectangle: "矩形", pen: "画笔", pin: "位置" };

export function PreviewWorkspaceEntry({ onOpen }: { onOpen: () => void }) {
  return <div className="preview-workspace-entry">
    <Browser size={28} />
    <h3>在页面上指出修改位置</h3>
    <p>打开正在运行的预览，点选对象或圈画区域，再逐条填写意见。</p>
    <button type="button" onClick={onOpen}>打开预览工作区</button>
    <small>标注自动保存为批次，发送前可预览内容与图像证据。</small>
  </div>;
}

export function PreviewWorkspace({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { state, error: serviceError } = usePreviewServices(taskId);
  const [serviceId, setServiceId] = useState("");
  const [reload, setReload] = useState(0);
  const batch = useAnnotationBatch(taskId);
  const items = batch.batch?.items ?? [];
  const setItems = batch.setItems;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canSelectParent, setCanSelectParent] = useState(false);
  const [page, setPage] = useState<PreviewPageContext | null>(null);
  const [error, setError] = useState("");
  const services = state?.services ?? [];
  const available = services.filter((service) => service.status === "ready" && service.url);
  const activeService = available.find((service) => service.id === serviceId) ?? available[0];
  const gateway = activeService && state?.proxied
    ? `/api/tasks/${encodeURIComponent(taskId)}/preview/open/${encodeURIComponent(activeService.id)}` : null;
  const source = gateway ? `${gateway}?workspace=${encodeURIComponent(state?.startedAt ?? "")}&reload=${reload}` : null;
  const matchingBatch = !batch.batch || (batch.batch.gen === state?.gen && batch.batch.serviceId === activeService?.id);
  const canAnnotate = !batch.locked && matchingBatch && !!state?.gen;
  const nextNumber = items.reduce((max, item) => Math.max(max, item.number + 1), 1);
  const receive = (event: PreviewAnnotationEvent, documentId: string) => {
    if (event.type === "ready" || event.type === "context") {
      setPage(event.context);
      if (event.type === "ready") setError("");
    } else if (event.type === "error") setError(event.message);
    else if (event.type === "image") batch.pageImage(event.id, event.image);
    else if (event.type === "annotation") {
      const current = itemsRef.current;
      const existing = current.find((item) => item.id === event.annotation.id && item.documentId === documentId);
      if (batch.locked || !matchingBatch || (!existing && current.length >= 100)) {
        channel.send({ type: "remove", id: event.annotation.id });
        channel.send({ type: "configure", mode: "browse", tool: channel.tool });
        return;
      }
      batch.receive(event.annotation, documentId, state?.gen ?? "", activeService?.id ?? "");
      setSelectedId(event.annotation.id); setCanSelectParent(event.canSelectParent);
    } else if (event.type === "selection") {
      setSelectedId(event.id); setCanSelectParent(event.canSelectParent);
    }
  };
  const channel = usePreviewChannel(source, nextNumber, receive);
  const previousBatchId = useRef<string | undefined>(undefined);
  useEffect(() => { if (!canAnnotate) channel.send({ type: "configure", mode: "browse", tool: channel.tool }); }, [canAnnotate]);
  useEffect(() => {
    if (previousBatchId.current) { setSelectedId(null); channel.send({ type: "clear" }); }
    previousBatchId.current = batch.batch?.id;
  }, [batch.batch?.id]);
  useEffect(() => { setPage(null); setError(""); setCanSelectParent(false); }, [source]);
  const selected = items.find((item) => item.id === selectedId);
  const currentSelection = selected?.documentId === channel.documentId && selected.serviceId === activeService?.id && selected.context.route === page?.route;
  const ready = !!source && channel.phase === "ready";
  const changeTool = (tool: PreviewAnnotationTool) => channel.send({ type: "configure", mode: "annotate", tool });
  const removeItem = (item: Draft) => {
    if (item.documentId === channel.documentId) channel.send({ type: "remove", id: item.id });
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    if (selectedId === item.id) { setSelectedId(null); setCanSelectParent(false); }
  };

  return <section className="preview-workspace" aria-label="预览工作区">
    <header className="preview-workspace-header">
      <Browser size={20} /><div><h2>预览工作区</h2><p>在真实页面上点选、圈画，留下修改意见</p></div>
      <button type="button" aria-label="关闭预览工作区" onClick={onClose}><X size={16} /></button>
    </header>
    <div className="preview-workspace-toolbar">
      <div className="preview-workspace-modes" aria-label="预览模式">
        <button type="button" disabled={!ready} aria-pressed={channel.mode === "browse"}
          onClick={() => channel.send({ type: "configure", mode: "browse", tool: channel.tool })}>浏览</button>
        <button type="button" disabled={!ready || !canAnnotate || items.length >= 100} aria-pressed={channel.mode === "annotate"}
          onClick={() => channel.send({ type: "configure", mode: "annotate", tool: channel.tool })}>标注</button>
      </div>
      <div className="preview-workspace-tools" aria-label="标注工具">
        {tools.map(({ id, label, icon: Icon }) => <button type="button" key={id} disabled={!ready || !canAnnotate || items.length >= 100}
          aria-pressed={channel.mode === "annotate" && channel.tool === id} onClick={() => changeTool(id)}><Icon size={14} />{label}</button>)}
      </div>
      <button type="button" disabled={!ready || !canAnnotate || !currentSelection || !canSelectParent} onClick={() => channel.send({ type: "parent" })}>
        <ArrowUUpLeft size={14} />父容器
      </button>
      <label className="preview-workspace-service">服务<select aria-label="预览服务" value={activeService?.id ?? ""}
        disabled={!available.length} onChange={(event) => setServiceId(event.target.value)}>
        {!available.length && <option value="">暂无运行中的服务</option>}
        {available.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
      </select></label>
      <button type="button" disabled={!source} onClick={() => setReload((value) => value + 1)}><ArrowClockwise size={14} />重载</button>
    </div>
    <p className={`preview-workspace-mode-note${channel.mode === "annotate" && ready ? " is-annotating" : ""}`} role="status">
      {items.length >= 100 ? "已暂存 100 条标注，请删除部分标注后继续。" : ready
        ? channel.mode === "annotate" ? "标注中 · 点击只选择对象；页面操作已拦截。滚轮可滚动，父容器可逐层上选。" : "浏览中 · 可以正常操作页面；切换到标注后再选择修改位置。"
        : "等待预览连接，连接成功后可切换浏览与标注。"}
    </p>
    {(error || serviceError) && <p className="preview-workspace-error" role="alert">{error || serviceError}</p>}
    <div className="preview-workspace-body">
      <div className="preview-workspace-stage">
        {source ? <>
          <iframe key={source} ref={channel.iframeRef} src={source} title="任务页面预览"
            sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-popups"
            referrerPolicy="no-referrer" onLoad={channel.connect} />
          {!ready && <div className="preview-workspace-connection" role="status">
            <strong>{channel.phase === "failed" ? "未能连接页面标注" : channel.phase === "switching" ? "正在切换模式…" : "正在连接预览…"}</strong>
            {channel.phase === "failed" && <><p>页面可能已跳转或不支持标注。重载后重试，也可回到回复框使用截图批注。</p>
              <button type="button" onClick={() => setReload((value) => value + 1)}>重载预览</button></>}
          </div>}
        </> : <div className="preview-workspace-empty">
          <Browser size={36} />
          <h3>{state?.starting ? "预览正在启动" : state?.running && !state.proxied ? "此预览使用直连地址" : "尚无可内嵌的预览"}</h3>
          <p>{state?.running && !state.proxied ? "请在项目预览设置中启用代理访问，再重新打开预览。"
            : "先通过任务的预览入口启动服务。已有标注会继续显示在右侧。"}</p>
          <small>也可回到回复框使用截图批注。</small>
        </div>}
        {page && <footer className="preview-workspace-context">
          <code>{page.route}</code><span>{Math.round(page.viewport.width)} × {Math.round(page.viewport.height)} · 滚动 {Math.round(page.scroll.x)}, {Math.round(page.scroll.y)} · {page.viewport.scale.toFixed(2)}×</span>
        </footer>}
      </div>
      <aside className="preview-workspace-notes" aria-label="页面标注列表">
        <div className="preview-workspace-notes-heading"><h3>标注</h3><span>{items.length} / 100</span></div>
        <p className="preview-workspace-memory">{matchingBatch ? "创建时记录页面上下文 · 自动保存草稿" : "当前批次来自其它预览或服务；新建批次后可继续标注"}</p>
        {!items.length && <p className="preview-workspace-hint">选择「点选」后点击页面上的图标或按钮。编号会出现在页面和这里，再用「父容器」扩大选择范围。</p>}
        <ol className="preview-workspace-list">
          {items.map((item) => <li key={item.id}>
            <button type="button" aria-pressed={item.id === selectedId} className="preview-workspace-item" onClick={() => {
              setSelectedId(item.id); setCanSelectParent(false);
              if (item.documentId === channel.documentId && ready) channel.send({ type: "focus", id: item.id });
            }}><b>{item.number}</b><span><strong>{item.element ? `<${item.element.tag}> ${item.element.text || labels[item.tool]}` : labels[item.tool]}</strong>
              <small>{item.comment || item.context.route}</small></span></button>
          </li>)}
        </ol>
        {selected && <div className="preview-workspace-detail">
          <label>#{selected.number} 修改意见<textarea disabled={batch.locked} value={selected.comment} maxLength={4000} placeholder="希望这里怎么改？"
            onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, comment: event.target.value } : item))} /></label>
          {!currentSelection && <p className="preview-workspace-memory">这是之前页面的标注，元素信息保留创建时的内容。</p>}
          <p className="preview-workspace-coordinates">{selected.context.route}<br />视口 {selected.context.viewport.width} × {selected.context.viewport.height}
            <br />滚动 {Math.round(selected.context.scroll.x)}, {Math.round(selected.context.scroll.y)} · {new Date(selected.context.capturedAt).toLocaleTimeString()}
            <br />文档坐标 {Math.round(selected.points[0].x)}, {Math.round(selected.points[0].y)} · {selected.points.length} 个点</p>
          {selected.element && <ElementDetails card={selected.element} />}
          <button type="button" className="preview-workspace-remove" disabled={batch.locked} onClick={() => removeItem(selected)}><Trash size={13} />删除此标注</button>
        </div>}
        <AnnotationBatchPanel controller={batch} selectedId={selectedId} />
      </aside>
    </div>
  </section>;
}

function ElementDetails({ card }: { card: NonNullable<PreviewAnnotation["element"]> }) {
  return <div className="preview-element-card">
    <h4>元素卡片</h4>
    <p><code>&lt;{card.tag}&gt;</code>{card.role && ` · ${card.role}`} · {Math.round(card.rect.width)} × {Math.round(card.rect.height)} px</p>
    {card.text && <p>{card.text}</p>}
    <details open><summary>候选 selector</summary>{card.selectors.map((selector, index) => <code key={index}>{selector}</code>)}</details>
    <details><summary>祖先摘要</summary>{card.ancestors.map((ancestor, index) => <p key={index}><code>{ancestor.selector}</code>{ancestor.role && ` · ${ancestor.role}`}</p>)}</details>
    <details><summary>关键样式</summary><dl>{Object.entries(card.computedStyle).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details>
    <details><summary>HTML 摘要（已脱敏、截断）</summary><pre>{card.outerHTML}</pre></details>
  </div>;
}
