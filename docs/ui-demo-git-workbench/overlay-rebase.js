/* Git 工作台 demo · 交互式变基：pick / reword / squash / fixup / drop + 拖顺序，先预览后执行。 */
(function () {
  const S = GW.store, ops = S.ops, el = GW.el, btn = GW.btn;

  const ACTIONS = [
    ["pick", "pick — 保留"],
    ["reword", "reword — 改提交信息"],
    ["squash", "squash — 并入上一个（合并信息）"],
    ["fixup", "fixup — 并入上一个（丢弃信息）"],
    ["drop", "drop — 丢弃"],
  ];

  function open(baseSha) {
    const plan = ops.rebasePlanFor(baseSha);
    if (!plan.length) { GW.toast("该提交之后没有可变基的提交", "err"); return; }

    const body = el("div", "rebase-body");
    body.append(GW.html("p", "rebase-tip",
      GW.icon("history", 13) + "<span>把 <b>" + S.state.head.branch + "</b> 上 " + baseSha + " 之后的 " + plan.length
      + " 个提交按下面的清单重写。从上到下 = 从旧到新；squash / fixup 会并入它上面那行。</span>"));

    const list = el("div", "rebase-list");
    body.append(list);

    const summary = el("p", "rebase-summary");
    body.append(summary);

    function renderList() {
      list.innerHTML = "";
      plan.forEach((item, i) => {
        const row = el("div", "rebase-row" + (item.action === "drop" ? " is-drop" : ""));
        const sel = el("select", "rebase-action");
        ACTIONS.forEach(([v, label]) => {
          const o = el("option", null, label);
          o.value = v;
          if ((v === "squash" || v === "fixup") && i === 0) o.disabled = true;
          if (v === item.action) o.selected = true;
          sel.append(o);
        });
        sel.addEventListener("change", () => { item.action = sel.value; renderList(); });
        row.append(sel, el("code", "commit-sha", item.sha));
        if (item.action === "reword") {
          const input = el("input", "ui-input rebase-msg");
          input.value = item.newMsg != null ? item.newMsg : item.msg;
          input.addEventListener("input", () => { item.newMsg = input.value; });
          row.append(input);
        } else {
          row.append(el("span", "commit-msg", item.msg));
        }
        const moves = el("span", "rebase-moves");
        const upB = btn("icon-btn", null, () => { [plan[i - 1], plan[i]] = [plan[i], plan[i - 1]]; renderList(); });
        upB.innerHTML = GW.icon("up", 12);
        upB.disabled = i === 0;
        const dnB = btn("icon-btn", null, () => { [plan[i + 1], plan[i]] = [plan[i], plan[i + 1]]; renderList(); });
        dnB.innerHTML = GW.icon("down", 12);
        dnB.disabled = i === plan.length - 1;
        moves.append(upB, dnB);
        row.append(moves);
        list.append(row);
      });
      const kept = plan.filter((p) => p.action !== "drop");
      const folded = plan.filter((p) => p.action === "squash" || p.action === "fixup").length;
      const dropped = plan.length - kept.length;
      summary.textContent = "结果：" + plan.length + " 个提交 → " + (kept.length - folded) + " 个"
        + (folded ? "（" + folded + " 个被并入）" : "") + (dropped ? "（" + dropped + " 个丢弃）" : "")
        + "。提交号会全部改变；已推送过的历史被改写后需要带保护强推。";
    }
    renderList();

    const cancel = btn("ui-btn", "取消", () => m.close());
    const run = btn("ui-btn primary", "执行变基", async () => {
      const first = plan.find((p) => p.action !== "drop");
      if (first && (first.action === "squash" || first.action === "fixup")) {
        GW.toast("第一个保留的提交不能是 squash / fixup", "err");
        return;
      }
      m.close();
      GW.report(ops.applyRebase(baseSha, plan));
    });
    const m = GW.modal({ title: "交互式变基", body, actions: [cancel, run], wide: true });
  }

  GW.overlays = GW.overlays || {};
  GW.overlays.rebase = { open };
})();
