const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const el = {
  conversationView: $("#conversationView"),
  acceptanceView: $("#acceptanceView"),
  openAcceptance: $("#openAcceptance"),
  primaryLabel: $("#primaryLabel"),
  backConversation: $("#backConversation"),
  taskState: $("#taskState"),
  sideStatus: $("#sideStatus"),
  sideDot: $("#sideDot"),
  preAcceptActions: $("#preAcceptActions"),
  postAcceptActions: $("#postAcceptActions"),
  acceptButton: $("#acceptButton"),
  reviewMergedButton: $("#reviewMergedButton"),
  workspaceTitle: $("#workspaceTitle"),
  workspaceSubtitle: $("#workspaceSubtitle"),
  mergeReceipt: $("#mergeReceipt"),
  reviewRun: $("#reviewRun"),
  reviewRunIcon: $("#reviewRunIcon"),
  reviewRunTitle: $("#reviewRunTitle"),
  reviewRunCopy: $("#reviewRunCopy"),
  reviewRunStatus: $("#reviewRunStatus"),
  reviewProgress: $("#reviewProgress"),
  resultControls: $("#resultControls"),
  reviewResult: $("#reviewResult"),
  resultIcon: $("#resultIcon"),
  resultTitle: $("#resultTitle"),
  resultText: $("#resultText"),
  reviewResultActions: $("#reviewResultActions"),
  createFix: $("#createFix"),
  snapshotCard: $("#snapshotCard"),
  postReviewCard: $("#postReviewCard"),
  postReviewMeta: $("#postReviewMeta"),
  postReviewBadge: $("#postReviewBadge"),
  finalCheck: $("#finalCheck"),
  reviewCount: $("#reviewCount"),
  createdTaskCard: $("#createdTaskCard"),
  fixTaskRow: $("#fixTaskRow"),
  inspectorReviewState: $("#inspectorReviewState"),
  acceptDialog: $("#acceptDialog"),
  postReviewDialog: $("#postReviewDialog"),
  fixDialog: $("#fixDialog"),
  previewButton: $("#previewButton"),
  toast: $("#toast"),
};

let acceptanceOpen = false;
let accepting = false;
let accepted = false;
let reviewStatus = "idle";
let previewOpen = false;
let fixCreated = false;
let acceptTimer;
let toastTimer;

function showToast(message) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => el.toast.classList.remove("is-visible"), 2400);
}

function openDialog(dialog) {
  dialog.classList.remove("is-hidden");
  dialog.querySelector("button")?.focus();
}

function closeDialog(dialog) {
  dialog.classList.add("is-hidden");
}

function setGuide(activeIndex) {
  $$('[data-guide]').forEach((item, index) => {
    item.classList.toggle("is-active", index === activeIndex);
    item.classList.toggle("is-done", index < activeIndex);
  });
}

function taskStateCopy() {
  if (reviewStatus === "reviewing") return ["已验收 · 审查中", "is-reviewing"];
  if (reviewStatus === "failed") return ["已验收 · 审查未过", "is-failed"];
  if (reviewStatus === "passed") return ["已验收 · 审查通过", "is-accepted"];
  if (accepted) return ["已验收", "is-accepted"];
  if (accepting) return ["验收中", "is-reviewing"];
  return ["已完成", ""];
}

