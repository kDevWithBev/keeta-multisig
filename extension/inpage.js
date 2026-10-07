(function () {
  if (window.keetaMultisig) return;

  function request(method, params) {
    const id = crypto.randomUUID();
    return new Promise(function (resolve, reject) {
      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== 'keeta-multisig-content' || data.id !== id) return;
        window.removeEventListener('message', onMessage);
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ source: 'keeta-multisig-page', id: id, method: method, params: params || {} }, '*');
    });
  }

  window.keetaMultisig = {
    connect: function () { return request('connect'); },
    send: function (tx) { return request('send', tx); }
  };
})();
