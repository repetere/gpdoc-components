'use strict';
const text = document.getElementById('review-text');
const status = document.getElementById('announcement');
const accept = document.getElementById('accept');
accept.addEventListener('click', () => {
  text.textContent = 'Tuesday';
  status.textContent = 'Suggestion accepted in this preview. No file was changed.';
  accept.disabled = true;
});
document.getElementById('reset').addEventListener('click', () => {
  text.replaceChildren();
  const old = document.createElement('del'); old.textContent = 'Monday';
  const next = document.createElement('ins'); next.textContent = 'Tuesday';
  text.append(old, ' ', next);
  accept.disabled = false;
  status.textContent = 'One pending suggestion.';
});