function renderReviewRun() {
  const running = reviewStatus === "reviewing";
  const failed = reviewStatus === "failed";
  const passed = reviewStatus === "passed";
  const visible = running || failed || passed;

  el.reviewRun.classList.toggle("is-hidden", !visible);
  el.reviewRun.classList.toggle("is-failed", failed);
  el.reviewRun.classList.toggle("is-passed", passed);
  el.reviewProgress.classList.toggle("is-hidden", !running);
  el.resultControls.classList.toggle("is-hidden", !running);
  el.reviewResult.classList.toggle("is-hidden", running || !visible);
  el.reviewResult.classList.toggle("is-passed", passed);
  el.reviewResultActions.classList.toggle("is-hidden", running || !visible);
  el.createFix.classList.toggle("is-hidden", !failed || fixCreated);

  if (running) {
    el.reviewRunIcon.textContent = "⌕";
    el.reviewRunTitle.textContent = "正在审查合并结果";
    el.reviewRunCopy.textContent = "在临时 detached worktree 中检查 main@8f41c2d。";
    el.reviewRunStatus.textContent = "运行中";
  } else if (failed) {
    el.reviewRunIcon.textContent = "!";
    el.reviewRunTitle.textContent = "合并结果审查发现问题";
    el.reviewRunCopy.textContent = "原任务仍保持已验收；问题进入新的修复任务处理。";
    el.reviewRunStatus.textContent = "未通过";
    el.resultIcon.textContent = "!";
    el.resultTitle.textContent = "发现 1 个合并后问题";
    el.resultText.textContent = "合并后的清理入口仍引用已经删除的任务 worktree。";
  } else if (passed) {
    el.reviewRunIcon.textContent = "✓";
    el.reviewRunTitle.textContent = "合并结果符合预期";
    el.reviewRunCopy.textContent = "构建、测试、逻辑路径和最终页面点检均通过。";
    el.reviewRunStatus.textContent = "已通过";
    el.resultIcon.textContent = "✓";
    el.resultTitle.textContent = "最终集成状态符合预期";
    el.resultText.textContent = "审查结论固定对应 main@8f41c2d，不受后续 main 移动影响。";
  }
}

function renderInspector() {
  const hasReview = reviewStatus !== "idle";
  el.snapshotCard.classList.toggle("is-hidden", !accepted);
  el.postReviewCard.classList.toggle("is-hidden", !hasReview);
  el.createdTaskCard.classList.toggle("is-hidden", !fixCreated);
  el.fixTaskRow.classList.toggle("is-hidden", !fixCreated);
  el.reviewCount.textContent = hasReview ? "2" : "1";
  el.inspectorReviewState.textContent = accepted ? "合并前通过" : "已通过";

  el.postReviewCard.classList.toggle("is-failed", reviewStatus === "failed");
  el.postReviewCard.classList.toggle("is-passed", reviewStatus === "passed");
  if (reviewStatus === "reviewing") {
    el.postReviewMeta.textContent = "main@8f41c2d · 运行中";
    el.postReviewBadge.textContent = "运行中";
    el.finalCheck.innerHTML = "<span>…</span>检查最终集成状态";
  } else if (reviewStatus === "failed") {
    el.postReviewMeta.textContent = "main@8f41c2d · 发现问题";
    el.postReviewBadge.textContent = "未通过";
    el.finalCheck.innerHTML = "<span>!</span>发现 1 个集成问题";
  } else if (reviewStatus === "passed") {
    el.postReviewMeta.textContent = "main@8f41c2d · 审查通过";
    el.postReviewBadge.textContent = "已通过";
    el.finalCheck.innerHTML = "<span>✓</span>最终集成状态通过";
  }
}

function render() {
  const [stateLabel, stateClass] = taskStateCopy();
  const reviewStarted = reviewStatus !== "idle";

  el.conversationView.classList.toggle("is-hidden", acceptanceOpen);
  el.acceptanceView.classList.toggle("is-hidden", !acceptanceOpen);
  el.openAcceptance.classList.toggle("is-hidden", acceptanceOpen);
  el.backConversation.classList.toggle("is-hidden", !acceptanceOpen);
  el.openAcceptance.disabled = accepting;
  el.primaryLabel.textContent = accepted ? "验收结果" : accepting ? "验收中" : "验收";

  el.taskState.className = `task-state${stateClass ? ` ${stateClass}` : ""}`;
  el.taskState.querySelector("b").textContent = stateLabel;
  el.sideStatus.textContent = fixCreated
    ? "修复任务已创建"
    : reviewStatus === "reviewing"
      ? "合并结果审查中"
      : reviewStatus === "failed"
        ? "合并后发现问题"
        : reviewStatus === "passed"
          ? "合并结果已通过"
          : accepted
            ? "已验收合并"
            : accepting
              ? "正在验收合并"
              : "等待验收";
  el.sideDot.className = reviewStatus === "failed" ? "is-red" : fixCreated ? "is-blue" : "";

  el.preAcceptActions.classList.toggle("is-hidden", accepted);
  el.postAcceptActions.classList.toggle("is-hidden", !accepted);
  el.acceptButton.disabled = accepting;
  el.acceptButton.textContent = accepting ? "⟳ 正在验收合并…" : "✓ 验收通过";
  el.mergeReceipt.classList.toggle("is-hidden", !accepted);
  el.reviewMergedButton.disabled = reviewStatus === "reviewing";
  el.reviewMergedButton.querySelector("span").textContent = reviewStatus === "reviewing"
    ? "审查中…"
    : reviewStarted
      ? "再审合并结果"
      : "审查合并结果";
  el.workspaceTitle.textContent = accepted ? "验收结果与改动" : "改动与提交";
  el.workspaceSubtitle.textContent = accepted
    ? "本次合并快照已冻结；可以继续审查目标分支上的最终集成状态"
    : "核对任务分支相对基线的提交与 diff";

  el.previewButton.querySelector("b").textContent = previewOpen ? "关闭预览" : "打开预览";
  el.previewButton.disabled = accepted;

  renderReviewRun();
  renderInspector();

  if (!acceptanceOpen && !accepted) setGuide(0);
  else if (!accepted) setGuide(1);
  else if (reviewStatus === "idle") setGuide(2);
  else setGuide(3);
}

