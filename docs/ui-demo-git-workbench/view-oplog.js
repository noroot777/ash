/* Git 工作台 demo · 操作日志：页面上每个 git 动作的审计流水 + 仓库锁状态 + 一键撤销。
   对应后端：withRepoLock 的排队与持有者、每次操作的等价命令与自动快照（backup ref）。 */
(function () {
  const S = GW.store, ops = S.ops, el = GW.el, btn = GW.btn;

  const ACTOR = {
    user: { label: "用户", cls: "actor-user" },
    agent: { label: "agent", cls: "actor-agent" },
    accept: { label: "验收流程", cls: "actor-accept" },
  };

  function lockCard() {
    const lock = S.state.lock;
    const card = el("div", "lock-card" + (lock.holder ? " is-held" : ""));
    const head = el("header", "lock-head");
    head.innerHTML = GW.icon("lock", 15) + "<b>仓库锁</b>";
    card.append(head);
    if (!lock.holder) {
      card.append(el("p", "lock-line", "空闲 —— 页面操作与 agent 的 git 操作在同一条队列上串行，谁也不会踩谁。"));
    } else {
      const held = el("p", "lock-line is-busy");
      held.innerHTML = '<span class="lock-dot"></span>被占用：' + lock.holder.reason + "（" + ACTOR[lock.holder.actor].label + "）";
      card.append(held);
      if (lock.queue.length) {
        const q = el("ul", "lock-queue");
        lock.queue.forEach((item, i) => q.append(el("li", null, (i + 1) + ". " + item.label + " —— 排队中，锁释放后自动执行")));
        card.append(q);
      } else {
        card.append(el("p", "lock-line", "此刻你发起的操作会排在它后面，不会失败也不用重试。"));
      }
    }
    return card;
  }

  function logRow(entry) {
    const a = ACTOR[entry.actor] || ACTOR.user;
    const row = el("div", "oplog-row" + (entry.result === "fail" ? " is-fail" : ""));
    row.append(el("span", "oplog-time", GW.timeAgo(entry.time)));
    row.append(el("span", "actor-chip " + a.cls, a.label));
    const main = el("span", "oplog-main");
    main.append(el("b", null, entry.summary));
    main.append(el("code", "oplog-cmd", "$ " + entry.cmd));
    row.append(main);
    row.append(el("span", "oplog-result " + (entry.result === "ok" ? "is-ok" : "is-fail"), entry.result === "ok" ? "成功" : "失败"));
    if (entry.undoable && entry.snap) {
      const undo = btn("mini-btn", null, async () => {
        const okGo = await GW.confirmDialog({
          title: "撤销这次操作？",
          body: "回放「" + entry.summary + "」之前的仓库快照。此后（含它自己）的页面操作效果都会回退。",
          confirmText: "撤销", safety: false,
        });
        if (okGo) GW.report(ops.undo(entry.id));
      });
      undo.innerHTML = GW.icon("undo", 12) + "<span>撤销</span>";
      row.append(undo);
    } else {
      row.append(el("span", "oplog-noundo", entry.result === "ok" ? "—" : ""));
    }
    return row;
  }

  GW.views = GW.views || {};
  GW.views.oplog = {
    title: "操作日志", icon: "oplog",
    render(container) {
      const wrap = el("div", "oplog-view scroll-col");
      wrap.dataset.scrollKey = "oplog";
      wrap.append(lockCard());
      const head = el("header", "view-head");
      head.append(el("b", null, "操作流水"),
        el("i", "group-hint", "页面上每个 git 动作都留痕：谁、什么命令、结果如何；危险操作自动带快照"));
      wrap.append(head);
      const list = el("div", "oplog-list");
      [...S.state.oplog].reverse().forEach((entry) => list.append(logRow(entry)));
      wrap.append(list);
      container.append(wrap);
    },
  };
})();
