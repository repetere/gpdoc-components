/* Progressive enhancement: commands and links work without JavaScript. */
'use strict';

const copyButton = document.getElementById('copy-quickstart');
const commands = document.getElementById('quickstart-commands');
const copyStatus = document.getElementById('copy-status');

if (copyButton && commands && copyStatus) {
  copyButton.hidden = false;
  copyButton.addEventListener('click', async () => {
    copyButton.disabled = true;
    copyStatus.textContent = '';
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error('Clipboard access is unavailable');
      }
      await navigator.clipboard.writeText(commands.textContent);
      copyStatus.textContent = 'Quickstart commands copied.';
    } catch {
      copyStatus.textContent = 'Copy is unavailable. Select the commands and copy them manually.';
    } finally {
      copyButton.disabled = false;
    }
  });
}
