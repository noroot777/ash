/* 壳子：作用域 / 模板 / 工作区 / 编译闸 / 就地微菜单。
   微菜单的规矩：点哪个字段就只弹哪个字段的选项，点一下即改完关掉。 */
(function () {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var el = {
    scopes: document.getElementById("scopes"), inh: document.getElementById("inh"),
    tpls: document.getElementById("tpls"), ws: document.getElementById("ws"),
    check: document.getElementById("check"), pop: document.getElementById("pop"),
    worst: document.getElementById("worst"), log: document.getElementById("log"),
  };
  var pop = null, note = "";

  // ── 渲染 ────────────────────────────────────────────────────────────
  function renderScopes() {
    var cur = WFSCOPE.current();
    el.scopes.innerHTML = WFSCOPE.SCOPES.map(function (sc) {
      return '<button data-scope="' + sc.key + '" data-on="' + (sc.key === cur) + '"><b>' +
        esc(sc.name) + "</b><span>" + esc(sc.sub) + "</span></button>";
    }).join("");

    var h = [];
    if (WFSCOPE.inheriting()) {
      h.push('<span class="pill">继承自「' + esc(WFSCOPE.ownerName()) + '」</span>' +
        "<span class='hint'>在这儿动一下，就会分出这一层自己的一份</span>");
    } else if (cur !== "sys") {
      h.push('<span class="pill on">这一层自己有一份</span>' +
        '<button class="reset" data-reset="1">恢复继承</button>');
    } else {
      var ov = WFSCOPE.overridden();
      h.push('<span class="pill on">这是兜底的那一份</span><span class="hint">' +
        (ov.length ? "注意：" + ov.join("、") + " 已经自己改过，改这里不会影响它们" : "所有项目、所有任务都跟着它走") +
        "</span>");
    }
    if (note) h.push('<span class="note">' + esc(note) + "</span>");
    el.inh.innerHTML = h.join("");
  }

  function renderTpls() {
    el.tpls.innerHTML = Object.keys(WF.TEMPLATES).map(function (key) {
      return '<button data-tpl="' + key + '" data-on="' + (key === S.tpl) + '" title="' +
        esc(WF.TEMPLATES[key].desc) + '">' + esc(WF.TEMPLATES[key].name) + "</button>";
    }).join("") + (S.tpl ? "" : '<span class="custom">已改成自定义</span>');
    el.ws.innerHTML =
      '<button data-ws="isolated" data-on="' + (S.workspace === "isolated") + '">独立 worktree</button>' +
      '<button data-ws="shared" data-on="' + (S.workspace === "shared") + '">项目目录</button>';
    el.worst.textContent = WFRIDE.worstLine();
  }

  function renderCheck() {
    var r = WF.compile();
    var h = ['<div class="in"><div class="chd"><span class="led' + (r.denied ? " bad" : "") + '"></span><b>' +
      (r.denied ? "这条线存不下去" : "这条线可以保存") + "</b><span>" + esc(WF.digest()) + "</span></div>"];
    r.rows.forEach(function (row) {
      var tag = row[0] === "deny" ? "DENY" : row[0] === "warn" ? "WARN" : "PASS";
      h.push('<div class="line ' + row[0] + '"><em>' + tag + "</em><span>" + esc(row[1]) + "</span></div>");
    });
    el.check.innerHTML = h.join("") + "</div>";
    el.check.setAttribute("data-bad", String(r.denied));
  }

  function render() { renderScopes(); renderTpls(); WFMAP.render(); renderCheck(); }

  // 改之前先分层，改之后存回本层
  function edit(fn) {
    WFRIDE.stop();
    WFSCOPE.touch();
    var forked = WFSCOPE.tookOver();
    fn();
    WFSCOPE.save();
    note = forked ? "已从「" + forked + "」分出一份，只影响这一层" : "";
    render();
  }

  // ── 微菜单 ──────────────────────────────────────────────────────────
  function place(anchor, w, h) {
    var r = anchor.getBoundingClientRect();
    var x = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 12));
    var y = r.bottom + 7;
    if (y + h > window.innerHeight - 12) y = Math.max(12, r.top - 7 - h);
    return { x: x, y: y };
  }
  function closePop() { pop = null; el.pop.setAttribute("hidden", ""); el.pop.innerHTML = ""; }
  function openPop(anchor, kind, data) {
    pop = { kind: kind, anchor: anchor };
    Object.keys(data || {}).forEach(function (k) { pop[k] = data[k]; });
    drawPop();
  }
  function drawPop() {
    if (!pop) return;
    var html = pop.kind === "add" ? addHtml() : pop.kind === "fail" ? failHtml() : fieldHtml();
    if (html == null) return closePop();
    el.pop.removeAttribute("hidden");
    el.pop.innerHTML = '<div class="inner">' + html + "</div>";
    var p = place(pop.anchor, el.pop.offsetWidth, el.pop.offsetHeight);
    el.pop.style.left = p.x + "px";
    el.pop.style.top = p.y + "px";
  }

  function addHtml() {
    return '<h3>在这一段上加一站</h3>' + Object.keys(K).map(function (kind) {
      var k = K[kind];
      return '<button class="kind" data-add="' + kind + '" style="--tone:' + WFMAP.tone(k.hue) + '">' +
        '<span class="code">' + k.code + "</span><b>" + esc(k.label) + "</b>" +
        '<span class="st">' + esc(WFSIM.STATUS[kind].text) + "</span></button>";
    }).join("");
  }

  function fieldHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return null;
    var k = K[s.kind], f = null;
    k.fields.forEach(function (x) { if (x.key === pop.field) f = x; });
    if (!f) return null;
    var v = s.p[f.key];
    var h = ["<h3>" + esc(f.label) + "</h3>"];
    if (f.type === "checks") {
      f.options.forEach(function (o) {
        h.push('<div class="opt" data-check="' + esc(o) + '" data-id="' + s.id + '" data-on="' +
          (v.indexOf(o) >= 0) + '"><i>✓</i>' + esc(o) + "</div>");
      });
      h.push('<div class="ft"><span>全过才算通过</span><button data-close="1">好了</button></div>');
    } else {
      f.options.forEach(function (o) {
        h.push('<button class="opt one" data-set="' + f.key + '" data-id="' + s.id + '" data-val="' +
          esc(o) + '" data-on="' + (o === v) + '"><i>✓</i>' + esc(o) + "</button>");
      });
    }
    return h.join("");
  }

  function failHtml() {
    var s = WF.get(pop.stepId);
    if (!s || !s.fail) return null;
    var f = s.fail, i = WF.indexOf(s.id);
    var h = ["<h3>这一站失败了，车往哪开</h3>"];
    WF.FAIL_MODES.forEach(function (m) {
      h.push('<button class="opt one" data-fail="mode" data-id="' + s.id + '" data-val="' + m[0] +
        '" data-on="' + (f.mode === m[0]) + '"><i>✓</i>' + esc(m[1]) + "</button>");
    });
    if (f.mode === "back") {
      h.push('<div class="sub">拐回哪一站</div>');
      if (!i) h.push('<div class="none">前面没有站可回 —— 这条线会被拦下</div>');
      S.steps.slice(0, i).forEach(function (t, j) {
        h.push('<button class="opt one" data-fail="backTo" data-id="' + s.id + '" data-val="' + t.id +
          '" data-on="' + (t.id === f.backTo) + '"><i>✓</i>第 ' + (j + 1) + " 站 · " + esc(K[t.kind].label) + "</button>");
      });
      h.push('<div class="sub">最多重来几轮</div><div class="seg">' + [1, 2, 3].map(function (n) {
        return '<button data-fail="max" data-id="' + s.id + '" data-val="' + n + '" data-on="' +
          (f.max === n) + '">' + n + " 轮</button>";
      }).join("") + "</div>");
    }
    return h.join("");
  }

  // ── 事件 ────────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-scope],[data-reset],[data-tpl],[data-ws],[data-ride],[data-ins]," +
      "[data-add],[data-op],[data-edit],[data-set],[data-check],[data-fail],[data-close]");
    if (!t) { if (!el.pop.contains(e.target)) closePop(); return; }
    var d = t.dataset;

    if (d.scope) { WFRIDE.stop(); closePop(); note = ""; WFSCOPE.switchTo(d.scope); render(); return; }
    if (d.reset) { WFRIDE.stop(); closePop(); note = "已恢复继承"; WFSCOPE.reset(); render(); return; }
    if (d.ride) return ride(d.ride);
    if (d.close) return closePop();

    if (d.tpl) { closePop(); edit(function () { WF.loadTemplate(d.tpl); S.tpl = d.tpl; }); return; }
    if (d.ws) { edit(function () { S.workspace = d.ws; }); return; }
    if (d.ins) { openPop(t, "add", { at: Number(d.ins) }); return; }

    if (d.add) {
      var at = pop ? pop.at : null, made = null;
      closePop();
      edit(function () { S.tpl = null; made = WF.insert(d.add, at); });
      if (made) flash(made.id);
      return;
    }
    if (d.op) {
      var keep = pop && pop.stepId === d.id ? null : pop;
      edit(function () {
        S.tpl = null;
        if (d.op === "del") WF.remove(d.id);
        if (d.op === "left") WF.move(d.id, -1);
        if (d.op === "right") WF.move(d.id, 1);
      });
      if (!keep) closePop(); else drawPop();
      return;
    }
    if (d.edit) {
      var same = pop && pop.stepId === d.edit && pop.field === d.field;
      if (same) return closePop();
      openPop(t, d.field === "fail" ? "fail" : "field", { stepId: d.edit, field: d.field });
      return;
    }
    if (d.set !== undefined) {
      edit(function () { S.tpl = null; WF.get(d.id).p[d.set] = d.val; });
      closePop();
      return;
    }
    if (d.check !== undefined) {
      edit(function () {
        S.tpl = null;
        var arr = WF.get(d.id).p.checks, k = arr.indexOf(d.check);
        if (k >= 0) arr.splice(k, 1); else arr.push(d.check);
      });
      drawPop();
      return;
    }
    if (d.fail) {
      edit(function () {
        S.tpl = null;
        var f = WF.get(d.id).fail;
        if (d.fail === "mode") {
          f.mode = d.val;
          if (f.mode === "back" && !f.backTo) {
            var idx = WF.indexOf(d.id), pick = null;
            S.steps.slice(0, idx).forEach(function (s) { if (s.kind === "run") pick = s.id; });
            f.backTo = pick || (idx > 0 ? S.steps[0].id : null);
          }
        }
        if (d.fail === "backTo") f.backTo = d.val;
        if (d.fail === "max") f.max = Number(d.val);
      });
      if (d.fail === "backTo") closePop(); else drawPop();
    }
  });

  function flash(id) {
    var els = WFMAP.rail.querySelectorAll('[data-stn="' + id + '"]');
    els.forEach(function (x) { x.classList.add("fresh"); });
    setTimeout(function () { els.forEach(function (x) { x.classList.remove("fresh"); }); }, 900);
  }

  function ride(mode) {
    closePop();
    if (mode === "stop") { WFRIDE.stop(); toggleRideBtns(false); return; }
    WFRIDE.start(mode, function () { toggleRideBtns(false); });
    toggleRideBtns(true);
  }
  function toggleRideBtns(on) {
    document.querySelectorAll("[data-ride]").forEach(function (b) {
      var isStop = b.dataset.ride === "stop";
      if (isStop === on) b.removeAttribute("hidden"); else b.setAttribute("hidden", "");
    });
  }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (pop) closePop(); else WFRIDE.stop();
  });
  window.addEventListener("resize", function () { WFMAP.drawArcs(); closePop(); });

  WFSCOPE.init("frontend");
  render();
})();
