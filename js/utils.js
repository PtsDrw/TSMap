import { db } from './firebase-config.js';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export function generateKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без похожих 0/O, 1/I
  const block = () => Array.from({length: 3}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
  return `${block()}-${block()}`;
}

export function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

export function formatDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('ru-RU');
}

export function nowString() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `fixed bottom-4 right-4 px-4 py-2 rounded shadow-lg text-white z-[100] ${
    type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-green-600' : 'bg-blue-600'
  }`;
  el.textContent = msg;
  
  // ⭐ Тосты тоже должны появляться в fullscreen
  const container = document.fullscreenElement || document.webkitFullscreenElement || document.body;
  container.appendChild(el);
  
  setTimeout(() => el.remove(), 3000);
}

export async function getMeta() {
  const snap = await getDoc(doc(db, 'meta', 'current'));
  return snap.exists() ? snap.data() : { approvedLayoutId: null };
}

export async function setMeta(data) {
  await setDoc(doc(db, 'meta', 'current'), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function initTheme() {
  const btn = document.getElementById('btn-theme');
  const html = document.documentElement;
  const saved = localStorage.getItem('theme');
  const dark = saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) { html.classList.add('dark'); btn.innerHTML = '<i class="fas fa-sun"></i>'; }
  btn.addEventListener('click', () => {
    html.classList.toggle('dark');
    const isDark = html.classList.contains('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    btn.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
  });
}

export const randomId = generateId;

// ⭐ Хелпер для поиска контейнера (чтобы окна работали в полноэкранном режиме)
function getModalContainer() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.body;
}

// ⭐ Кастомный confirm
export function customConfirm(message, title = 'Подтверждение', confirmText = 'ОК', cancelText = 'Отмена') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 opacity-0 transition-opacity duration-200';
    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-sm overflow-hidden transform scale-95 transition-transform duration-200">
        <div class="p-4">
          <h3 class="text-lg font-bold mb-2 text-gray-800 dark:text-gray-100">${title}</h3>
          <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">${message}</p>
          <div class="flex justify-end gap-2">
            <button id="cc-cancel" class="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600">${cancelText}</button>
            <button id="cc-confirm" class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">${confirmText}</button>
          </div>
        </div>
      </div>
    `;
    getModalContainer().appendChild(overlay);
    overlay.offsetHeight; 
    overlay.classList.remove('opacity-0');
    overlay.querySelector('.transform').classList.remove('scale-95');

    const cleanup = (result) => {
      overlay.classList.add('opacity-0');
      overlay.querySelector('.transform').classList.add('scale-95');
      setTimeout(() => { overlay.remove(); resolve(result); }, 200);
    };

    overlay.querySelector('#cc-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('#cc-confirm').addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
  });
}

// ⭐ Кастомный alert
export function customAlert(message, title = 'Уведомление') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 opacity-0 transition-opacity duration-200';
    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-sm overflow-hidden transform scale-95 transition-transform duration-200">
        <div class="p-4">
          <h3 class="text-lg font-bold mb-2 text-gray-800 dark:text-gray-100">${title}</h3>
          <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">${message}</p>
          <div class="flex justify-end">
            <button id="ca-ok" class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">ОК</button>
          </div>
        </div>
      </div>
    `;
    getModalContainer().appendChild(overlay);
    overlay.offsetHeight;
    overlay.classList.remove('opacity-0');
    overlay.querySelector('.transform').classList.remove('scale-95');

    overlay.querySelector('#ca-ok').addEventListener('click', () => {
      overlay.classList.add('opacity-0');
      overlay.querySelector('.transform').classList.add('scale-95');
      setTimeout(() => { overlay.remove(); resolve(); }, 200);
    });
  });
}

// ⭐ Кастомный prompt
export function customPrompt(message, defaultValue = '', title = 'Ввод данных') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 opacity-0 transition-opacity duration-200';
    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-sm overflow-hidden transform scale-95 transition-transform duration-200">
        <div class="p-4">
          <h3 class="text-lg font-bold mb-2 text-gray-800 dark:text-gray-100">${title}</h3>
          <p class="text-sm text-gray-600 dark:text-gray-300 mb-2">${message}</p>
          <input type="text" id="cp-input" value="${defaultValue}" class="w-full border rounded p-2 mb-4 dark:bg-gray-700 dark:border-gray-600 text-gray-800 dark:text-gray-100">
          <div class="flex justify-end gap-2">
            <button id="cp-cancel" class="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600">Отмена</button>
            <button id="cp-confirm" class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">ОК</button>
          </div>
        </div>
      </div>
    `;
    getModalContainer().appendChild(overlay);
    overlay.offsetHeight;
    overlay.classList.remove('opacity-0');
    overlay.querySelector('.transform').classList.remove('scale-95');
    const input = overlay.querySelector('#cp-input');
    input.focus();
    input.select();

    const cleanup = (result) => {
      overlay.classList.add('opacity-0');
      overlay.querySelector('.transform').classList.add('scale-95');
      setTimeout(() => { overlay.remove(); resolve(result); }, 200);
    };

    overlay.querySelector('#cp-cancel').addEventListener('click', () => cleanup(null));
    overlay.querySelector('#cp-confirm').addEventListener('click', () => cleanup(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cleanup(input.value);
      if (e.key === 'Escape') cleanup(null);
    });
  });
}