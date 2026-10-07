const pending = new Map();

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.source) return;

  if (message.source === 'keeta-multisig-page') {
    const record = {
      id: message.id,
      method: message.method,
      params: message.params || {},
      origin: message.origin || sender.origin || 'unknown'
    };
    chrome.storage.session.set({ ['req:' + message.id]: record }).then(function () {
      return chrome.windows.create({
        url: chrome.runtime.getURL('page.html#request=' + encodeURIComponent(message.id)),
        type: 'popup',
        width: 460,
        height: 780,
        focused: true
      });
    }).then(function (created) {
      pending.set(message.id, { sendResponse: sendResponse, windowId: created && created.id });
    }).catch(function (err) {
      sendResponse({ result: null, error: err && err.message ? err.message : 'The request window did not open.' });
    });
    return true;
  }

  if (message.source === 'keeta-multisig-ui' && message.id && pending.has(message.id)) {
    const held = pending.get(message.id);
    pending.delete(message.id);
    chrome.storage.session.remove('req:' + message.id);
    held.sendResponse({ result: message.result, error: message.error || null });
  }
});

chrome.windows.onRemoved.addListener(function (windowId) {
  for (const [id, held] of pending) {
    if (held.windowId === windowId) {
      pending.delete(id);
      chrome.storage.session.remove('req:' + id);
      chrome.storage.session.get('res:' + id).then(function (existing) {
        if (!existing['res:' + id]) {
          chrome.storage.session.set({
            ['res:' + id]: { result: null, error: 'The request window was closed before approval.' }
          });
        }
      });
      held.sendResponse({ error: 'The request window was closed before approval.' });
    }
  }
});
