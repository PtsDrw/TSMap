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
  document.body.appendChild(el);
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