/* 三种编辑范式的渲染与交互 —— 同一份 WF.state，三个壳子 */
(function () {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var mode = "sentence";
  var pop = null;                 // {kind:'params'|'menu', stepId, at, x, y}

  var stage = document.getElementById("stage");
  var compileBox = document.getElementById("compile");
  var popBox = document.getElementById("pop");

  // ── 文案 ────────────────────────────────────────────────────────────
  function failText(step) {
    var f = step.fail;
    if (!f) return "";
    if (f.mode === "stop") return "停下等人";
    if (f.mode === "ask") return "问我一句再决定";
    var j = WF.indexOf(f.backTo);
    return "回到第 " + (j + 1) + " 步重做，最多 " + f.max + " 轮";
  }
  function lead(i, n) { return i === 0 ? "首先，" : i === n - 1 ? "最后，" : i % 2 ? "接着，" : "然后，"; }

  // ── ① 句子式 ────────────────────────────────────────────────────────
  function renderSentence() {
    var n = S.steps.length, h = ['<div class="sent">'];
    h.push('<div class="sent-line"><span class="lead">在</span>' +
      '<span class="btxt"><button class="slot" data-ws="1">' +
      (S.workspace === "isolated" ? "独立 worktree" : "项目目录") + "</button>里干这些事：</span>" +
      '<span class="line-ops">' + ins(0) + "</span></div>");
    S.steps.forEach(function (s, i) {
      var k = K[s.kind];
      h.push('<div class="sent-line"><span class="lead">' + lead(i, n) + '</span><span class="btxt">' +
        k.sentence(s.p, s) +
        (s.fail ? '<span class="tail">，失败就 <button class="slot" data-edit="' + s.id +
          '" data-field="fail">' + esc(failText(s)) + "</button></span>" : "") +
        (i === n - 1 ? "。" : "，") + "</span>" +
        '<span class="line-ops">' + ins(i + 1) +
        '<button class="del" data-op="del" data-id="' + s.id + '" title="删掉这一步">×</button></span></div>');
    });
    h.push("</div>");
    stage.className = "stage pad";
    stage.innerHTML = h.join("");
  }
  function ins(at) { return '<button class="ins" data-ins="' + at + '" title="在这里插一步">＋</button>'; }

  // ── ② 步骤清单 ──────────────────────────────────────────────────────
  function renderList() {
    var h = ['<div class="list">', gap(0)];
    S.steps.forEach(function (s, i) {
      var k = K[s.kind];
      h.push('<div class="card" data-edit="' + s.id + '">' +
        '<div class="no">' + (i + 1) + "</div>" +
        '<div class="body">' +
          '<div class="t">' + esc(k.title(s.p)) + "<small>" + k.tag + "</small></div>" +
          '<div class="s">' + esc(k.summary(s.p)) + "</div>" +
          (s.fail ? '<div class="f">失败 → <b>' + esc(failText(s)) + "</b></div>" : "") +
        "</div>" +
        '<div class="ops">' +
          '<button data-op="up" data-id="' + s.id + '" title="上移">↑</button>' +
          '<button data-op="down" data-id="' + s.id + '" title="下移">↓</button>' +
          '<button data-op="del" data-id="' + s.id + '" title="删除">×</button>' +
        "</div></div>");
      h.push(gap(i + 1));
    });
    h.push("</div>");
    stage.className = "stage";
    stage.innerHTML = h.join("");
    drawLoops();
  }
  function gap(at) { return '<div class="gap"><button data-ins="' + at + '" title="在这里插一步">＋</button></div>'; }

  // 回路是这条链上唯一的非线性结构，画出来比写一行字管用：
  // 从「失败的那一步」往回连到「重做的起点」，长度按真实卡片位置量；
  // 多条回路按跨度排道，跨得短的靠里，免得叠在同一条竖线上看不出有两条。
  function drawLoops() {
    var box = stage.querySelector(".list");
    if (!box) return;
    var br = box.getBoundingClientRect(), loops = [];
    S.steps.forEach(function (s, i) {
      if (!s.fail || s.fail.mode !== "back") return;
      var j = WF.indexOf(s.fail.backTo);
      if (j < 0 || j >= i) return;
      loops.push({ s: s, span: i - j });
    });
    loops.sort(function (a, b) { return a.span - b.span; });
    loops.forEach(function (L, lane) {
      var from = box.querySelector('.card[data-edit="' + L.s.id + '"]');
      var to = box.querySelector('.card[data-edit="' + L.s.fail.backTo + '"]');
      if (!from || !to) return;
      var a = to.getBoundingClientRect(), b = from.getBoundingClientRect();
      var el = document.createElement("div");
      el.className = "loopline";
      el.style.left = Math.max(2, 30 - lane * 13) + "px";
      el.style.top = (a.top - br.top + 12) + "px";
      el.style.height = Math.max(12, b.bottom - a.top - 24) + "px";
      el.setAttribute("data-n", "×" + L.s.fail.max);
      box.appendChild(el);
    });
  }

  // ── ③ 规则表 ────────────────────────────────────────────────────────
  function renderRules() {
    var h = ['<table class="rules"><thead><tr>' +
      "<th>#</th><th>这一步做什么</th><th>谁来做</th><th>成功后</th><th>失败后</th><th></th>" +
      "</tr></thead><tbody>"];
    S.steps.forEach(function (s, i) {
      var k = K[s.kind], who = s.p.executor || (s.kind === "human" ? "我" : "Ash");
      h.push("<tr>" +
        '<td class="n">' + (i + 1) + "</td>" +
        '<td class="what"><button class="cell" data-edit="' + s.id + '">' + esc(k.title(s.p)) + "</button></td>" +
        '<td class="who">' + esc(who) + "</td>" +
        "<td>" + (i === S.steps.length - 1 ? "流程结束" : "第 " + (i + 2) + " 步") + "</td>" +
        "<td>" + (s.fail
          ? '<button class="cell j" data-edit="' + s.id + '" data-field="fail">' + esc(failText(s)) + "</button>"
          : '<span class="who">不会失败</span>') + "</td>" +
        '<td class="ops-td">' +
          '<button class="x" data-op="up" data-id="' + s.id + '" title="上移">↑</button>' +
          '<button class="x" data-op="down" data-id="' + s.id + '" title="下移">↓</button>' +
          '<button class="x" data-op="del" data-id="' + s.id + '" title="删除">×</button></td></tr>');
    });
    h.push('<tr><td></td><td class="addrow" colspan="5">' +
      '<button data-ins="' + S.steps.length + '">＋ 添加一步</button></td></tr>');
    h.push("</tbody></table>");
    stage.className = "stage";
    stage.innerHTML = h.join("");
  }

  // ── 编译条 ──────────────────────────────────────────────────────────
  function renderCompile() {
    var r = WF.compile();
    var h = ['<div class="hd"><span class="dot' + (r.denied ? " bad" : "") + '"></span>' +
      "<b>" + (r.denied ? "这样存不下去" : "可以保存") + '</b><span class="digest">' + esc(WF.digest()) + "</span></div>"];
    r.rows.forEach(function (row) {
      var tag = row[0] === "deny" ? "拒绝" : row[0] === "warn" ? "提醒" : "通过";
      h.push('<div class="msg ' + row[0] + '"><em>' + tag + "</em><p>" + esc(row[1]) + "</p></div>");
    });
    compileBox.innerHTML = h.join("");
  }

  function render() {
    if (mode === "sentence") renderSentence();
    else if (mode === "list") renderList();
    else renderRules();
    renderCompile();
    renderWorkspaceBar();
  }

  function renderWorkspaceBar() {
    var el = document.getElementById("wsbar");
    el.innerHTML = '<span class="k">工作区</span>' +
      '<span class="seg">' +
        '<button data-ws-set="isolated" data-on="' + (S.workspace === "isolated") + '">独立 worktree</button>' +
        '<button data-ws-set="shared" data-on="' + (S.workspace === "shared") + '">项目目录直接改</button>' +
      "</span>" +
      '<span class="sep"></span><span class="k">从模板开始</span>' +
      Object.keys(WF.TEMPLATES).map(function (key) {
        return '<button class="pick" data-tpl="' + key + '">' + esc(WF.TEMPLATES[key].name) + "</button>";
      }).join("");
  }

  // ── 弹层 ────────────────────────────────────────────────────────────
  function place(anchor) {
    var r = anchor.getBoundingClientRect();
    // 面板可能比锚点下方剩的地方还高：放不下就上翻，再不行就贴顶滚动
    var w = 350, h = 470;
    var x = Math.max(12, Math.min(r.left, window.innerWidth - w));
    var y = r.bottom + 6;
    if (y + h > window.innerHeight - 12) y = Math.max(12, Math.min(r.top - 6 - h, window.innerHeight - h - 12));
    return { x: x, y: y };
  }
  function closePop() { pop = null; popBox.innerHTML = ""; popBox.style.display = "none"; }

  function openMenu(anchor, at) {
    pop = { kind: "menu", at: at, pos: place(anchor) };
    drawPop();
  }
  function openParams(anchor, id, field) {
    pop = { kind: "params", stepId: id, field: field, pos: place(anchor) };
    drawPop();
  }

  function drawPop() {
    if (!pop) return closePop();
    popBox.style.display = "block";
    popBox.style.left = pop.pos.x + "px";
    popBox.style.top = pop.pos.y + "px";
    popBox.innerHTML = pop.kind === "menu" ? menuHtml() : paramsHtml();
  }

  function menuHtml() {
    var h = ["<h3>插入一步</h3>"];
    Object.keys(K).forEach(function (kind) {
      h.push('<button class="kind" data-add="' + kind + '"><b>' + esc(K[kind].label) +
        "</b><span>" + K[kind].tag + "</span></button>");
    });
    return h.join("");
  }

  function paramsHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return "";
    var k = K[s.kind], i = WF.indexOf(s.id), h = ["<h3>第 " + (i + 1) + " 步 · " + esc(k.label) + "</h3>"];
    k.fields.forEach(function (f) { h.push(fieldHtml(s, f, pop.field === f.key)); });
    if (s.fail) h.push(failHtml(s, i, pop.field === "fail"));
    h.push('<div class="foot"><button data-op="del" data-id="' + s.id + '">删掉这一步</button>' +
      '<button class="done" data-close="1">完成</button></div>');
    return h.join("");
  }

  function fieldHtml(s, f, hot) {
    var v = s.p[f.key];
    var h = ['<div class="row' + (hot ? " hot" : "") + '"><div class="lab">' + esc(f.label) + "</div>"];
    if (f.type === "select") {
      h.push('<select data-set="' + f.key + '" data-id="' + s.id + '">' +
        f.options.map(function (o) {
          return '<option' + (o === v ? " selected" : "") + ">" + esc(o) + "</option>";
        }).join("") + "</select>");
    } else if (f.type === "seg") {
      h.push('<span class="seg">' + f.options.map(function (o) {
        return '<button data-set="' + f.key + '" data-id="' + s.id + '" data-val="' + esc(o) +
          '" data-on="' + (o === v) + '">' + esc(o) + "</button>";
      }).join("") + "</span>");
    } else if (f.type === "checks") {
      h.push(f.options.map(function (o) {
        return '<div class="opt" data-check="' + esc(o) + '" data-id="' + s.id + '" data-on="' +
          (v.indexOf(o) >= 0) + '"><i>✓</i>' + esc(o) + "</div>";
      }).join(""));
    }
    return h.join("") + "</div>";
  }

  function failHtml(s, i, hot) {
    var f = s.fail;
    var h = ['<div class="row' + (hot ? " hot" : "") + '"><div class="lab">这一步失败了怎么办</div><span class="seg">'];
    WF.FAIL_MODES.forEach(function (m) {
      h.push('<button data-fail="mode" data-id="' + s.id + '" data-val="' + m[0] +
        '" data-on="' + (f.mode === m[0]) + '">' + m[1] + "</button>");
    });
    h.push("</span></div>");
    if (f.mode === "back") {
      h.push('<div class="row"><div class="lab">回到哪一步</div><select data-fail="backTo" data-id="' + s.id + '">');
      S.steps.slice(0, i).forEach(function (t, j) {
        h.push('<option value="' + t.id + '"' + (t.id === f.backTo ? " selected" : "") + ">第 " +
          (j + 1) + " 步 · " + esc(K[t.kind].label) + "</option>");
      });
      if (i === 0) h.push('<option value="">（前面没有步骤可回）</option>');
      h.push("</select></div>");
      h.push('<div class="row"><div class="lab">最多重来几轮</div><span class="seg">' +
        [1, 2, 3].map(function (n) {
          return '<button data-fail="max" data-id="' + s.id + '" data-val="' + n +
            '" data-on="' + (f.max === n) + '">' + n + " 轮</button>";
        }).join("") + "</span></div>");
    }
    return h.join("");
  }

  // ── 事件 ────────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-tab],[data-ins],[data-edit],[data-op],[data-add],[data-close]," +
      "[data-ws],[data-ws-set],[data-tpl],[data-set],[data-check],[data-fail]");
    if (!t) { if (!popBox.contains(e.target)) closePop(); return; }

    var d = t.dataset;
    if (d.tab) { setMode(d.tab); return; }
    if (d.tpl) { WF.loadTemplate(d.tpl); closePop(); render(); return; }
    if (d.wsSet) { S.workspace = d.wsSet; render(); return; }
    if (d.ws) { S.workspace = S.workspace === "isolated" ? "shared" : "isolated"; render(); return; }
    if (d.close) { closePop(); return; }

    if (d.ins) { openMenu(t, Number(d.ins)); return; }
    if (d.add) {
      var made = WF.insert(d.add, pop ? pop.at : null);
      closePop(); render();
      var el = document.querySelector('[data-edit="' + made.id + '"]');
      if (el) openParams(el, made.id);
      return;
    }
    if (d.op) {
      if (d.op === "del") { WF.remove(d.id); if (pop && pop.stepId === d.id) closePop(); }
      if (d.op === "up") WF.move(d.id, -1);
      if (d.op === "down") WF.move(d.id, 1);
      render(); if (pop) drawPop();
      return;
    }
    if (d.set !== undefined && t.tagName === "BUTTON") { WF.get(d.id).p[d.set] = d.val; render(); drawPop(); return; }
    if (d.check !== undefined) {
      var arr = WF.get(d.id).p.checks, at = arr.indexOf(d.check);
      if (at >= 0) arr.splice(at, 1); else arr.push(d.check);
      render(); drawPop(); return;
    }
    // 下拉框走 change 事件；这里只处理按钮，否则点开原生下拉会被重绘关掉
    if (d.fail && t.tagName === "BUTTON") {
      var f = WF.get(d.id).fail;
      if (d.fail === "mode") {
        f.mode = d.val;
        if (f.mode === "back" && !f.backTo) {           // 默认回到自己前面最近的干活步骤
          var i = WF.indexOf(d.id), pick = null;
          S.steps.slice(0, i).forEach(function (s) { if (s.kind === "run") pick = s.id; });
          f.backTo = pick || (i > 0 ? S.steps[0].id : null);
        }
      }
      if (d.fail === "max") f.max = Number(d.val);
      render(); drawPop(); return;
    }
    if (d.edit) { openParams(t, d.edit, d.field); return; }
  });

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.tagName !== "SELECT") return;
    if (t.dataset.set !== undefined) WF.get(t.dataset.id).p[t.dataset.set] = t.value;
    else if (t.dataset.fail === "backTo") WF.get(t.dataset.id).fail.backTo = t.value;
    render(); drawPop();
  });

  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });

  WF.loadTemplate("frontend");
  setMode((location.hash || "").replace("#", "") || "sentence");
  window.addEventListener("hashchange", function () {
    setMode((location.hash || "").replace("#", "") || "sentence");
  });

  function setMode(next) {
    if (!/^(sentence|list|rules)$/.test(next)) next = "sentence";
    mode = next;
    if (location.hash.replace("#", "") !== mode) location.hash = mode;
    [].forEach.call(document.querySelectorAll("[data-tab]"), function (b) {
      b.setAttribute("aria-selected", String(b.dataset.tab === mode));
    });
    closePop();
    render();
  }
})();