function reset() {
  clearTimeout(acceptTimer);
  acceptanceOpen = false;
  accepting = false;
  accepted = false;
  reviewStatus = "idle";
  previewOpen = false;
  fixCreated = false;
  [el.acceptDialog, el.postReviewDialog, el.fixDialog].forEach(closeDialog);
  render();
}

el.openAcceptance.addEventListener("click", () => {
  acceptanceOpen = true;
  render();
});

el.backConversation.addEventListener("click", () => {
  acceptanceOpen = false;
  render();
});

el.acceptButton.addEventListener("click", () => openDialog(el.acceptDialog));
$("#confirmAccept").addEventListener("click", () => {
  closeDialog(el.acceptDialog);
  accepting = true;
  render();
  acceptTimer = setTimeout(() => {
    accepting = false;
    accepted = true;
    previewOpen = false;
    render();
    showToast("验收通过：已合并到 main，并记录 5a13d70 → 8f41c2d");
  }, 950);
});

el.reviewMergedButton.addEventListener("click", () => openDialog(el.postReviewDialog));
$("#confirmPostReview").addEventListener("click", () => {
  closeDialog(el.postReviewDialog);
  reviewStatus = "reviewing";
  render();
  el.reviewRun.scrollIntoView({ behavior: "smooth", block: "center" });
  showToast("已在 main@8f41c2d 的临时只读 worktree 启动审查");
});

$("#failReview").addEventListener("click", () => {
  reviewStatus = "failed";
  render();
});

$("#passReview").addEventListener("click", () => {
  reviewStatus = "passed";
  render();
});

$("#reviewAgain").addEventListener("click", () => openDialog(el.postReviewDialog));
el.createFix.addEventListener("click", () => openDialog(el.fixDialog));
$("#confirmCreateFix").addEventListener("click", () => {
  closeDialog(el.fixDialog);
  fixCreated = true;
  render();
  showToast("已创建修复任务 FIX-204；原任务继续保持已验收");
});

$("#returnButton").addEventListener("click", () => showToast("打回会把意见送回原任务会话；本 Demo 未继续展开"));
$("#preReview").addEventListener("click", () => showToast("这是合并前的任务分支审查；合并后审查入口在统一验收结果里"));
el.previewButton.addEventListener("click", () => {
  previewOpen = !previewOpen;
  render();
  showToast(previewOpen ? "预览已打开" : "预览已关闭");
});
$("#resetDemo").addEventListener("click", reset);

$$('.reviewer-option').forEach((button) => {
  button.addEventListener("click", () => {
    $$('.reviewer-option').forEach((item) => item.classList.toggle("is-selected", item === button));
  });
});

$$('[data-close]').forEach((button) => {
  button.addEventListener("click", () => closeDialog(button.closest(".dialog-layer")));
});

$$('.dialog-layer').forEach((layer) => {
  layer.addEventListener("click", (event) => {
    if (event.target === layer) closeDialog(layer);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $$('.dialog-layer:not(.is-hidden)').forEach(closeDialog);
});

render();
