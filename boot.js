// Loaded first and written in old-browser-safe JavaScript. If no screen has appeared after
// 12 seconds (a script failed to load, the browser is too old, or the server is unreachable),
// replace "Loading…" with something the reader can act on.
(function () {
  setTimeout(function () {
    var el = document.getElementById('loading');
    if (el && !el.hidden) {
      el.textContent = 'This is taking longer than expected. Please check your internet connection and refresh the page. If it keeps happening, try updating your browser.';
    }
  }, 12000);
})();
