// 菜单（手机端）
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('menuToggle');
  const sidebar = document.querySelector('.sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => sidebar.classList.toggle('show'));
  }
  document.addEventListener('click', (e) => {
    if (sidebar && sidebar.classList.contains('show')
        && !sidebar.contains(e.target) && !toggle.contains(e.target)) {
      sidebar.classList.remove('show');
    }
  });
});

// Global error handler — show unhandled errors as toast
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection:', e.reason);
  const msg = (e.reason && e.reason.message) ? e.reason.message : '操作失败，请重试';
  toast(msg, 'danger');
  e.preventDefault();
});
window.addEventListener('error', (e) => {
  console.error('Global error:', e.error);
});

// CSRF token from meta tag
function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

function toast(msg, type) {
  const t = document.getElementById('appToast');
  const b = document.getElementById('appToastBody');
  if (!t || !b) return;
  b.textContent = msg;
  t.classList.remove('text-bg-dark', 'text-bg-success', 'text-bg-danger');
  t.classList.add(type === 'success' ? 'text-bg-success' : type === 'danger' ? 'text-bg-danger' : 'text-bg-dark');
  bootstrap.Toast.getOrCreateInstance(t).show();
}

async function postJSON(url, data, opts) {
  const csrf = getCsrfToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: JSON.stringify(data),
    ...opts,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[postJSON]', url, res.status, j);
    throw new Error(j.error || ('请求失败 HTTP ' + res.status));
  }
  return j;
}

async function postForm(url, formData) {
  const csrf = getCsrfToken();
  if (csrf && !formData.has('_csrf')) formData.append('_csrf', csrf);
  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    headers: csrf ? { 'x-csrf-token': csrf } : {},
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || '请求失败');
  return j;
}

function confirmBox(msg, title) {
  return new Promise((resolve) => {
    const dom = document.createElement('div');
    dom.className = 'modal fade';
    dom.tabIndex = -1;
    dom.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h6 class="modal-title">${title || '确认操作'}</h6>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">${msg}</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-light" data-bs-dismiss="modal">取消</button>
            <button type="button" class="btn btn-primary" id="confirmOk">确定</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(dom);
    const modal = new bootstrap.Modal(dom);
    modal.show();
    dom.querySelector('#confirmOk').addEventListener('click', () => {
      modal.hide();
      resolve(true);
    });
    dom.addEventListener('hidden.bs.modal', () => {
      dom.remove();
      resolve(false);
    });
  });
}

// 通用模态框：支持自定义 HTML 内容与确认按钮。返回 { modal, body, okBtn, show, close }
function modalBox(title, html, opts = {}) {
  const dom = document.createElement('div');
  dom.className = 'modal fade';
  dom.tabIndex = -1;
  dom.innerHTML = `
    <div class="modal-dialog ${opts.size === 'lg' ? 'modal-lg' : ''} ${opts.center ? 'modal-dialog-centered' : ''}">
      <div class="modal-content">
        <div class="modal-header">
          <h6 class="modal-title">${title || ''}</h6>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">${html || ''}</div>
        ${opts.footer === false ? '' : `
        <div class="modal-footer">
          <button type="button" class="btn btn-light" data-bs-dismiss="modal">取消</button>
          <button type="button" class="btn btn-primary" id="modalOkBtn">${opts.okText || '确定'}</button>
        </div>`}
      </div>
    </div>`;
  document.body.appendChild(dom);
  const modal = new bootstrap.Modal(dom);
  const body = dom.querySelector('.modal-body');
  const okBtn = dom.querySelector('#modalOkBtn');
  return { modal, body, okBtn, show: () => modal.show(), close: () => modal.hide() };
}
