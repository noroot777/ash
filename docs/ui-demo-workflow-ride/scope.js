/* 作用域三层：系统默认 → 本项目 → 这个任务。
   下层默认「继承」——不存自己的一份，跟着上层变；只有真动了才分出一份（fork），随时能恢复继承。
   这样绝大多数项目/任务什么都不用配，而想改的那一个改起来又不牵连别人。 */
(function (global) {
  "use strict";

  var SCOPES = [
    { key: "sys", name: "系统默认", sub: "所有项目的兜底" },
    { key: "proj", name: "本项目 · harness", sub: "这个仓库里的任务" },
    { key: "task", name: "这个任务 · #Sh2BRa8d", sub: "只影响它自己" },
  ];
  var ORDER = ["sys", "proj", "task"];

  // sys 一定有一份；proj / task 为 null 表示继承上层
  var store = { sys: null, proj: null, task: null };
  var cur = "proj";

  function clone(cfg) { return JSON.parse(JSON.stringify(cfg)); }
  function snap() { return { workspace: WF.state.workspace, steps: WF.state.steps, tpl: WF.state.tpl || null }; }

  function ownerOf(key) {                 // 这一层实际用的是谁的那一份
    for (var i = ORDER.indexOf(key); i >= 0; i -= 1) if (store[ORDER[i]]) return ORDER[i];
    return "sys";
  }
  function inheriting() { return !store[cur]; }
  function scopeName(key) {
    for (var i = 0; i < SCOPES.length; i += 1) if (SCOPES[i].key === key) return SCOPES[i].name;
    return key;
  }

  // 把某一层的配置装进 WF.state（编辑器只认 WF.state 这一份）
  function apply(key) {
    var src = store[ownerOf(key)];
    var live = store[key] || clone(src);   // 继承时给一份临时副本，改动落到 fork 时才留下
    WF.state.workspace = live.workspace;
    WF.state.steps = live.steps;
    WF.state.tpl = live.tpl;
    if (store[key]) store[key] = live;
    return live;
  }

  function init(tplKey) {
    WF.loadTemplate(tplKey);
    WF.state.tpl = tplKey;
    store.sys = snap();
    apply(cur);
  }

  function switchTo(key) { cur = key; apply(key); }

  // 任何改动前调一次：还在继承就先分出自己的一份
  var forkedJustNow = null;
  function touch() {
    forkedJustNow = null;
    if (store[cur]) return false;
    var from = ownerOf(cur);
    store[cur] = snap();                   // snap 拿的正是 apply 时给的那份临时副本
    forkedJustNow = scopeName(from);
    return true;
  }
  function tookOver() { var v = forkedJustNow; forkedJustNow = null; return v; }

  function reset() {                       // 恢复继承：丢掉本层那一份
    if (cur === "sys") return;
    store[cur] = null;
    apply(cur);
  }

  // 下层还有没有人自己改过（改上层时提醒一句：动它不会影响那几层）
  function overridden() {
    return ORDER.slice(ORDER.indexOf(cur) + 1).filter(function (k) { return !!store[k]; }).map(scopeName);
  }

  global.WFSCOPE = {
    SCOPES: SCOPES, init: init, switchTo: switchTo, touch: touch, tookOver: tookOver,
    reset: reset, inheriting: inheriting, overridden: overridden,
    current: function () { return cur; }, ownerName: function () { return scopeName(ownerOf(cur)); },
    save: function () { if (store[cur]) store[cur] = snap(); },
  };
})(window);
