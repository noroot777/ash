import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, ReviewerProfile } from "@harness/shared";
import { MagnifyingGlass, Plus, Trash, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import {
  createReviewerDraft,
  ReviewerProfileFields,
  reviewerDraft,
  reviewerPayload,
  type ReviewerDraft,
} from "../free-workflow/ReviewerProfileFields.tsx";

export function ReviewerProfilesSettings({ notify }: { notify: (message: string) => void }) {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [reviewers, setReviewers] = useState<ReviewerProfile[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReviewerDraft>(() => createReviewerDraft());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ReviewerProfile | null>(null);
  const types = useMemo(() => registeredAgentTypes(profiles), [profiles]);

  const select = (reviewer: ReviewerProfile) => {
    setEditingId(reviewer.id);
    setDraft(reviewerDraft(reviewer));
  };

  const startNew = (known = profiles) => {
    setEditingId(null);
    setDraft(createReviewerDraft(known));
  };

  const load = () => {
    setLoading(true);
    setFailed(false);
    Promise.all([api.reviewerProfiles(), api.agents()]).then(([nextReviewers, nextProfiles]) => {
      setReviewers(nextReviewers);
      setProfiles(nextProfiles);
      if (nextReviewers[0]) select(nextReviewers[0]);
      else startNew(nextProfiles);
    }).catch((error) => {
      setFailed(true);
      notify(error instanceof Error ? error.message : "审查者读取失败");
    }).finally(() => setLoading(false));
  };

  useEffect(load, [notify]);

  const save = async () => {
    if (!draft.name.trim() || busy) return;
    setBusy(true);
    try {
      const payload = reviewerPayload(draft, profiles);
      const saved = editingId
        ? await api.patchReviewerProfile(editingId, payload)
        : await api.createReviewerProfile(payload);
      setReviewers((current) => editingId
        ? current.map((reviewer) => reviewer.id === saved.id ? saved : reviewer)
        : [saved, ...current]);
      select(saved);
      notify(editingId ? `已保存审查者「${saved.name}」` : `已创建审查者「${saved.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "审查者保存失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    try {
      await api.deleteReviewerProfile(deleteTarget.id);
      const rest = reviewers.filter((reviewer) => reviewer.id !== deleteTarget.id);
      setReviewers(rest);
      setDeleteTarget(null);
      if (rest[0]) select(rest[0]);
      else startNew();
      notify(`已删除审查者「${deleteTarget.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "审查者删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="settings-heading">
        <div><h1>审查者</h1><p>保存多套智能体、模型与智能水平组合，供自由工作流按需派审。</p></div>
      </header>
      <section className="settings-section">
        <h2>已保存的审查者</h2>
        <div className="settings-card reviewer-settings-card">
          {loading && <div className="reviewer-settings-status">正在读取审查者…</div>}
          {!loading && failed && (
            <div className="reviewer-settings-status is-error"><WarningCircle size={15} />读取失败<Button variant="ghost" onClick={load}>重试</Button></div>
          )}
          {!loading && !failed && (
            <div className="reviewer-settings-layout">
              <aside>
                <header><b>审查者</b><button type="button" onClick={() => startNew()}><Plus size={12} />新建</button></header>
                {!reviewers.length && <p><MagnifyingGlass size={18} />还没有审查者</p>}
                {reviewers.map((reviewer) => (
                  <button key={reviewer.id} type="button" aria-selected={editingId === reviewer.id} onClick={() => select(reviewer)}>
                    <b>{reviewer.name}</b>
                    <small>{reviewer.executorLabel ?? reviewer.agentType}{reviewer.model ? ` · ${reviewer.model}` : ""}</small>
                  </button>
                ))}
              </aside>
              <div className="reviewer-settings-editor">
                <header>
                  <div><b>{editingId ? "编辑审查者" : "新建审查者"}</b><small>一套配置可在任意自由任务中重复使用。</small></div>
                  <div>
                    {editingId && <Button variant="danger" disabled={busy} onClick={() => setDeleteTarget(reviewers.find((item) => item.id === editingId) ?? null)}><Trash size={13} />删除</Button>}
                    <Button variant="primary" disabled={busy || !draft.name.trim() || !profiles.length} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</Button>
                  </div>
                </header>
                <ReviewerProfileFields draft={draft} profiles={profiles} types={types} disabled={busy} onChange={setDraft} />
              </div>
            </div>
          )}
        </div>
      </section>
      {deleteTarget && <ConfirmDialog title="删除审查者" message={`确定删除“${deleteTarget.name}”？历史审查记录仍会保留当时的配置快照。`} confirmLabel="删除" danger busy={busy} onConfirm={() => void remove()} onClose={() => setDeleteTarget(null)} />}
    </>
  );
}
