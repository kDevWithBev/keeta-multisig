(function () {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inpage.js');
  script.onload = function () { script.remove(); };
  (document.documentElement || document.head).appendChild(script);

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'keeta-multisig-page') return;
    const key = 'res:' + data.id;
    let finished = false;

    function finish(result, error) {
      if (finished) return;
      finished = true;
      chrome.storage.onChanged.removeListener(onChanged);
      window.postMessage({
        source: 'keeta-multisig-content',
        id: data.id,
        result: result == null ? null : result,
        error: error || null
      }, '*');
    }

    function onChanged(changes, area) {
      if (area !== 'session' || !changes[key] || !changes[key].newValue) return;
      const value = changes[key].newValue;
      finish(value.result, value.error || null);
    }

    try {
      chrome.storage.onChanged.addListener(onChanged);
      chrome.storage.session.get(key).then(function (existing) {
        if (existing && existing[key]) finish(existing[key].result, existing[key].error || null);
      }).catch(function () {});
    } catch (ignored) {}

    chrome.runtime.sendMessage({
      source: 'keeta-multisig-page',
      id: data.id,
      method: data.method,
      params: data.params,
      origin: location.origin
    }, function (response) {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        if (/port closed|message channel closed|Receiving end does not exist/i.test(runtimeError.message)) return;
        finish(null, runtimeError.message);
        return;
      }
      if (response) finish(response.result, response.error || null);
    });
  });
})();
