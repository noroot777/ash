/* Git 工作台 demo · 贮藏视图。
   stash 栈是主检出和所有 worktree 共享的（AGENTS.md 的坑）：条目标会话来源，
   别的会话的只给 apply 不给 pop，防止弄丢别人的现场。 */
(function () {
  const S = GW.store, ops = S.ops, el = GW.el, btn = GW.btn;

  let expanded = null;

  function pushDialog() {
    const body = el("div", "confirm-body");
    const input = el("input", "ui-input");
    input.placeholder = "这份现场是什么（会自动带上会话标签）";
    body.append(input);
    const lab = el("label", "amend-toggle");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = true;
    lab.append(cb, "包含未跟踪文件（-u）");
    body.append(lab);
    body.append(GW.html("p", "confirm-safety", GW.icon("stash", 13) + "<span>stash 栈由主检出与全部工作树共享，条目会打上「本会话」标签以便认领。</span>"));
    const cancel = btn("ui-btn", "取消", () => m.close());
    const okBtn = btn("ui-btn primary", "贮藏", async () => {
      const msg = input.value.trim() || "未命名现场";
      m.close();
      GW.report(ops.stashPush(msg, cb.checked));
    });
    const m = GW.modal({ title: "贮藏当前改动", body, actions: [cancel, okBtn] });
    input.focus();
  }

  function stashRow(st, index) {
    const mine = st.session === "本会话";
    const wrap = el("div", "stash-item" + (expanded === st.id ? " is-open" : ""));
    const row = btn("stash-row ui-selectable", null, () => { expanded = expanded === st.id ? null : st.id; GW.app.render(); });
    row.append(el("code", "stash-index", "stash@{" + index + "}"));
    row.append(el("span", "stash-msg", st.msg));
    row.append(el("span", "session-chip" + (mine ? " is-mine" : ""), st.session));
    row.append(el("span", "branch-time", "于 " + st.branch + " · " + GW.timeAgo(st.time)));
    row.append(el("span", "group-count", st.files.length + " 文件"));
    row.append(el("span", "flex-1"));

    const acts = el("span", "file-actions is-static");
    const applyBtn = btn("mini-btn", null, () => GW.report(ops.stashApply(st.id)));
    applyBtn.innerHTML = GW.icon("down", 12) + "<span>应用</span>";
    const popBtn = btn("mini-btn" + (mine ? "" : " is-disabled"), null, () => GW.report(ops.stashPop(st.id)));
    popBtn.innerHTML = GW.icon("play", 12) + "<span>应用并移除</span>";
    if (!mine) popBtn.setAttribute("aria-label", "别的会话贮藏的，规矩是只 apply 不 pop");
    const dropBtn = btn("mini-btn tone-danger", null, async () => {
      const okGo = await GW.confirmDialog({
        title: "删除这条贮藏？", tone: mine ? "danger" : "grave",
        warn: mine ? "里面的现场会丢失" : "这是「" + st.session + "」的现场，删掉会弄丢别人的工作",
        body: st.msg, typed: mine ? undefined : "删除他人现场", confirmText: "删除",
      });
      if (okGo) GW.report(ops.stashDrop(st.id));
    });
    dropBtn.innerHTML = GW.icon("trash", 12) + "<span>删除</span>";
    acts.append(applyBtn, popBtn, dropBtn);
    row.append(acts);
    wrap.append(row);

    if (expanded === st.id) {
      const detail = el("div", "stash-detail");
      st.files.forEach((f) => {
        const fh = el("header", "detail-file-head");
        fh.append(GW.kindBadge(f.kind), el("code", "diff-path", f.path), GW.statLabel(f.add, f.del));
        detail.append(fh);
        detail.append(GW.renderDiff(f.hunks && f.hunks.length ? f.hunks : GW.genDiff(f.path, f.add, f.del), {}));
      });
      wrap.append(detail);
    }
    return wrap;
  }

  GW.views = GW.views || {};
  GW.views.stash = {
    title: "贮藏", icon: "stash",
    badge: () => S.state.stashes.length || null,
    pushDialog,
    render(container) {
      const wrap = el("div", "stash-view scroll-col");
      wrap.dataset.scrollKey = "stash";
      const head = el("header", "view-head");
      head.append(el("b", null, "贮藏栈"), el("i", "group-hint", "主检出与全部工作树共享一条栈"));
      const push = btn("mini-btn tone-accent", null, pushDialog);
      push.innerHTML = GW.icon("stash", 12) + "<span>贮藏当前改动…</span>";
      head.append(el("span", "flex-1"), push);
      wrap.append(head);
      if (!S.state.stashes.length) wrap.append(GW.html("div", "empty-hint", GW.icon("stash", 28) + "<p>栈上没有贮藏</p>"));
      S.state.stashes.forEach((st, i) => wrap.append(stashRow(st, i)));
      container.append(wrap);
    },
  };
})();
