import { useEffect, useRef, useState } from "react";
import type { PreviewAnnotation, PreviewPageImage } from "@ash/shared/page-annotation";
import type { AnnotationBatch, AnnotationBatchRecord, AnnotationDraft, AnnotationEvidence } from "@ash/shared/page-annotation-batch";
import { pageImageMissing, parseAnnotationBatch } from "@ash/shared/page-annotation-batch";
import { api } from "../lib/api.ts";
import { json, request } from "../lib/apiClient.ts";
import { readImageData } from "../page-annotation/image.ts";
import { useServerEvents } from "../lib/events.ts";
import { annotationFollowup, mergeAnnotationRecord } from "./annotationFollowup.ts";
import { createClientId } from "../lib/clientId.ts";

const uid = createClientId;
export function useAnnotationBatch(taskId: string) {
  const [batch, setBatch] = useState<AnnotationBatch | null>(null);
  const current = useRef(batch);
  const [records, setRecords] = useState<AnnotationBatchRecord[]>([]);
  const cache = useRef(new Map<string, AnnotationBatchRecord>());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const frozen = useRef(false);
  const uploads = useRef(new Set<string>());
  const mounted = useRef(true);
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const refreshRef = useRef<() => void>(() => {});
  const eventVersion = useRef(0);
  useServerEvents((event) => {
    if ("taskId" in event && event.taskId === taskId && ["task.pendingMessages", "task.status"].includes(event.type)) {
      eventVersion.current++;
      setRecords((list) => list.map((r) => r.state === "reviewable" ? { ...r, state: "modifying" } : r));
      refreshRef.current();
    }
  });
  const key = `ash.annotation-batch.${taskId}`;
  const remember = (record: AnnotationBatchRecord) => {
    if (record.batch.taskId !== taskId) return;
    cache.current.set(record.batch.id, record);
    if (mounted.current) setRecords((list) => [record, ...list.filter((r) => r.batch.id !== record.batch.id)]);
  };
  const update = (next: AnnotationBatch | null) => {
    current.current = next;
    if (mounted.current) setBatch(next);
    try { if (next) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key); }
    catch { if (mounted.current) setError("浏览器草稿缓存已满；请检查服务端保存状态后再关闭。"); }
  };
  const change = (fn: (value: AnnotationBatch) => AnnotationBatch) => {
    if (!current.current || frozen.current) return;
    update(fn(current.current));
  };
  const save = (snapshot = current.current): Promise<AnnotationBatchRecord | null> => {
    if (!snapshot) return Promise.resolve(null);
    const work = tail.current.catch(() => {}).then(async () => {
      const previous = cache.current.get(snapshot.id);
      if (previous?.messageId || JSON.stringify(previous?.batch) === JSON.stringify(snapshot)) return previous ?? null;
      const result = await request<AnnotationBatchRecord>(`/tasks/${encodeURIComponent(taskId)}/annotation-batches/${encodeURIComponent(snapshot.id)}`,
        json("PUT", { batch: snapshot, revision: (previous?.revision ?? 0) + 1 }));
      remember(result);
      if (mounted.current) setError("");
      return result;
    });
    tail.current = work;
    return work;
  };
  useEffect(() => {
    mounted.current = true;
    let polling = false, initialized = false, active = true;
    const load = async () => {
      if (polling) return;
      polling = true;
      const version = eventVersion.current;
      try {
        const list = await request<AnnotationBatchRecord[]>(`/tasks/${encodeURIComponent(taskId)}/annotation-batches`);
        if (!active || version !== eventVersion.current) return;
        const merged = list.map((record) => {
          const known = cache.current.get(record.batch.id);
          const merged = mergeAnnotationRecord(known, record);
          if (merged !== record) return merged;
          if (!known || record.messageId || (record.batch.id !== current.current?.id && record.revision >= known.revision)) cache.current.set(record.batch.id, record);
          return record;
        });
        setRecords(merged);
        if (!initialized) {
          let local: AnnotationBatch | null = null;
          try { local = parseAnnotationBatch(JSON.parse(localStorage.getItem(key) ?? "null")); if (local.taskId !== taskId) local = null; } catch { /* No local draft. */ }
          const remote = local && list.find((r) => r.batch.id === local.id);
          update(remote?.messageId ? remote.batch : local ?? list.find((r) => !r.messageId)?.batch ?? list[0]?.batch ?? null);
          initialized = true; setLoaded(true);
        }
      } catch (reason) { if (mounted.current) setError(String(reason)); }
      finally { polling = false; }
    };
    refreshRef.current = () => void load();
    void load();
    const timer = window.setInterval(() => void load(), 2500);
    return () => { active = false; mounted.current = false; refreshRef.current = () => {}; window.clearInterval(timer); };
  }, [taskId]);
  useEffect(() => {
    if (!loaded || !batch || frozen.current) return;
    const timer = window.setTimeout(() => void save(batch).catch((reason) => setError(`保存失败，草稿保留：${String(reason)}`)), 350);
    return () => window.clearTimeout(timer);
  }, [batch, loaded]);
  const record = batch ? records.find((r) => r.batch.id === batch.id) : undefined;
  const locked = !loaded || busy || review || !!record?.messageId;
  frozen.current = locked;
  const acceptImage = async (batchId: string, annotationId: string, source: AnnotationEvidence["source"], image: PreviewPageImage, expectedAt: number) => {
    if (frozen.current || current.current?.id !== batchId) return;
    const identity = `${batchId}:${annotationId}:${source}:${image.capturedAt}`;
    if (uploads.current.has(identity)) return;
    uploads.current.add(identity);
    const evidence: AnnotationEvidence = { id: `${source}-${annotationId}`, annotationId, source, capturedAt: image.capturedAt, missing: image.missing };
    try {
      if (image.dataUrl) evidence.path = (await api.uploadFile(image.dataUrl, `${source}-${annotationId}.png`)).path;
    } catch { evidence.missing = [...evidence.missing, "图像上传失败；文字批注仍可发送"]; }
    if (!mounted.current || frozen.current || current.current?.id !== batchId
      || !current.current.items.some((item) => item.id === annotationId && item.context.capturedAt === expectedAt)) return;
    change((value) => ({ ...value, evidence: value.evidence.map((old) => old.id === evidence.id ? evidence : old) }));
  };
  const receive = (annotation: PreviewAnnotation, documentId: string, gen: string, serviceId: string) => {
    if (frozen.current || !gen || !serviceId) return;
    let value = current.current;
    if (!value) value = { id: uid(), taskId, createdAt: Date.now(), gen, serviceId, items: [], evidence: [] };
    if (value.gen !== gen || value.serviceId !== serviceId) { setError("当前批次属于另一预览或服务，请先新建批次。"); return; }
    const old = value.items.find((item) => item.id === annotation.id);
    const item: AnnotationDraft = { ...annotation, gen, serviceId, documentId, comment: old?.comment ?? "" };
    const evidence = (["page-render", "headless-reference"] as const).map((source): AnnotationEvidence => ({
      id: `${source}-${item.id}`, annotationId: item.id, source, capturedAt: item.context.capturedAt,
      missing: [...(source === "page-render" ? pageImageMissing : ["非用户现场，无用户登录凭证"]), "图像尚未就绪；发送时未就绪则仅保留缺失说明"],
    }));
    value = parseAnnotationBatch({ ...value, items: old ? value.items.map((entry) => entry.id === item.id ? item : entry) : [...value.items, item],
      evidence: [...value.evidence.filter((entry) => entry.annotationId !== item.id || entry.source === "user-paste"), ...evidence] });
    update(value);
    const batchId = value.id;
    void request<PreviewPageImage>(`/tasks/${encodeURIComponent(taskId)}/annotation-reference`, json("POST", { gen, serviceId,
      route: item.context.route, viewport: item.context.viewport, scroll: item.context.scroll }))
      .then((image) => acceptImage(batchId, item.id, "headless-reference", image, item.context.capturedAt))
      .catch(() => acceptImage(batchId, item.id, "headless-reference", { capturedAt: Date.now(), missing: ["参考渲染不可用；非用户现场，发送不受影响"] }, item.context.capturedAt));
  };
  const pageImage = (id: string, image: PreviewPageImage) => {
    const value = current.current;
    if (value?.items.some((item) => item.id === id && item.context.capturedAt === image.capturedAt)) void acceptImage(value.id, id, "page-render", image, image.capturedAt);
  };
  const paste = async (file: File, annotationId: string) => {
    if (frozen.current || !current.current) return;
    if (file.size > 5 * 1024 * 1024) { setError("截图超过 5 MB，请裁剪后粘贴。"); return; }
    const batchId = current.current.id, capturedAt = Date.now();
    setBusy(true); frozen.current = true;
    try {
      const attachment = await api.uploadFile(await readImageData(file), file.name || "现场截图.png");
      if (current.current?.id === batchId) update({ ...current.current, evidence: [...current.current.evidence,
        { id: uid(), annotationId, source: "user-paste", capturedAt, path: attachment.path, missing: ["时间为用户粘贴时刻，原截图拍摄时刻未知"] }] });
    } catch (reason) { setError(`截图上传失败：${String(reason)}`); }
    finally { setBusy(false); frozen.current = false; }
  };
  const send = async () => {
    if (busy || !review || !current.current || record?.messageId) return;
    setBusy(true); frozen.current = true;
    try {
      const saved = await save();
      if (!saved) return;
      const result = await request<{ annotationBatch: AnnotationBatchRecord }>(`/tasks/${encodeURIComponent(taskId)}/reply`,
        json("POST", { annotationBatchId: saved.batch.id, annotationRevision: saved.revision }));
      remember(result.annotationBatch); setReview(false); setError("");
    } catch (reason) { setError(`发送未确认，草稿保留；重试会复用同一批次：${String(reason)}`); }
    finally { setBusy(false); }
  };
  const select = async (next: AnnotationBatch | null) => {
    if (busy || review) return;
    setBusy(true); frozen.current = true;
    try { await save(); update(next); setError(""); }
    catch (reason) { setError(`请先保存当前草稿：${String(reason)}`); }
    finally { setBusy(false); }
  };
  return { batch, record, records, loaded, busy, locked, review, error, receive, pageImage, paste, send, remember,
    followup: async (source: AnnotationBatch, item: AnnotationDraft, comment: string) => {
      if (source.taskId !== taskId || !comment.trim() || busy || review) return false;
      setBusy(true); frozen.current = true;
      try {
        await save();
        const next = annotationFollowup(source, item, comment.trim(), uid());
        update(next); await save(next); setError(""); return true;
      } catch (reason) { setError(`新批次保存失败，草稿保留：${String(reason)}`); return false; }
      finally { setBusy(false); }
    },
    preview: () => { if (!locked && batch?.items.length) { frozen.current = true; setReview(true); } },
    cancelReview: () => { if (!busy) { setReview(false); frozen.current = false; } },
    select: (record: AnnotationBatchRecord) => select(record.batch),
    fresh: () => select(null),
    copy: () => { if (!busy && !review && batch) { update({ ...batch, id: uid(), createdAt: Date.now() }); setError(""); } },
    setItems: (fn: (items: AnnotationDraft[]) => AnnotationDraft[]) => change((value) => {
      const items = fn(value.items);
      return { ...value, items, evidence: value.evidence.filter((entry) => items.some((item) => item.id === entry.annotationId)) };
    }),
  };
}
