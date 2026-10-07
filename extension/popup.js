document.getElementById('open').addEventListener('click', function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('page.html') });
  window.close();
});
