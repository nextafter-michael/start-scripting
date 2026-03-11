// Write your A/B test code here.
// The DOM is ready when this runs — no wrapper needed.

(function () {
  var overlay = document.createElement('div');
  overlay.id = 'ss-popup-overlay';

  var popup = document.createElement('div');
  popup.id = 'ss-popup';

  var closeBtn = document.createElement('button');
  closeBtn.id = 'ss-popup-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.onclick = function () {
    overlay.remove();
  };

  var heading = document.createElement('h2');
  heading.textContent = 'Hello';

  popup.appendChild(closeBtn);
  popup.appendChild(heading);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) overlay.remove();
  });
})();
