/* Git 工作台 demo · 历史视图：提交图（lane 布局）+ 提交详情 + 图上直接发起的操作。 */
(function () {
  const S = GW.store, ops = S.ops, el = GW.el, btn = GW.btn;

  const LANE_W = 14, ROW_H = 34, DOT_R = 3.5;
  const LANE_COLORS = ["#5e6ad2", "#168466", "#b57b00", "#0e9db8", "#d93d4c", "#7c5cd2", "#3d8bd9"];

  let selectedSha = null;
  let filter = "";

  /* ---------- 图布局：自上而下扫一遍，给每个提交分配泳道 ---------- */
  function layout() {
    const tips = [];
    S.state.branches.forEach((b) => tips.push(b.sha));
    S.state.remoteBranches.forEach((b) => tips.push(b.sha));
    S.state.tags.forEach((t) => tips.push(t.sha));
    if (S.state.head.sha) tips.push(S.state.head.sha);
    const keep = new Set();
    tips.forEach((sha) => S.reachable(sha).forEach((s) => keep.add(s)));
    const commits = S.state.commits.filter((c) => keep.has(c.sha)).sort((a, b) => b.time - a.time);

    const lanes = [];   // 每个泳道正在等待的 parent sha
    const rows = [];
    commits.forEach((c) => {
      const waiting = [];
      lanes.forEach((sha, i) => { if (sha === c.sha) waiting.push(i); });
      let lane;
      if (waiting.length) { lane = waiting[0]; waiting.slice(1).forEach((i) => { lanes[i] = null; }); }
      else { lane = lanes.indexOf(null); if (lane < 0) lane = lanes.length; }
      const passThrough = [];
      lanes.forEach((sha, i) => { if (sha && i !== lane && sha !== c.sha) passThrough.push(i); });
      const parentLanes = [];
      c.parents.forEach((p, pi) => {
        if (pi === 0) { lanes[lane] = p; parentLanes.push(lane); return; }
        let existing = -1;
        lanes.forEach((sha, i) => { if (existing < 0 && sha === p && i !== lane) existing = i; });
        if (existing >= 0) { parentLanes.push(existing); return; }
        let free = lanes.indexOf(null);
        if (free < 0) { free = lanes.length; }
        lanes[free] = p;
        parentLanes.push(free);
      });
      if (!c.parents.length) lanes[lane] = null;
      rows.push({ commit: c, lane, mergeIn: waiting.filter((i) => i !== lane), passThrough, parentLanes });
    });
    const width = Math.max(2, ...rows.map((r) => 1 + Math.max(r.lane, ...r.parentLanes, ...r.passThrough, ...r.mergeIn, 0)));
    return { rows, width };
  }

  function laneSvg(row, laneCount) {
    const x = (l) => 7 + l * LANE_W;
    const color = (l) => LANE_COLORS[l % LANE_COLORS.length];
    const mid = ROW_H / 2;
    let s = "";
    row.passThrough.forEach((l) => {
      s += '<line x1="' + x(l) + '" y1="0" x2="' + x(l) + '" y2="' + ROW_H + '" stroke="' + color(l) + '" stroke-width="1.5" opacity=".55"/>';
    });
    row.mergeIn.forEach((l) => {
      s += '<path d="M' + x(l) + " 0 C " + x(l) + " " + mid * 0.7 + ", " + x(row.lane) + " " + mid * 0.35 + ", " + x(row.lane) + " " + mid + '" fill="none" stroke="' + color(l) + '" stroke-width="1.5"/>';
    });
    row.parentLanes.forEach((l) => {
      if (l === row.lane) s += '<line x1="' + x(l) + '" y1="' + mid + '" x2="' + x(l) + '" y2="' + ROW_H + '" stroke="' + color(l) + '" stroke-width="1.5"/>';
      else s += '<path d="M' + x(row.lane) + " " + mid + " C " + x(row.lane) + " " + mid * 1.65 + ", " + x(l) + " " + (ROW_H - mid * 0.35) + ", " + x(l) + " " + ROW_H + '" fill="none" stroke="' + color(l) + '" stroke-width="1.5"/>';
    });
    s += '<circle cx="' + x(row.lane) + '" cy="' + mid + '" r="' + DOT_R + '" fill="' + color(row.lane) + '"/>';
    if (row.commit.parents.length > 1) s += '<circle cx="' + x(row.lane) + '" cy="' + mid + '" r="' + (DOT_R - 2) + '" fill="var(--panel)"/>';
    const w = 14 + laneCount * LANE_W;
    return GW.html("span", "graph-cell", '<svg width="' + w + '" height="' + ROW_H + '" viewBox="0 0 ' + w + " " + ROW_H + '">' + s + "</svg>");
  }

  /* ---------- 引用徽章 ---------- */
  function refChips(sha) {
    const chips = [];
    const headSha = S.headSha();
    S.state.branches.forEach((b) => {
      if (b.sha !== sha) return;
      const isHead = !S.state.head.sha && S.state.head.branch === b.name;
      chips.push(el("span", "ref-chip" + (isHead ? " is-head" : "") + (b.task ? " is-task" : ""),
        (isHead ? "HEAD → " : "") + b.name));
    });
    S.state.remoteBranches.forEach((b) => { if (b.sha === sha) chips.push(el("span", "ref-chip is-remote", b.name)); });
    S.state.tags.forEach((t) => { if (t.sha === sha) chips.push(el("span", "ref-chip is-tag", t.name)); });
    if (S.state.head.sha === sha) chips.push(el("span", "ref-chip is-head", "HEAD（游离）"));
    return chips;
  }

  /* ---------- 提交操作菜单 ---------- */
  function commitMenu(anchor, c) {
    const cur = S.headBranch();
    const onCurrent = cur && S.reachable(cur.sha).has(c.sha);
    const isTip = cur && cur.sha === c.sha;
    GW.menu(anchor, [
      { label: "复制提交号", icon: "copy", onClick: () => GW.copySha(c.sha) },
      { label: "从此提交新建分支…", icon: "branch", onClick: () => GW.views.branches.createDialog(c.sha) },
      { label: "在此打标签…", icon: "tag", onClick: () => GW.views.tags.createDialog(c.sha) },
      { label: "游离检出此提交", icon: "detach", onClick: () => GW.report(ops.checkoutSha(c.sha)) },
      { sep: true },
      { label: "拣选到当前分支", icon: "merge", disabled: !cur || onCurrent, hint: onCurrent ? "已包含" : "",
        onClick: () => GW.report(ops.cherryPick(c.sha)) },
      { label: "回滚此提交", icon: "undo", disabled: !onCurrent,
        onClick: () => GW.report(ops.revert(c.sha)) },
      { label: "从此开始交互式变基…", icon: "history", disabled: !onCurrent || isTip,
        onClick: () => GW.overlays.rebase.open(c.sha) },
      { sep: true },
      { label: "重置当前分支到此…", icon: "warn", tone: "danger", disabled: !cur,
        onClick: () => resetDialog(c) },
    ]);
  }

  async function resetDialog(c) {
    const body = el("div", "confirm-body");
    body.append(el("p", "confirm-text", "把 " + S.state.head.branch + " 重置到 " + c.sha + "（" + c.msg + "）。选择模式："));
    let mode = "mixed";
    const modes = [
      ["soft", "soft — 差异全部回到暂存区"],
      ["mixed", "mixed — 差异回到工作树"],
      ["hard", "hard — 丢弃全部差异（危险）"],
    ];
    const group = el("div", "radio-col");
    modes.forEach(([value, label]) => {
      const lab = el("label", "radio-row");
      const input = el("input");
      input.type = "radio"; input.name = "reset-mode"; input.checked = value === mode;
      input.addEventListener("change", () => { mode = value; });
      lab.append(input, label);
      group.append(lab);
    });
    body.append(group);
    body.append(GW.html("p", "confirm-safety", GW.icon("undo", 13) + "<span>执行前自动留仓库快照，可在「操作日志」撤销。</span>"));
    const cancel = btn("ui-btn", "取消", () => m.close());
    const okBtn = btn("ui-btn primary danger", "重置", async () => {
      m.close();
      if (mode === "hard") {
        const sure = await GW.confirmDialog({
          title: "确认 hard 重置", tone: "grave",
          warn: "工作树与暂存区将回到该提交，未提交改动全部丢弃",
          body: "重置 " + S.state.head.branch + " → " + c.sha, typed: S.state.head.branch, confirmText: "hard 重置",
        });
        if (!sure) return;
      }
      GW.report(ops.resetTo(c.sha, mode));
    });
    const m = GW.modal({ title: "重置分支", body, actions: [cancel, okBtn] });
  }

  /* ---------- 详情面板 ---------- */
  function detailPane() {
    const pane = el("div", "detail-pane");
    const c = selectedSha && S.commitMap().get(selectedSha);
    if (!c) {
      pane.append(GW.html("div", "empty-hint", GW.icon("history", 28) + "<p>选中左侧提交查看详情</p>"));
      return pane;
    }
    const head = el("header", "detail-head");
    const shaBtn = btn("sha-chip", c.sha, () => GW.copySha(c.sha));
    head.append(shaBtn, el("b", "detail-msg", c.msg));
    const meta = el("div", "detail-meta");
    meta.append(el("span", null, c.author), el("span", null, GW.timeAgo(c.time)),
      el("span", null, c.parents.length > 1 ? "合并提交" : (c.parents[0] ? "父 " + c.parents[0] : "根提交")));
    refChips(c.sha).forEach((chip) => meta.append(chip));
    head.append(meta);
    const menuBtn = btn("icon-btn detail-menu", null, () => commitMenu(menuBtn, c));
    menuBtn.innerHTML = GW.icon("dots", 15);
    head.append(menuBtn);
    pane.append(head);

    const body = el("div", "diff-scroll");
    body.dataset.scrollKey = "history-detail";
    if (!c.files.length) body.append(el("p", "empty-hint", "合并提交（按 first-parent 无独立补丁）"));
    c.files.forEach((f) => {
      const sec = el("section", "detail-file");
      const fh = el("header", "detail-file-head");
      fh.append(GW.kindBadge(f.kind), el("code", "diff-path", f.path), GW.statLabel(f.add, f.del));
      sec.append(fh);
      sec.append(GW.renderDiff(f.hunks || GW.genDiff(f.path, f.add, f.del), {}));
      body.append(sec);
    });
    pane.append(body);
    return pane;
  }

  /* ---------- 主渲染 ---------- */
  GW.views = GW.views || {};
  GW.views.history = {
    title: "历史", icon: "history",
    render(container) {
      const wrap = el("div", "history-view");
      const listCol = el("div", "history-list");

      const bar = el("div", "history-bar");
      const search = el("input", "ui-input history-search");
      search.id = "history-search";
      search.placeholder = "搜索提交信息 / 作者 / 提交号…";
      search.value = filter;
      search.addEventListener("input", () => { filter = search.value; GW.app.render(); });
      bar.append(search);
      listCol.append(bar);

      const { rows, width } = layout();
      const q = filter.trim().toLowerCase();
      const list = el("div", "history-rows");
      list.dataset.scrollKey = "history-rows";
      rows.forEach((row) => {
        const c = row.commit;
        if (q && !(c.msg.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.sha.includes(q))) return;
        const r = btn("commit-row ui-selectable" + (selectedSha === c.sha ? " is-selected" : ""), null,
          () => { selectedSha = c.sha; GW.app.render(); });
        if (!q) r.append(laneSvg(row, width));
        r.append(el("code", "commit-sha", c.sha));
        const mid = el("span", "commit-main");
        const chips = refChips(c.sha);
        if (chips.length) { const cw = el("span", "commit-refs"); chips.forEach((ch) => cw.append(ch)); mid.append(cw); }
        mid.append(el("span", "commit-msg", c.msg));
        r.append(mid);
        r.append(el("span", "commit-author", c.author), el("span", "commit-time", GW.timeAgo(c.time)));
        const dots = btn("icon-btn row-menu", null, () => commitMenu(dots, c));
        dots.innerHTML = GW.icon("dots", 14);
        r.append(dots);
        list.append(r);
      });
      listCol.append(list);
      wrap.append(listCol, detailPane());
      container.append(wrap);
    },
  };
})();
