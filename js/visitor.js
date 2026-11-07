import { db } from './firebase-config.js';
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { initTheme, toast } from './utils.js';
import { initMap, toggleLabels, exportMapPNG } from './map-core.js';
import { loginWithKey, loginAdmin } from './auth.js';

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initAuthModal();
  initMapAndData();
});

async function initMapAndData() {
  await initMap({ containerId: 'map-container', interactive: false });
  await renderAlliancesList();

  document.getElementById('btn-toggle-labels').addEventListener('click', () => {
    const labels = document.getElementById('labels');
    if (labels) toggleLabels(labels.style.display === 'none');
  });

  document.getElementById('btn-download').addEventListener('click', () => {
    document.getElementById('modal-download').classList.remove('hidden');
  });

  document.getElementById('btn-download-labels').addEventListener('click', async () => {
    document.getElementById('modal-download').classList.add('hidden');
    await exportMapPNG(true);
  });
  document.getElementById('btn-download-plain').addEventListener('click', async () => {
    document.getElementById('modal-download').classList.add('hidden');
    await exportMapPNG(false);
  });
  document.getElementById('btn-close-download').addEventListener('click', () => {
    document.getElementById('modal-download').classList.add('hidden');
  });
}

async function renderAlliancesList() {
  const list = document.getElementById('alliances-list');
  const snap = await getDocs(collection(db, 'alliances'));
  const alliances = [];
  snap.forEach(d => alliances.push({ id: d.id, ...d.data() }));
  alliances.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  if (!alliances.length) {
    list.innerHTML = '<p class="text-center text-gray-500 dark:text-gray-400 py-4">Пока нет добавленных союзов</p>';
    return;
  }
  list.innerHTML = alliances.map((a, i) => `
    <div class="flex items-center p-3 bg-white dark:bg-gray-800 rounded shadow">
      <span class="w-4 h-4 rounded-full mr-3 flex-shrink-0" style="background-color: ${a.color}"></span>
      <span class="font-bold w-8">${i + 1}.</span>
      <span class="font-mono font-semibold">${a.tag}</span>
      ${a.name ? `<span class="ml-2 text-gray-500 dark:text-gray-400">${a.name}</span>` : ''}
    </div>
  `).join('');
}

function initAuthModal() {
  const modal = document.getElementById('modal-auth');
  const step1 = document.getElementById('auth-step-1');
  const step2 = document.getElementById('auth-step-2');

  document.getElementById('btn-admin').addEventListener('click', () => modal.classList.remove('hidden'));
  document.getElementById('btn-close-auth').addEventListener('click', () => modal.classList.add('hidden'));
  document.getElementById('btn-admin-auth').addEventListener('click', () => {
    step1.classList.add('hidden'); step2.classList.remove('hidden');
  });
  document.getElementById('btn-back-auth').addEventListener('click', () => {
    step2.classList.add('hidden'); step1.classList.remove('hidden');
  });

  document.getElementById('btn-login-key').addEventListener('click', async () => {
    const key = document.getElementById('access-key').value;
    try {
      await loginWithKey(key);
      toast('Успешно', 'success');
      window.location.href = 'manager.html';
    } catch (e) { toast(e.message, 'error'); }
  });

  document.getElementById('btn-do-admin-login').addEventListener('click', async () => {
    const email = document.getElementById('admin-login').value;
    const pass = document.getElementById('admin-pass').value;
    try {
      await loginAdmin(email, pass);
      toast('Успешно', 'success');
      window.location.href = 'admin.html';
    } catch (e) { toast('Ошибка входа: ' + e.message, 'error'); }
  });
}