// 通用弹窗拖拽 —— 拖动 .modal-header 可移动任意 Bootstrap 弹窗
(function () {
  'use strict';

  var active = null;
  var MIN_VISIBLE_X = 120;
  var MIN_VISIBLE_Y = 56;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    var header = e.target.closest('.modal-header');
    if (!header) return;
    var modalEl = header.closest('.modal');
    var dialog = modalEl && modalEl.querySelector('.modal-dialog');
    if (!dialog) return;
    if (e.target.closest('button, input, select, textarea, a, [data-bs-dismiss], .form-control, .form-select, .btn-close')) return;

    active = {
      dialog: dialog,
      startX: e.clientX,
      startY: e.clientY,
      rect: dialog.getBoundingClientRect(),
    };
    dialog.style.transition = 'none';
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('pointermove', function (e) {
    if (!active) return;
    var r = active.rect;
    var visX = Math.min(MIN_VISIBLE_X, r.width);
    var visY = Math.min(MIN_VISIBLE_Y, r.height);
    var dx = clamp(e.clientX - active.startX, -(r.left - visX), window.innerWidth - r.right + visX);
    var dy = clamp(e.clientY - active.startY, -(r.top - visY), window.innerHeight - (r.top + r.height) + visY);
    active.dialog.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  });

  function endDrag() {
    if (!active) return;
    active.dialog.style.transition = '';
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    active = null;
  }

  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // 每次打开弹窗时复位位置，避免上次拖动残留在屏幕外
  document.addEventListener('shown.bs.modal', function (ev) {
    var dialog = ev.target.querySelector('.modal-dialog');
    if (dialog) dialog.style.transform = '';
  });
})();
