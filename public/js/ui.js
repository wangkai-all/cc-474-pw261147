import { h } from './dom.js';

const stack = () => document.getElementById('toast-stack');

export function toast(kind, title, detail) {
  const el = h(
    'div',
    { class: `toast ${kind}`, role: 'status' },
    h('div', { class: 'tx' }, h('strong', {}, title), detail ? h('p', {}, detail) : null),
  );
  stack().appendChild(el);
  const ttl = kind === 'bad' ? 7000 : 4200;
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 260);
  }, ttl);
}

export const ok = (t, d) => toast('ok', t, d);
export const info = (t, d) => toast('info', t, d);
export const warn = (t, d) => toast('warn', t, d);
export const bad = (t, d) => toast('bad', t, d);

let activeModal = null;

export function openModal({ title, body, footer, wide = false, onClose }) {
  closeModal();
  const root = document.getElementById('modal-root');
  const modal = h(
    'div',
    { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h(
      'div',
      { class: 'modal-head' },
      h('h2', {}, title),
      h('span', { class: 'spacer' }),
      h('button', { class: 'modal-close', 'aria-label': '关闭', onClick: () => closeModal(onClose) }, '×'),
    ),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  const backdrop = h(
    'div',
    {
      class: 'modal-backdrop',
      onClick: (e) => {
        if (e.target === backdrop) closeModal(onClose);
      },
    },
    modal,
  );
  const esc = (e) => {
    if (e.key === 'Escape') closeModal(onClose);
  };
  document.addEventListener('keydown', esc);
  root.appendChild(backdrop);
  activeModal = { backdrop, esc, onClose };
  const focusable = modal.querySelector('input, select, textarea, button.btn-primary');
  focusable?.focus();
  return { modal, close: () => closeModal(onClose) };
}

export function closeModal(onClose) {
  if (!activeModal) return;
  const { backdrop, esc, onClose: cb } = activeModal;
  document.removeEventListener('keydown', esc);
  backdrop.remove();
  activeModal = null;
  (onClose ?? cb)?.();
}
