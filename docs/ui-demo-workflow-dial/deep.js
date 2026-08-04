/* 第二层：折起来的编排面板 —— 展开才出现。
   一行一站，点开那一行才有参数；参数是一个个小词，点一下弹出它自己的几个选项。 */
(function (global) {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var deep = document.getElementById("deep");
  var opener = document.getElementById("opener");
  var popBox = document.getElementById("pop");
  var open = false, expanded = null, pop = null;

  function failText(s) {
    var f = s.fail;
    if (!f) return "这一步不判成败";
    if (f.mode === "stop") return "停下等人";
    if (f.mode === "ask") return "问我一句";
    var j = WF.indexOf(f.backTo);
    return "回第 " + (j + 1) + " 站，最多 " + f.max + " 轮";
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // ── 渲染 ────────────────────────────────────────────────────────────
  function render() {
    if (!open) return;
    var h = ['<div class="rows">', gap(0)];
    S.steps.forEach(function (s, i) {
      var k = K[s.kind], on = expanded === s.id;
      h.push('<div class="drow" data-on="' + on + '" style="--tone:' + k.hue + '">');
      h.push('<button class="head" data-open="' + s.id + '"><span class="no">' + pad(i + 1) + "</span>" +
        '<span class="nm">' + esc(k.title(s.p)) + "</span>" +
        '<span class="sm">' + esc(k.summary(s.p)) + "</span>" +
        '<span class="fx" data-none="' + (!s.fail) + '">' + esc(failText(s)) + '</span><i>▾</i></button>');
      if (on) h.push(body(s, i));
      h.push("</div>", gap(i + 1));
    });
    h.push("</div>", gate());
    deep.innerHTML = h.join("");
  }

  function gap(i) {
    return '<div class="gap"><button data-ins="' + i + '"><span>＋</span>在这儿加一站</button></div>';
  }

  function body(s, i) {
    var k = K[s.kind], h = ['<div class="dbody">'];
    k.fields.forEach(function (f) {
      var v = s.p[f.key];
      var text = f.type === "checks" ? (v.length ? v.join("、") : "还没选") : v;
      h.push('<button class="cell" data-edit="' + s.id + '" data-field="' + f.key + '">' +
        "<em>" + esc(f.label) + "</em><b>" + esc(text) + "</b></button>");
    });
    if (s.fail) {
      h.push('<button class="cell" data-edit="' + s.id + '" data-field="fail">' +
        "<em>没过怎么办</em><b>" + esc(failText(s)) + "</b></button>");
    }
    h.push('<div class="ops">' +
      '<button data-op="left" data-id="' + s.id + '"' + (i ? "" : " disabled") + '>↑ 往前挪</button>' +
      '<button data-op="right" data-id="' + s.id + '"' + (i < S.steps.length - 1 ? "" : " disabled") + '>↓ 往后挪</button>' +
      '<button class="del" data-op="del" data-id="' + s.id + '">删掉这一站</button></div>');
    return h.join("") + "</div>";
  }

  function gate() {
    var r = WF.compile();
    var h = ['<div class="gate" data-bad="' + r.denied + '"><b>' +
      (r.denied ? "这样存不下去" : "这样可以存") + "</b>"];
    r.rows.forEach(function (row) {
      h.push('<span class="g ' + row[0] + '">' + esc(row[1]) + "</span>");
    });
    return h.join("") + "</div>";
  }

  // ── 微菜单 ──────────────────────────────────────────────────────────
  function closePop() { pop = null; popBox.setAttribute("hidden", ""); popBox.innerHTML = ""; }
  // 锚点存选择器：改一个参数就要重渲染整块，原来那个按钮已经不在文档里了
  function selOf(el) {
    var d = el.dataset;
    if (d.ins !== undefined) return '[data-ins="' + d.ins + '"]';
    if (d.edit !== undefined) return '[data-edit="' + d.edit + '"][data-field="' + d.field + '"]';
    return null;
  }
  function drawPop() {
    if (!pop) return;
    var html = pop.kind === "add" ? addHtml() : pop.field === "fail" ? failHtml() : fieldHtml();
    if (html == null) return closePop();
    popBox.removeAttribute("hidden");
    popBox.innerHTML = '<div class="inner">' + html + "</div>";
    var at = (pop.sel && document.querySelector(pop.sel)) || pop.anchor;
    if (!at) return closePop();
    var r = at.getBoundingClientRect(), w = popBox.offsetWidth, hh = popBox.offsetHeight;
    var x = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 12));
    var y = r.bottom + 7 + hh > innerHeight - 12 ? Math.max(12, r.top - 7 - hh) : r.bottom + 7;
    popBox.style.left = x + "px"; popBox.style.top = y + "px";
  }
  function addHtml() {
    return "<h3>加一站</h3>" + Object.keys(K).map(function (kind) {
      var k = K[kind];
      return '<button class="opt one" data-add="' + kind + '" style="--tone:' + k.hue + '">' +
        '<i class="d"></i><b>' + esc(k.label) + "</b><span>" + esc(WFSIM.STATUS[kind].text) + "</span></button>";
    }).join("");
  }
  function fieldHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return null;
    var f = null;
    K[s.kind].fields.forEach(function (x) { if (x.key === pop.field) f = x; });
    if (!f) return null;
    var v = s.p[f.key], h = ["<h3>" + esc(f.label) + "</h3>"];
    if (f.type === "checks") {
      f.options.forEach(function (o) {
        h.push('<button class="opt one" data-check="' + esc(o) + '" data-id="' + s.id + '" data-on="' +
          (v.indexOf(o) >= 0) + '"><i>✓</i>' + esc(o) + "</button>");
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
    var f = s.fail, i = WF.indexOf(s.id), h = ["<h3>这一站没过，往哪走</h3>"];
    WF.FAIL_MODES.forEach(function (m) {
      h.push('<button class="opt one" data-fail="mode" data-id="' + s.id + '" data-val="' + m[0] +
        '" data-on="' + (f.mode === m[0]) + '"><i>✓</i>' + esc(m[1]) + "</button>");
    });
    if (f.mode === "back") {
      h.push('<div class="sub">回哪一站</div>');
      if (!i) h.push('<div class="none">前面没有站可回 —— 这条会被拦下</div>');
      S.steps.slice(0, i).forEach(function (t, j) {
        h.push('<button class="opt one" data-fail="backTo" data-id="' + s.id + '" data-val="' + t.id +
          '" data-on="' + (t.id === f.backTo) + '"><i>✓</i>第 ' + (j + 1) + " 站 · " + esc(K[t.kind].label) + "</button>");
      });
      h.push('<div class="sub">最多几轮</div><div class="seg">' + [1, 2, 3].map(function (n) {
        return '<button data-fail="max" data-id="' + s.id + '" data-val="' + n + '" data-on="' +
          (f.max === n) + '">' + n + " 轮</button>";
      }).join("") + "</div>");
    }
    return h.join("");
  }

  function edit(fn) { fn(); global.WFDIAL.refresh(true); }

  // ── 事件 ────────────────────────────────────────────────────────────
  opener.addEventListener("click", function () {
    open = !open;
    opener.setAttribute("aria-expanded", String(open));
    if (open) { deep.removeAttribute("hidden"); render(); } else { deep.setAttribute("hidden", ""); closePop(); }
  });

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-open],[data-ins],[data-add],[data-op],[data-edit],[data-set],[data-check],[data-fail],[data-close]");
    if (!t) { if (!popBox.contains(e.target)) closePop(); return; }
    var d = t.dataset;

    if (d.open !== undefined) { expanded = expanded === d.open ? null : d.open; closePop(); render(); return; }
    if (d.close) return closePop();
    if (d.ins !== undefined) { pop = { kind: "add", anchor: t, sel: selOf(t), at: Number(d.ins) }; drawPop(); return; }
    if (d.add) {
      var at = pop ? pop.at : null, made = null;
      closePop();
      edit(function () { made = WF.insert(d.add, at); });
      if (made) expanded = made.id;
      render();
      return;
    }
    if (d.op) {
      edit(function () {
        if (d.op === "del") { WF.remove(d.id); if (expanded === d.id) expanded = null; }
        if (d.op === "left") WF.move(d.id, -1);
        if (d.op === "right") WF.move(d.id, 1);
      });
      closePop(); render(); return;
    }
    if (d.edit) {
      var same = pop && pop.stepId === d.edit && pop.field === d.field;
      if (same) return closePop();
      pop = { kind: "field", anchor: t, sel: selOf(t), stepId: d.edit, field: d.field };
      drawPop(); return;
    }
    if (d.set !== undefined) { edit(function () { WF.get(d.id).p[d.set] = d.val; }); closePop(); render(); return; }
    if (d.check !== undefined) {
      edit(function () {
        var arr = WF.get(d.id).p.checks, k = arr.indexOf(d.check);
        if (k >= 0) arr.splice(k, 1); else arr.push(d.check);
      });
      render(); drawPop(); return;
    }
    if (d.fail) {
      edit(function () {
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
      render();
      if (d.fail === "backTo") closePop(); else drawPop();
    }
  });

  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });
  window.addEventListener("resize", closePop);

  global.WFDEEP = { render: render };
})(window);
