/* 工作台装配 —— 历史（撤销/重做）、选中、键盘、⌘K、拖拽回调 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var rail = $("rail"), lib = $("lib"), insp = $("insp"), check = $("check"), sim = $("sim");
  var cmdk = $("cmdk"), cq = $("cq"), clist = $("clist"), ghost = $("ghost"), wire = $("wire");

  WFVIEW.mount({ rail: rail, lib: lib, insp: insp, check: check, sim: sim });

  var sel = null, saved = "", tpl = "standard";
  var simOpen = false, assume = {};
  var past = [], future = [];
  var cmdItems = [], cmdAt = 0;

  function snap() { return JSON.stringify({ w: WF.state.workspace, s: WF.state.steps, sel: sel, tpl: tpl }); }
  function restore(j) {
    var o = JSON.parse(j);
    WF.state.workspace = o.w; WF.state.steps = o.s; sel = o.sel; tpl = o.tpl;
  }
  // 每次改动前记一张快照 —— 撤销栈是「放开自由编排」的另一半安全网
  function edit(fn) {
    past.push(snap()); if (past.length > 60) past.shift();
    future.length = 0;
    fn();
    saved = "";
    render();
  }
  function undo() { if (!past.length) return; future.push(snap()); restore(past.pop()); saved = ""; render(); }
  function redo() { if (!future.length) return; past.push(snap()); restore(future.pop()); saved = ""; render(); }

  // ── 渲染 ─────────────────────────────────────────────────────────────
  function render() {
    if (sel && !WF.get(sel)) sel = null;
    Object.keys(assume).forEach(function (id) { if (!WF.get(id)) delete assume[id]; });

    $("dg").textContent = WF.digest();
    $("ws").innerHTML = WF.state.workspace === "isolated"
      ? "工作区 <b>独立 worktree</b>" : "工作区 <b>直接在项目里</b>";
    $("tpls").innerHTML = Object.keys(WF.TEMPLATES).map(function (k) {
      return '<button data-tpl="' + k + '" data-on="' + (k === tpl) + '" title="' +
        WF.esc(WF.TEMPLATES[k].desc) + '">' + WF.esc(WF.TEMPLATES[k].name) + "</button>";
    }).join("");
    document.querySelector('[data-op="undo"]').disabled = !past.length;
    document.querySelector('[data-op="redo"]').disabled = !future.length;

    WFVIEW.renderRail(sel);
    WFVIEW.renderInsp(sel);
    WFVIEW.renderCheck(saved);
    WFVIEW.renderSim(assume, simOpen);
  }

  // ── 操作 ─────────────────────────────────────────────────────────────
  function pick(id) { sel = id; render(); scrollTo(id); }
  function scrollTo(id) {
    var e = rail.querySelector('.step[data-id="' + id + '"]');
    if (e) e.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function addKind(kind, at) {
    edit(function () { sel = WF.insert(kind, at).id; });
    scrollTo(sel);
  }
  function del(id) {
    var i = WF.indexOf(id);
    edit(function () {
      WF.remove(id);
      var n = WF.state.steps;
      sel = n.length ? (n[Math.min(i, n.length - 1)] || n[0]).id : null;
    });
  }
  function moveSel(dir) {
    if (!sel) return;
    edit(function () { WF.move(sel, dir); });
    scrollTo(sel);
  }
  function selectBy(delta) {
    var n = WF.state.steps;
    if (!n.length) return;
    var i = sel ? WF.indexOf(sel) + delta : (delta > 0 ? 0 : n.length - 1);
    pick(n[Math.max(0, Math.min(n.length - 1, i))].id);
  }

  // ── 点击 ─────────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var t = e.target, hit;

    if ((hit = t.closest("[data-tpl]"))) {
      return edit(function () { tpl = hit.dataset.tpl; WF.loadTemplate(tpl); sel = WF.state.steps[0].id; assume = {}; });
    }
    if ((hit = t.closest("[data-op]"))) {
      var op = hit.dataset.op;
      if (op === "undo") return undo();
      if (op === "redo") return redo();
      if (op === "sim") { simOpen = !simOpen; return render(); }
      if (op === "cmdk") return openK();
      if (op === "del") return del(hit.dataset.id);
    }
    if (t.closest("#ws")) {
      return edit(function () { WF.state.workspace = WF.state.workspace === "isolated" ? "shared" : "isolated"; });
    }
    if ((hit = t.closest("[data-lib]"))) return addKind(hit.dataset.lib, null);

    if ((hit = t.closest("button[data-set]"))) {                      // 分段选择
      return edit(function () { WF.get(hit.dataset.id).p[hit.dataset.set] = hit.dataset.val; });
    }
    if ((hit = t.closest("[data-check]"))) {                          // 多选项
      return edit(function () {
        var s = WF.get(hit.dataset.id), v = hit.dataset.check, a = s.p.checks, i = a.indexOf(v);
        if (i >= 0) a.splice(i, 1); else a.push(v);
      });
    }
    if ((hit = t.closest("button[data-fail]"))) {
      return edit(function () {
        var s = WF.get(hit.dataset.id), key = hit.dataset.fail;
        if (key === "max") { s.fail.max = Number(hit.dataset.val); return; }
        s.fail.mode = hit.dataset.val;
        if (s.fail.mode === "back" && !s.fail.backTo) {
          var i = WF.indexOf(s.id);
          s.fail.backTo = i > 0 ? WF.state.steps[0].id : null;
        }
      });
    }
    if (t.closest("[data-save]")) {
      saved = "已保存为项目默认工作流；正在跑的任务用它开跑时的快照，不受影响。";
      return render();
    }
    if ((hit = t.closest("[data-assume]"))) {                          // 预演假设：顺利 → 头一次不过 → 一直不过
      var id = hit.dataset.assume, cur = assume[id] || "ok";
      var order = WFSIM.MODES.map(function (m) { return m[0]; });
      assume[id] = order[(order.indexOf(cur) + 1) % order.length];
      return WFVIEW.renderSim(assume, true);
    }
    if (t.closest("[data-replay]")) return WFVIEW.renderSim(assume, true);
    if (t.closest("[data-simclose]")) { simOpen = false; return render(); }

    if ((hit = t.closest(".step"))) return pick(hit.dataset.id);
    if (t.closest(".cmdk") && !t.closest(".cmdk-box")) return closeK();
    if ((hit = t.closest(".citem"))) return runCmd(cmdItems[Number(hit.dataset.i)]);
  });

  document.addEventListener("change", function (e) {
    var s = e.target;
    if (s.dataset.set) return edit(function () { WF.get(s.dataset.id).p[s.dataset.set] = s.value; });
    if (s.dataset.fail === "backTo") return edit(function () { WF.get(s.dataset.id).fail.backTo = s.value || null; });
  });
  document.addEventListener("input", function (e) {
    if (e.target.dataset && e.target.dataset.input) {
      var s = e.target;
      past.push(snap()); WF.get(s.dataset.id).p[s.dataset.input] = s.value;
      WFVIEW.renderCheck("");
    }
    if (e.target === cq) { cmdAt = 0; drawK(); }
  });

  // ── 键盘 ─────────────────────────────────────────────────────────────
  document.addEventListener("keydown", function (e) {
    var meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "k") { e.preventDefault(); return cmdk.hidden ? openK() : closeK(); }
    if (!cmdk.hidden) return keysInK(e);
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;

    if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (meta && e.key === "ArrowUp") { e.preventDefault(); return moveSel(-1); }
    if (meta && e.key === "ArrowDown") { e.preventDefault(); return moveSel(1); }
    if (e.key === "ArrowUp") { e.preventDefault(); return selectBy(-1); }
    if (e.key === "ArrowDown") { e.preventDefault(); return selectBy(1); }
    if ((e.key === "Backspace" || e.key === "Delete") && sel) { e.preventDefault(); return del(sel); }
    if (e.key.toLowerCase() === "r") { simOpen = !simOpen; return render(); }
    if (e.key === "Escape") { sel = null; return render(); }
  });

  // ── ⌘K ───────────────────────────────────────────────────────────────
  function buildCmds() {
    var out = [];
    Object.keys(WF.KINDS).forEach(function (k) {
      var K = WF.KINDS[k];
      out.push({ t: "加一关：" + K.label, h: sel ? "插在选中那一关后面" : "加到末尾", key: K.tag + " " + K.code,
        go: function () { addKind(k, sel ? WF.indexOf(sel) + 1 : null); } });
    });
    Object.keys(WF.TEMPLATES).forEach(function (k) {
      var T = WF.TEMPLATES[k];
      out.push({ t: "换模板：" + T.name, h: T.desc, key: "template " + k,
        go: function () { edit(function () { tpl = k; WF.loadTemplate(k); sel = WF.state.steps[0].id; assume = {}; }); } });
    });
    WF.state.steps.forEach(function (s, i) {
      out.push({ t: "跳到第 " + (i + 1) + " 关 · " + WF.KINDS[s.kind].label, h: WF.KINDS[s.kind].summary(s.p),
        key: "goto " + (i + 1), go: function () { pick(s.id); } });
    });
    out.push({ t: "预演一遍", h: "看这条流程会怎么走", key: "simulate run R", go: function () { simOpen = true; render(); } });
    out.push({ t: "换工作区", h: "独立 worktree ↔ 直接在项目里", key: "workspace worktree",
      go: function () { edit(function () { WF.state.workspace = WF.state.workspace === "isolated" ? "shared" : "isolated"; }); } });
    out.push({ t: "撤销", h: "⌘Z", key: "undo", go: undo });
    out.push({ t: "重做", h: "⇧⌘Z", key: "redo", go: redo });
    if (sel) out.push({ t: "删掉选中的关口", h: "⌫", key: "delete remove", go: function () { del(sel); } });
    return out;
  }
  function openK() { cmdk.hidden = false; cq.value = ""; cmdAt = 0; drawK(); cq.focus(); }
  function closeK() { cmdk.hidden = true; }
  function runCmd(c) { if (!c) return; closeK(); c.go(); }
  function drawK() {
    var q = cq.value.trim().toLowerCase();
    cmdItems = buildCmds().filter(function (c) {
      return !q || (c.t + " " + c.h + " " + c.key).toLowerCase().indexOf(q) >= 0;
    });
    cmdAt = Math.max(0, Math.min(cmdItems.length - 1, cmdAt));
    clist.innerHTML = cmdItems.length
      ? cmdItems.map(function (c, i) {
          return '<div class="citem" data-i="' + i + '" data-on="' + (i === cmdAt) + '"><b>' +
            WF.esc(c.t) + '</b><span class="hint">' + WF.esc(c.h) + "</span></div>";
        }).join("")
      : '<div class="citem"><b>没找到</b><span class="hint">换个词试试</span></div>';
    var on = clist.querySelector('[data-on="true"]');
    if (on) on.scrollIntoView({ block: "nearest" });
  }
  function keysInK(e) {
    if (e.key === "Escape") { e.preventDefault(); return closeK(); }
    if (e.key === "ArrowDown") { e.preventDefault(); cmdAt = Math.min(cmdItems.length - 1, cmdAt + 1); return drawK(); }
    if (e.key === "ArrowUp") { e.preventDefault(); cmdAt = Math.max(0, cmdAt - 1); return drawK(); }
    if (e.key === "Enter") { e.preventDefault(); return runCmd(cmdItems[cmdAt]); }
  }

  // ── 拖拽 ─────────────────────────────────────────────────────────────
  WFDND.init({
    rail: rail, lib: lib, wire: wire, ghost: ghost,
    onReorder: function (from, to) {
      edit(function () {
        var a = WF.state.steps, it = a.splice(from, 1)[0];
        a.splice(to, 0, it);
        sel = it.id;
      });
    },
    onInsert: function (kind, at) { addKind(kind, at); },
    onWire: function (fromId, toId) {
      edit(function () {
        var s = WF.get(fromId);
        s.fail.mode = "back"; s.fail.backTo = toId;
        sel = fromId;
      });
    },
    onPick: pick,
  });

  window.addEventListener("resize", function () { WFVIEW.drawLoops(); });

  // ── 起手 ─────────────────────────────────────────────────────────────
  WF.loadTemplate(tpl);
  sel = WF.state.steps[1] ? WF.state.steps[1].id : WF.state.steps[0].id;
  WFVIEW.renderLib();
  render();
})();
