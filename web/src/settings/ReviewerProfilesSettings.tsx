import { Fragment, useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, ReviewerProfile } from "@ash/shared";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import {
  createReviewerDraft,
  ReviewerProfileFields,
  ReviewerProfileSummary,
  reviewerDraft,
  reviewerPayload,
  type ReviewerDraft,
} from "../free-workflow/ReviewerProfileFields.tsx";
import { reviewerDeleteMessage } from "../free-workflow/freeReviewCopy.ts";

/** 正在编辑哪一位：某个审查者的 id，或者「新建」那一张空表。 */
const NEW = "new";

// 设置 → 审查者。跟飞书页同一副骨架：一位审查者一行，点编辑就在那一行下面展开表单
// （骨架样式在 styles/settings-list.css）。
export function ReviewerProfilesSettings({ notify }: { notify: (message: string) => void }) {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [reviewers, setReviewers] = useState<ReviewerProfile[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReviewerDraft>(() => createReviewerDraft());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ReviewerProfile | null>(null);
  const types = useMemo(() => registeredAgentTypes(profiles), [profiles]);

  const edit = (reviewer: ReviewerProfile) => {
    if (editing === reviewer.id) {
      setEditing(null);
      return;
    }
    setEditing(reviewer.id);
    setDraft(reviewerDraft(reviewer));
  };

  const startNew = () => {
    setEditing(NEW);
    setDraft(createReviewerDraft(profiles));
  };

  const load = () => {
    setLoading(true);
    setFailed(false);
    Promise.all([api.reviewerProfiles(), api.agents()]).then(([nextReviewers, nextProfiles]) => {
      setReviewers(nextReviewers);
      setProfiles(nextProfiles);
    }).catch((error) => {
      setFailed(true);
      notify(error instanceof Error ? error.message : "审查者读取失败");
    }).finally(() => setLoading(false));
  };

  useEffect(load, [notify]);

  const save = async () => {
    if (!draft.name.trim() || busy || !editing) return;
    const creating = editing === NEW;
    setBusy(true);
    try {
      const payload = reviewerPayload(draft, profiles);
      const saved = creating
        ? await api.createReviewerProfile(payload)
        : await api.patchReviewerProfile(editing, payload);
      setReviewers((current) => creating
        ? [saved, ...current]
        : current.map((reviewer) => reviewer.id === saved.id ? saved : reviewer));
      setEditing(null);
      notify(creating ? `已创建审查者「${saved.name}」` : `已保存审查者「${saved.name}」`);
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
      setReviewers((current) => current.filter((reviewer) => reviewer.id !== deleteTarget.id));
      if (editing === deleteTarget.id) setEditing(null);
      setDeleteTarget(null);
      notify(`已删除审查者「${deleteTarget.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "审查者删除失败");
    } finally {
      setBusy(false);
    }
  };

  const editor = (
    <div className="settings-editor">
      <ReviewerProfileFields
        draft={draft}
        profiles={profiles}
        types={types}
        disabled={busy}
        autoFocus={editing === NEW}
        onChange={setDraft}
      />
      <div className="settings-card-foot">
        {!profiles.length && <span>还没有执行器；先去「执行器」注册一个。</span>}
        <Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>取消</Button>
        <Button variant="primary" disabled={busy || !draft.name.trim() || !profiles.length} onClick={() => void save()}>
          {busy ? "保存中…" : editing === NEW ? "创建审查者" : "保存"}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <header className="settings-heading">
        <div><h1>审查者</h1><p>保存多套智能体、模型与智能水平组合，供自由工作流按需派审。</p></div>
        {!loading && !failed && editing !== NEW && (
          <Button onClick={startNew}><Plus size={14} aria-hidden="true" />新建审查者</Button>
        )}
      </header>
      <section className="settings-section">
        <h2>已保存的审查者</h2>
        <div className="settings-card">
          {loading && <p className="settings-muted">正在读取审查者…</p>}
          {!loading && failed && (
            <p className="settings-muted">审查者读取失败。<Button variant="ghost" onClick={load}>重试</Button></p>
          )}
          {editing === NEW && editor}
          {!loading && !failed && !reviewers.length && editing !== NEW && (
            <p className="settings-muted">还没有审查者。</p>
          )}
          {reviewers.map((reviewer) => (
            <Fragment key={reviewer.id}>
              <div className={`settings-row settings-item${editing === reviewer.id ? " is-editing" : ""}`}>
                <div>
                  <b>{reviewer.name}</b>
                  <ReviewerProfileSummary reviewer={reviewer} profiles={profiles} />
                </div>
                <span className="settings-row-actions">
                  <button
                    type="button"
                    className="settings-icon-action"
                    aria-pressed={editing === reviewer.id}
                    aria-label={editing === reviewer.id ? `收起 ${reviewer.name} 的编辑表单` : `编辑 ${reviewer.name}`}
                    onClick={() => edit(reviewer)}
                  >
                    <PencilSimple size={14} />
                  </button>
                  <button
                    type="button"
                    className="settings-icon-danger"
                    disabled={busy}
                    aria-label={`删除 ${reviewer.name}`}
                    onClick={() => setDeleteTarget(reviewer)}
                  >
                    <Trash size={14} />
                  </button>
                </span>
              </div>
              {editing === reviewer.id && editor}
            </Fragment>
          ))}
        </div>
      </section>
      {deleteTarget && <ConfirmDialog title="删除审查者" message={reviewerDeleteMessage(deleteTarget.name)} confirmLabel="删除" danger busy={busy} onConfirm={() => void remove()} onClose={() => setDeleteTarget(null)} />}
    </>
  );
}
