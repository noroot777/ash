/* 直接操作层 —— 三种指针手势共用一套逻辑：
   1) 拖轨道里的关口卡换顺序（其余卡实时让位）
   2) 从左边关口库拖一张卡进轨道，落在哪个缝就插在哪
   3) 从关口右侧的小圆点拉一条线到上游任意一关 = 失败后回那里重做
   全部用 pointer events，触屏和鼠标同一套。 */
(function (global) {
  "use strict";

  var GAP = 10;

  function init(o) {
    var rail = o.rail, lib = o.lib, wire = o.wire, ghost = o.ghost;
    var drag = null;

    function stepEls() { return Array.prototype.slice.call(rail.querySelectorAll(".step")); }

    document.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      var knob = e.target.closest(".knob");
      var libItem = e.target.closest("[data-lib]");
      var card = e.target.closest(".step");
      if (knob) return begin({ type: "wire", from: knob.closest(".step"), e: e });
      if (libItem) return begin({ type: "add", kind: libItem.dataset.lib, e: e });
      if (card && !e.target.closest("button,select,input,.chip")) return begin({ type: "sort", card: card, e: e });
    });

    function begin(d) {
      drag = d;
      drag.x0 = d.e.clientX; drag.y0 = d.e.clientY;
      drag.live = false;
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    }

    function onMove(e) {
      if (!drag) return;
      var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (!drag.live) {
        if (Math.abs(dx) + Math.abs(dy) < 5) return;
        drag.live = true;
        document.body.classList.add("dragging");
        if (drag.type === "sort") startSort();
        if (drag.type === "add") startAdd();
        if (drag.type === "wire") startWire();
      }
      if (drag.type === "sort") moveSort(e, dy);
      if (drag.type === "add") moveAdd(e);
      if (drag.type === "wire") moveWire(e);
      e.preventDefault();
    }

    function onUp(e) {
      document.removeEventListener("pointermove", onMove);
      var d = drag; drag = null;
      document.body.classList.remove("dragging");
      if (!d || !d.live) return;
      if (d.type === "sort") endSort(d);
      if (d.type === "add") endAdd(d, e);
      if (d.type === "wire") endWire(d, e);
    }

    // ── 1. 换顺序 ─────────────────────────────────────────────────────
    function startSort() {
      var cards = stepEls();
      drag.cards = cards;
      drag.rects = cards.map(function (c) { return c.getBoundingClientRect(); });
      drag.from = cards.indexOf(drag.card);
      drag.to = drag.from;
      drag.h = drag.rects[drag.from].height + GAP;
      drag.card.classList.add("lift");
    }
    function moveSort(e, dy) {
      var r = drag.rects[drag.from];
      var mid = r.top + r.height / 2 + dy;
      // 目标位置 = 有几张别的卡的中线在指针上方（拿掉自己之后的插入下标）
      var to = 0;
      drag.rects.forEach(function (rr, i) {
        if (i !== drag.from && rr.top + rr.height / 2 < mid) to++;
      });
      drag.to = to;
      drag.card.style.transform = "translateY(" + dy + "px)";
      drag.cards.forEach(function (c, i) {
        if (i === drag.from) return;
        var shift = 0;
        if (drag.from < i && i <= drag.to) shift = -drag.h;
        else if (drag.to <= i && i < drag.from) shift = drag.h;
        c.style.transform = shift ? "translateY(" + shift + "px)" : "";
        c.classList.toggle("shifted", !!shift);
      });
    }
    function endSort(d) {
      d.cards.forEach(function (c) { c.style.transform = ""; c.classList.remove("shifted", "lift"); });
      if (d.to !== d.from) o.onReorder(d.from, d.to);
      else o.onPick(d.card.dataset.id);
    }

    // ── 2. 从库里拖一张进来 ────────────────────────────────────────────
    function startAdd() {
      var k = WF.KINDS[drag.kind];
      ghost.innerHTML = '<span class="code">' + k.code + "</span>" + WF.esc(k.label);
      ghost.style.setProperty("--hue", k.hue);
      ghost.hidden = false;
    }
    function moveAdd(e) {
      ghost.style.transform = "translate(" + (e.clientX + 12) + "px," + (e.clientY - 14) + "px)";
      var at = gapAt(e.clientY, e.clientX);
      drag.at = at;
      rail.querySelectorAll(".drop").forEach(function (g) {
        g.classList.toggle("hot", at !== null && Number(g.dataset.at) === at);
      });
    }
    function endAdd(d) {
      ghost.hidden = true;
      rail.querySelectorAll(".drop").forEach(function (g) { g.classList.remove("hot"); });
      if (d.at !== null && d.at !== undefined) o.onInsert(d.kind, d.at);
    }
    function gapAt(y, x) {
      var rr = rail.getBoundingClientRect();
      if (x < rr.left - 40 || x > rr.right + 40 || y < rr.top - 30 || y > rr.bottom + 30) return null;
      var cards = stepEls(), at = cards.length;
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i].getBoundingClientRect();
        if (y < c.top + c.height / 2) { at = i; break; }
      }
      return at;
    }

    // ── 3. 拉一条失败回路 ─────────────────────────────────────────────
    function startWire() {
      drag.fromIdx = stepEls().indexOf(drag.from);
      // 显式给尺寸：fixed 的 <svg> 拿不到百分比宽高，路径会被裁成 0×0
      wire.setAttribute("width", window.innerWidth);
      wire.setAttribute("height", window.innerHeight);
      wire.removeAttribute("hidden");   // <svg> 不是 HTMLElement，.hidden 只是个无效的 JS 属性
      rail.classList.add("wiring");
      stepEls().forEach(function (c, i) { c.classList.toggle("cantdrop", i >= drag.fromIdx); });
    }
    function moveWire(e) {
      var k = drag.from.querySelector(".knob").getBoundingClientRect();
      var x1 = k.left + k.width / 2, y1 = k.top + k.height / 2;
      var x2 = e.clientX, y2 = e.clientY;
      var cx = Math.max(x1, x2) + 70;
      wire.innerHTML = '<path d="M' + x1 + " " + y1 + " C" + cx + " " + y1 + "," + cx + " " + y2 + "," + x2 + " " + y2 +
        '" fill="none" stroke="#f0b429" stroke-width="1.6" stroke-dasharray="4 4"/>' +
        '<circle cx="' + x2 + '" cy="' + y2 + '" r="3.5" fill="#f0b429"/>';
      var over = document.elementFromPoint(e.clientX, e.clientY);
      var t = over && over.closest ? over.closest(".step") : null;
      drag.target = t && stepEls().indexOf(t) < drag.fromIdx ? t : null;
      stepEls().forEach(function (c) { c.classList.toggle("wiretarget", c === drag.target); });
    }
    function endWire(d) {
      wire.setAttribute("hidden", "");
      wire.innerHTML = "";
      rail.classList.remove("wiring");
      stepEls().forEach(function (c) { c.classList.remove("wiretarget", "cantdrop"); });
      if (d.target) o.onWire(d.from.dataset.id, d.target.dataset.id);
    }
  }

  global.WFDND = { init: init };
})(window);
