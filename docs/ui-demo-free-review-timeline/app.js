const cards = [...document.querySelectorAll(".review-card")];

function setCardOpen(card, open) {
  card.classList.toggle("is-open", open);
  const button = card.querySelector(".review-toggle");
  const detail = card.querySelector(".review-detail");
  button.setAttribute("aria-expanded", String(open));
  detail.setAttribute("aria-hidden", String(!open));
}

for (const card of cards) {
  const button = card.querySelector(".review-toggle");
  button.addEventListener("click", () => {
    const shouldOpen = !card.classList.contains("is-open");
    for (const other of cards) setCardOpen(other, other === card && shouldOpen);
    if (shouldOpen) {
      window.setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "nearest" }), 120);
    }
  });
}

const duration = document.querySelector(".live-duration");
const startedAt = Date.now();

function updateDuration() {
  if (!duration) return;
  const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  if (elapsedSeconds < 60) {
    duration.textContent = elapsedSeconds < 5 ? "刚刚开始" : `已运行 ${elapsedSeconds} 秒`;
    return;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  duration.textContent = `已运行 ${minutes} 分钟`;
}

updateDuration();
window.setInterval(updateDuration, 1000);
