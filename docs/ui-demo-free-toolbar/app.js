// Demo-only: cycle free-workflow action button states on click.
// idle → busy → active → disabled → idle

const LABELS = {
  review: {
    idle: "派审查",
    busy: "审查中",
    active: "等待修复",
    disabled: "派审查",
  },
  preview: {
    idle: "打开预览",
    busy: "处理中",
    active: "关闭预览",
    disabled: "打开预览",
  },
  merge: {
    idle: "合并&清理",
    busy: "合并中",
    active: "已合并清理",
    disabled: "合并&清理",
  },
};

const SHORT = {
  review: { idle: "派审", busy: "审查", active: "修复", disabled: "派审" },
  preview: { idle: "预览", busy: "处理", active: "关闭", disabled: "预览" },
  merge: { idle: "合并", busy: "合并", active: "已合", disabled: "合并" },
};

const ORDER = ["idle", "busy", "active", "disabled"];

function kindOf(el) {
  if (el.classList.contains("is-review")) return "review";
  if (el.classList.contains("is-preview")) return "preview";
  if (el.classList.contains("is-merge")) return "merge";
  return "review";
}

function currentState(el) {
  if (el.disabled && el.dataset.demoState === "disabled") return "disabled";
  if (el.classList.contains("is-busy")) return "busy";
  if (el.classList.contains("is-active") || el.getAttribute("aria-pressed") === "true") return "active";
  return "idle";
}

function setLabel(el, kind, state) {
  const text = el.querySelector("span, em");
  if (!text) return;
  const useShort = el.classList.contains("mini") || el.classList.contains("ico-only");
  const map = useShort ? SHORT : LABELS;
  const next = map[kind][state];
  // Keep short labels short for crowded footer
  if (el.classList.contains("mini") && state === "idle") {
    text.textContent = SHORT[kind].idle;
  } else if (el.classList.contains("link-btn")) {
    // link-btn has icon as <i> + text node; rebuild carefully
    const icon = el.querySelector("i");
    el.textContent = "";
    if (icon) el.appendChild(icon);
    el.append(next);
  } else {
    text.textContent = next;
  }
}

// B2 page uses .gbtn / .sbtn / .obtn — same state classes as .chip
document.querySelectorAll(".gbtn[data-demo], .sbtn[data-demo], .obtn[data-demo]").forEach((el) => {
  if (el.hasAttribute("data-demo-bound")) return;
  el.setAttribute("data-demo-bound", "1");
});

function applyState(el, state) {
  const kind = kindOf(el);
  el.classList.remove("is-busy", "is-active");
  el.removeAttribute("aria-pressed");
  el.disabled = false;
  el.dataset.demoState = state;

  if (state === "busy") el.classList.add("is-busy");
  if (state === "active") {
    el.classList.add("is-active");
    if (kind === "preview") el.setAttribute("aria-pressed", "true");
  }
  if (state === "disabled") el.disabled = true;

  setLabel(el, kind, state);
}

function nextState(state) {
  const i = ORDER.indexOf(state);
  return ORDER[(i + 1) % ORDER.length];
}

document.querySelectorAll("[data-demo]").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    // When disabled, still allow cycling in demo by force-enabling briefly
    const state = currentState(el);
    applyState(el, nextState(state === "disabled" && el.disabled ? "disabled" : state));
  });
});

// Disabled buttons don't fire click in some cases — use pointerdown capture on parent
document.querySelectorAll(".stage, .states-stage").forEach((stage) => {
  stage.addEventListener(
    "click",
    (e) => {
      const el = e.target.closest("[data-demo]");
      if (!el || !el.disabled) return;
      e.preventDefault();
      applyState(el, nextState("disabled"));
    },
    true,
  );
});
