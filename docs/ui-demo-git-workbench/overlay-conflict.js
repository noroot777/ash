/* Git 工作台 demo · 冲突解决器：merge / rebase 撞车时的全屏工作面。
   每个冲突块四条出路：用我方 / 用对方 / 两者都要 / AI 建议或手工编辑。 */
(function () {
  const S = GW.store, ops = S.ops, el = GW.el, btn = GW.btn;

  let root = null;
  let currentPath = null;

  function resultLines(blk) {
    if (blk.choice === "ours") return blk.ours;
    if (blk.choice === "theirs") return blk.theirs;
    if (blk.choice === "both") return blk.ours.concat(blk.theirs);
    if (blk.choice === "ai") return blk.ai || blk.ours.concat(blk.theirs);
    if (blk.choice === "custom") return blk.custom || [];
    return null;
  }

  function sideBox(cls, title, sub, lines) {
    const box = el("div", "cf-side " + cls);
    box.append(el("header", "cf-side-head", [el("b", null, title), el("i", null, sub)]));
    const code = el("div", "cf-code");
    lines.forEach((s) => code.append(el("div", "cf-code-line", s || " ")));
    box.append(code);
    return box;
  }

  function blockCard(file, fileIdx, blk, blockIdx) {
    const opn = S.state.operation;
    const card = el("section", "cf-block" + (blk.choice ? " is-solved" : ""));
    const head = el("header", "cf-block-head");
    head.append(el("b", null, "冲突块 " + (blockIdx + 1)), el("code", "cf-context", blk.context));
    card.append(head);

    if (blk.choice) {
      const done = el("div", "cf-result");
      const label = { ours: "已采用我方", theirs: "已采用对方", both: "已保留双方", ai: "已采用 AI 建议", custom: "已手工编辑" }[blk.choice];
      const dh = el("header", "cf-side-head");
      dh.innerHTML = "<b>" + GW.icon("check", 13) + " " + label + "</b>";
      const redo = btn("mini-btn", null, () => { ops.resolveBlock(fileIdx, blockIdx, null); rerender(); });
      redo.innerHTML = GW.icon("undo", 12) + "<span>重新选择</span>";
      dh.append(el("span", "flex-1"), redo);
      done.append(dh);
      const code = el("div", "cf-code is-result");
      (resultLines(blk) || []).forEach((s) => code.append(el("div", "cf-code-line", s || " ")));
      done.append(code);
      card.append(done);
      return card;
    }

    const sides = el("div", "cf-sides");
    sides.append(sideBox("is-ours", "我方（" + opn.target + "）", "HEAD", blk.ours));
    sides.append(sideBox("is-theirs", "对方（" + opn.source + "）", "并入分支", blk.theirs));
    card.append(sides);

    const acts = el("div", "cf-actions");
    const mk = (label, icon, choice, cls) => {
      const b = btn("mini-btn" + (cls ? " " + cls : ""), null, () => { ops.resolveBlock(fileIdx, blockIdx, choice); rerender(); });
      b.innerHTML = GW.icon(icon, 12) + "<span>" + label + "</span>";
      return b;
    };
    acts.append(mk("用我方", "check", "ours"), mk("用对方", "check", "theirs"), mk("两者都要", "plus", "both"));

    const aiBtn = btn("mini-btn tone-accent", null, () => {
      aiPreview.classList.toggle("is-hidden");
    });
    aiBtn.innerHTML = GW.icon("ai", 12) + "<span>AI 建议</span>";
    acts.append(aiBtn);

    const editBtn = btn("mini-btn", null, () => {
      editor.classList.toggle("is-hidden");
      ta.value = blk.ours.concat(blk.theirs).join("\n");
      ta.focus();
    });
    editBtn.innerHTML = GW.icon("file", 12) + "<span>手工编辑</span>";
    acts.append(editBtn);
    card.append(acts);

    const aiPreview = el("div", "cf-ai is-hidden");
    const ah = el("header", "cf-side-head");
    ah.innerHTML = "<b>" + GW.icon("ai", 13) + " AI 建议的合并结果</b><i>两边意图都保留时的写法</i>";
    const adopt = btn("mini-btn tone-accent", null, () => { ops.resolveBlock(fileIdx, blockIdx, "ai"); rerender(); });
    adopt.innerHTML = GW.icon("check", 12) + "<span>采纳</span>";
    ah.append(el("span", "flex-1"), adopt);
    aiPreview.append(ah);
    const aiCode = el("div", "cf-code is-ai");
    (blk.ai || []).forEach((s) => aiCode.append(el("div", "cf-code-line", s || " ")));
    aiPreview.append(aiCode);
    card.append(aiPreview);

    const editor = el("div", "cf-editor is-hidden");
    const ta = el("textarea", "cf-textarea");
    ta.rows = Math.max(4, blk.ours.length + blk.theirs.length);
    editor.append(ta);
    const save = btn("mini-btn tone-accent", null, () => {
      ops.resolveBlock(fileIdx, blockIdx, "custom", ta.value.split("\n"));
      rerender();
    });
    save.innerHTML = GW.icon("check", 12) + "<span>就用这个结果</span>";
    editor.append(save);
    card.append(editor);
    return card;
  }

  function rerender() {
    if (!root) return;
    const opn = S.state.operation;
    if (!opn) { close(); return; }
    const prevMain = root.querySelector(".cf-main");
    const keepScroll = prevMain ? prevMain.scrollTop : 0;
    root.innerHTML = "";

    const total = opn.files.reduce((n, f) => n + f.blocks.length, 0);
    const solved = opn.files.reduce((n, f) => n + f.blocks.filter((b) => b.choice).length, 0);

    const head = el("header", "cf-head");
    const title = el("div", "cf-title");
    title.innerHTML = GW.icon("merge", 16) + "<b>解决" + opn.typeLabel + "冲突</b><code>" + opn.source + " → " + opn.target + "</code>";
    head.append(title);
    head.append(el("span", "cf-progress", solved + " / " + total + " 块已解决"));
    head.append(el("span", "flex-1"));

    const agentBtn = btn("mini-btn", null, () => {
      GW.toast("已把这份冲突派给 agent 处理（demo 示意）——真实实现会派生一个带冲突上下文的任务", "ok");
    });
    agentBtn.innerHTML = GW.icon("ai", 12) + "<span>整份交给 agent</span>";
    head.append(agentBtn);

    const abort = btn("mini-btn tone-danger", null, async () => {
      const okGo = await GW.confirmDialog({
        title: "中止" + opn.typeLabel + "？",
        body: "工作区回到" + opn.typeLabel + "开始前的状态，已做的块选择作废。", confirmText: "中止", safety: false,
      });
      if (okGo) { GW.report(ops.abortOperation()); close(); }
    });
    abort.innerHTML = GW.icon("x", 12) + "<span>中止</span>";
    head.append(abort);

    const finish = btn("ui-btn primary", "完成合并", async () => {
      const r = await ops.continueMerge();
      GW.report(r);
      if (r.ok) close();
    });
    finish.disabled = solved < total;
    head.append(finish);

    const hide = btn("icon-btn", null, close);
    hide.innerHTML = GW.icon("x", 15);
    hide.setAttribute("aria-label", "先收起（冲突态保留）");
    head.append(hide);
    root.append(head);

    const body = el("div", "cf-body");
    const fileCol = el("aside", "cf-files");
    opn.files.forEach((f) => {
      const left = f.blocks.filter((b) => !b.choice).length;
      const row = btn("cf-file ui-selectable" + (currentPath === f.path ? " is-selected" : ""), null,
        () => { currentPath = f.path; rerender(); });
      row.append(GW.kindBadge("!"), el("span", "file-name", f.path),
        el("span", "conflict-state" + (left ? "" : " is-done"), left ? left + " 块" : "已解决"));
      fileCol.append(row);
    });
    body.append(fileCol);

    const main = el("div", "cf-main");
    const fileIdx = opn.files.findIndex((f) => f.path === currentPath);
    const file = opn.files[fileIdx];
    if (file) {
      main.append(el("h3", "cf-file-title", file.path));
      file.blocks.forEach((blk, bi) => main.append(blockCard(file, fileIdx, blk, bi)));
    }
    body.append(main);
    root.append(body);
    main.scrollTop = keepScroll;
  }

  function open(path) {
    const opn = S.state.operation;
    if (!opn) return;
    currentPath = path || (opn.files.find((f) => f.blocks.some((b) => !b.choice)) || opn.files[0]).path;
    if (!root) {
      root = el("div", "conflict-overlay");
      document.getElementById("overlay-root").append(root);
    }
    rerender();
  }
  function close() {
    if (root) { root.remove(); root = null; }
    GW.app.render();
  }

  GW.overlays = GW.overlays || {};
  GW.overlays.conflict = { open, close, isOpen: () => !!root };
})();
