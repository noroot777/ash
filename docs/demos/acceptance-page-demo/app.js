// 状态、事件、计时。画法在 parts.js，假数据在 data.js。
(() => {
  const { SCENES, LOG_RUNNING } = window.ACC;
  const parts = window.ACC_PARTS;
  const root = document.getElementById("acc");
  const sim = document.getElementById("sim");
  const seal = document.getElementById("seal");
  const scenes = document.getElementById("scenes");

  // s = 任务此刻的事实；ui = 这一屏自己的事（开着哪一层、看的哪个文件）。
  let s = SCENES[0].make();
  const ui = { scene: SCENES[0].id, pop: null, file: 0, left: null, draft: null, logAt: LOG_RUNNING.length };

  scenes.innerHTML = SCENES.map((scene) => `<button type="button" data-scene="${scene.id}">${scene.label}</button>`).join("");

  function render() {
    root.innerHTML = ui.left ? parts.left(ui.left) : parts.bar(s, ui) + parts.checks(s, ui) + parts.diff(ui);
    sim.hidden = !!ui.left || s.gate.status !== "running";
    seal.classList.toggle("is-on", !ui.left);
    for (const button of scenes.children) button.setAttribute("aria-pressed", String(button.dataset.scene === ui.scene));
    root.querySelector(".pop [data-autofocus]")?.focus({ preventScroll: true });
    // 日志从末尾看起：红在哪一条、跑到哪了，都在最后几行。
    const log = root.querySelector("[data-log]");
    if (log) log.scrollTop = log.scrollHeight;
  }

  function enter(sceneId) {
    s = SCENES.find((scene) => scene.id === sceneId).make();
    Object.assign(ui, { scene: sceneId, pop: null, file: 0, left: null, draft: null, logAt: LOG_RUNNING.length });
    render();
  }

  // 关掉确认层，这一按的开关就回到项目默认：留着上次的选择，等于一个没人记得设过的隐形开关。
  function closePop() {
    if (ui.pop === "confirm") Object.assign(s, { skip: false, rerun: false, commit: true });
    ui.pop = null;
    ui.draft = null;
  }

  function openPop(name) {
    const same = ui.pop === name;
    closePop();
    if (same) return;
    ui.pop = name;
    if (name === "gate") ui.draft = { command: s.gate.command, prepare: s.gate.prepare, baseline: s.gate.baseline };
  }

  function settle(mode) {
    s.accepted = { mode, pending: !s.commit };
    s.rows = [];
    s.children = [];
    s.gate.open = false;
    if (mode === "passed") s.gate.status = "passed";
    s.skip = false;
    s.rerun = false;
    ui.scene = s.accepted.pending ? "pending" : "accepted";
  }

  function accept() {
    const gate = s.gate;
    ui.pop = null;
    if (!gate.command) return settle("unset");
    if (s.skip) return settle("skipped");
    if (gate.status === "passed" && !s.rerun) return settle("passed");
    // 要先跑一遍：这一按的选择（提不提交）留到跑完那一刻用。
    Object.assign(gate, { status: "running", elapsed: 0, open: false });
    ui.logAt = 2;
    ui.scene = "running";
  }

  // 每一行自己的那一个出路。交给任务的两种先显示「正在办」，办完这一行就没了。
  const HANDED = { conflict: "任务正在解决冲突", review: "正在审查新改动" };
  function resolveRow(id) {
    const row = s.rows.find((item) => item.id === id);
    if (!row) return;
    if (!HANDED[id]) { row.gone = true; return; }
    row.handed = HANDED[id];
    const owner = s;
    window.setTimeout(() => {
      if (owner !== s) return;
      row.gone = true;
      render();
    }, 3600);
  }

  const ACTS = {
    pop: (name) => (name === "close" ? closePop() : openPop(name)),
    // 「运行」那一勾：已经有一次还作数的绿时，勾上是重跑；否则取消就是这次跳过。
    flag: (name) => {
      if (name === "commit") s.commit = !s.commit;
      else if (s.gate.status === "passed") s.rerun = !s.rerun;
      else s.skip = !s.skip;
    },
    accept,
    reject: () => {
      const text = root.querySelector("[data-reject]")?.value.trim();
      if (!text) return false;
      closePop();
      ui.left = { text };
    },
    leave: () => { closePop(); ui.left = { text: "" }; },
    target: (branch) => { s.target = branch; closePop(); },
    gate: (verb) => {
      if (verb === "toggle") s.gate.open = !s.gate.open;
      if (verb === "stop") Object.assign(s.gate, { status: "stopped", open: false });
      if (verb === "save") {
        Object.assign(s.gate, { command: ui.draft.command.trim(), prepare: ui.draft.prepare.trim(), baseline: ui.draft.baseline });
        // 命令换了，原来那次结果就不是这一条的了。
        if (!["running"].includes(s.gate.status)) Object.assign(s.gate, { status: "idle", open: false });
        closePop();
      }
    },
    baseline: (id) => { ui.draft.baseline = id; },
    row: resolveRow,
    child: (index) => { s.children[index].checked = !s.children[index].checked; },
    pending: () => { s.accepted.pending = false; ui.scene = "accepted"; },
    file: (index) => { ui.file = Number(index); },
    noop: () => false,
  };

  function run(el) {
    const [name, arg] = el.dataset.act.split(/:(.*)/);
    // 点的是层外面的东西，先把开着的那一层收掉。
    if (ui.pop && name !== "pop" && !el.closest(".pop")) closePop();
    if (ACTS[name]?.(arg) !== false) render();
  }

  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-act]");
    if (el?.tagName === "A") event.preventDefault();
    if (el && el.tagName !== "INPUT") return run(el);
    if (!el && ui.pop && !event.target.closest(".pop")) { closePop(); render(); }
  });
  // 勾选走 change：点 label 会再合成一次落在 input 上的 click，两头都接就翻两次。
  document.addEventListener("change", (event) => {
    if (event.target.matches("input[type=checkbox][data-act]")) run(event.target);
  });
  // 设置层里打字不重画（重画会丢光标），只记进草稿。
  document.addEventListener("input", (event) => {
    const key = event.target.dataset?.draft;
    if (key && ui.draft) ui.draft[key] = event.target.value;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.pop) { closePop(); render(); }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.target.matches("[data-reject]")) {
      if (ACTS.reject() !== false) render();
    }
    if (event.key === "Enter" && event.target.matches("[data-draft]")) { ACTS.gate("save"); render(); }
  });

  scenes.addEventListener("click", (event) => {
    const button = event.target.closest("[data-scene]");
    if (button) enter(button.dataset.scene);
  });
  seal.addEventListener("click", () => {
    closePop();
    ui.left = ui.left ? null : { text: "" };
    render();
  });
  sim.addEventListener("click", (event) => {
    const outcome = event.target.closest("[data-sim]")?.dataset.sim;
    if (!outcome || s.gate.status !== "running") return;
    if (outcome === "pass") settle("passed");
    else { Object.assign(s.gate, { status: "failed", open: true }); ui.scene = "failed"; }
    render();
  });

  // 在跑的那一行每秒只改它自己的两处字，不整屏重画：重画会把开着的层和悬停状态打掉。
  window.setInterval(() => {
    if (s.gate.status !== "running") return;
    s.gate.elapsed += 1;
    const elapsed = root.querySelector("[data-elapsed]");
    if (elapsed) elapsed.textContent = parts.clock(s.gate.elapsed);
    if (s.gate.elapsed % 2 === 0 && ui.logAt < LOG_RUNNING.length) {
      ui.logAt += 1;
      const log = root.querySelector("[data-log]");
      if (log) { log.textContent = LOG_RUNNING.slice(0, ui.logAt).join("\n"); log.scrollTop = log.scrollHeight; }
    }
  }, 1000);

  render();
})();
