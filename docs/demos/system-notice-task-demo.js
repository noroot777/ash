const annotationButton = document.querySelector('#annotationButton');
const historyButton = document.querySelector('#historyButton');
const olderHistory = document.querySelector('#olderHistory');

annotationButton.addEventListener('click', () => {
  const active = document.body.classList.toggle('annotation-mode');
  annotationButton.textContent = active ? '隐藏系统标注' : '标出系统提示';
});

historyButton.addEventListener('click', () => {
  olderHistory.hidden = !olderHistory.hidden;
  historyButton.textContent = olderHistory.hidden ? '展开' : '收起';
});

document.querySelectorAll('.raw-toggle').forEach((button) => {
  button.dataset.closedLabel = button.textContent;
  button.addEventListener('click', () => {
    const card = button.closest('.system-card');
    const raw = card.querySelector('.raw-prompt');
    raw.open = !raw.open;
    button.textContent = raw.open ? '收起现有原文' : button.dataset.closedLabel || '查看现有原文';
  });
});
