/* Git 工作台 demo · 标签视图 + 工作树视图。 */
(function () {
  const S = GW.store, ops = S.ops, el = GW.el, btn = GW.btn;

  /* ================= 标签 ================= */
  function tagCreateDialog(atSha) {
    const sha = atSha || S.headSha();
    const body = el("div", "confirm-body");
    body.append(el("p", "confirm-text", "打在：" + sha + (atSha ? "" : "（当前 HEAD）")));
    const name = el("input", "ui-input");
    name.placeholder = "标签名，如 v0.9.2";
    body.append(name);
    const lab = el("label", "amend-toggle");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = true;
    lab.append(cb, "附注标签（记录说明与打标签的人）");
    body.append(lab);
    const msg = el("input", "ui-input");
    msg.placeholder = "标签说明";
    body.append(msg);
    cb.addEventListener("change", () => { msg.style.display = cb.checked ? "" : "none"; });
    const cancel = btn("ui-btn", "取消", () => m.close());
    const okBtn = btn("ui-btn primary", "创建标签", () => {
      const n = name.value.trim();
      if (!n) return;
      m.close();
      GW.report(ops.tagCreate(n, sha, cb.checked, msg.value.trim()));
    });
    const m = GW.modal({ title: "新建标签", body, actions: [cancel, okBtn] });
    name.focus();
  }

  function tagRow(t) {
    const row = el("div", "branch-row ui-selectable");
    const name = el("span", "branch-name");
    name.innerHTML = GW.icon("tag", 13) + "<b>" + t.name + "</b>" + (t.annotated ? '<em class="cur-tag">附注</em>' : "");
    row.append(name);
    if (t.msg) row.append(el("span", "branch-last", t.msg));
    const c = S.commitMap().get(t.sha);
    row.append(el("code", "commit-sha", t.sha));
    if (c) row.append(el("span", "branch-time", GW.timeAgo(c.time)));
    row.append(el("span", "push-state" + (t.pushed ? " is-pushed" : ""), t.pushed ? "已在远端" : "仅本地"));
    const acts = el("span", "file-actions");
    if (!t.pushed) {
      const push = btn("icon-btn", null, () => GW.report(ops.tagPush(t.name)));
      push.innerHTML = GW.icon("up", 13);
      push.setAttribute("aria-label", "推送标签");
      acts.append(push);
    }
    const del = btn("icon-btn tone-danger", null, async () => {
      const okGo = await GW.confirmDialog({
        title: "删除标签？", tone: "danger",
        warn: t.pushed ? "只删本地；远端同名标签需另行删除" : "标签将被删除",
        body: t.name, confirmText: "删除",
      });
      if (okGo) GW.report(ops.tagDelete(t.name));
    });
    del.innerHTML = GW.icon("trash", 13);
    del.setAttribute("aria-label", "删除标签");
    acts.append(del);
    row.append(acts);
    return row;
  }

  GW.views = GW.views || {};
  GW.views.tags = {
    title: "标签", icon: "tag",
    createDialog: tagCreateDialog,
    render(container) {
      const wrap = el("div", "tags-view scroll-col");
      wrap.dataset.scrollKey = "tags";
      const head = el("header", "view-head");
      head.append(el("b", null, "标签"), el("span", "flex-1"));
      const add = btn("mini-btn tone-accent", null, () => tagCreateDialog(null));
      add.innerHTML = GW.icon("plus", 12) + "<span>在 HEAD 打标签…</span>";
      head.append(add);
      wrap.append(head);
      if (!S.state.tags.length) wrap.append(GW.html("div", "empty-hint", GW.icon("tag", 28) + "<p>还没有标签</p>"));
      S.state.tags.forEach((t) => wrap.append(tagRow(t)));
      container.append(wrap);
    },
  };

  /* ================= 工作树 ================= */
  const WT_STATE = { running: "任务进行中", accepted: "已验收" };

  function worktreeCard(wt) {
    const card = el("div", "wt-card" + (wt.isMain ? " is-main" : ""));
    const head = el("header", "wt-head");
    head.append(GW.html("span", "wt-icon", GW.icon("worktree", 15)));
    head.append(el("b", "wt-path", wt.path), wt.isMain ? el("em", "cur-tag", "主检出") : null);
    head.append(el("span", "flex-1"));
    head.append(el("span", "wt-dirty" + (wt.dirty ? " is-dirty" : ""), wt.dirty ? "有未提交改动" : "干净"));
    card.append(head);

    const meta = el("div", "wt-meta");
    meta.innerHTML = GW.icon("branch", 12) + "<code>" + wt.branch + "</code>";
    if (wt.task) {
      meta.append(el("span", "task-chip state-" + wt.task.state, [wt.task.title, el("i", null, WT_STATE[wt.task.state] || wt.task.state)]));
    }
    const main = S.branchOf("main");
    const b = S.branchOf(wt.branch);
    if (b && main && wt.branch !== "main") {
      const ab = S.aheadBehind(b.sha, main.sha);
      meta.append(el("span", "sync-chip vs-main", "较 main +" + ab.ahead + " / −" + ab.behind));
    }
    card.append(meta);

    const acts = el("div", "wt-actions");
    const term = btn("mini-btn", null, () => GW.toast("已在 " + wt.path + " 打开终端（demo 示意）", "ok"));
    term.innerHTML = GW.icon("terminal", 12) + "<span>打开终端</span>";
    acts.append(term);
    if (!wt.isMain) {
      const merged = b && main && S.reachable(main.sha).has(b.sha);
      if (!merged) {
        const mergeBtn = btn("mini-btn tone-accent", null, async () => {
          const okGo = await GW.confirmDialog({
            title: "合并回 main？",
            body: "把 " + wt.branch + " 的已提交内容合并进 main（对应任务验收的合并动作，走仓库锁队列）。"
              + (wt.dirty ? "工作树里未提交的改动不会包含在内。" : ""),
            confirmText: "合并",
          });
          if (okGo) GW.report(ops.worktreeMerge(wt.path));
        });
        mergeBtn.innerHTML = GW.icon("merge", 12) + "<span>合并回 main</span>";
        acts.append(mergeBtn);
      }
      const rm = btn("mini-btn tone-danger", null, async () => {
        const okGo = await GW.confirmDialog(wt.dirty
          ? { title: "删除有未提交改动的工作树？", tone: "grave",
              warn: "里面未提交的改动会一并消失" + (wt.task && wt.task.state === "running" ? "，且任务还在跑" : ""),
              body: wt.path, typed: wt.branch, confirmText: "删除工作树" }
          : { title: "删除工作树？", body: wt.path + "（分支 " + wt.branch + " 保留，不会自动删）", confirmText: "删除" });
        if (okGo) GW.report(ops.worktreeRemove(wt.path));
      });
      rm.innerHTML = GW.icon("trash", 12) + "<span>删除</span>";
      acts.append(rm);
    }
    card.append(acts);
    return card;
  }

  GW.views.worktrees = {
    title: "工作树", icon: "worktree",
    badge: () => { const n = S.state.worktrees.filter((w) => !w.isMain).length; return n || null; },
    render(container) {
      const wrap = el("div", "wt-view scroll-col");
      wrap.dataset.scrollKey = "worktrees";
      const head = el("header", "view-head");
      head.append(el("b", null, "工作树"), el("i", "group-hint", "每个任务一个隔离目录，验收后可清理；分支永不自动删"));
      const prune = btn("mini-btn", null, async () => {
        const okGo = await GW.confirmDialog({
          title: "清理已验收的工作树？",
          body: "删除所有「已验收且没有未提交改动」的工作树目录，分支保留。", confirmText: "清理",
        });
        if (okGo) GW.report(ops.worktreePrune());
      });
      prune.innerHTML = GW.icon("trash", 12) + "<span>清理已验收</span>";
      head.append(el("span", "flex-1"), prune);
      wrap.append(head);
      S.state.worktrees.forEach((wt) => wrap.append(worktreeCard(wt)));
      container.append(wrap);
    },
  };
})();
