import { db } from './firebase-config.js';
import {
  collection, getDocs, doc, setDoc, deleteDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { initTheme, generateKey, toast } from './utils.js';
import {
  initMap, toggleLabels, exportMapPNG, getLabelSettings, saveLabelSettings,
  selectTerritory, getSelected, clearSelection, selectAllFiltered, getAllTerritoryIds,
  setLabelSettings, setPreviewData, setupLabelsToggle
} from './map-core.js';
import { requireAuth, logout } from './auth.js';
import { randomColor } from './palette.js';

// ==== СОСТОЯНИЕ ====
let currentKeyId = null;
let workingAlliances = [];
let workingAssignments = {};
let selectedAllianceId = null;
let mode = 'territory-to-alliance';
let hasUnsavedChanges = false;

// ==== ИНИЦИАЛИЗАЦИЯ ====
document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth(['admin'])) return;
  initTheme();
  document.getElementById('btn-logout').addEventListener('click', logout);

  const map = await initMap({ containerId: 'map-container', interactive: true, clickHandler: onTerritoryClick });
  if (!map) { toast('Карта не загружена — проверьте assets/map.svg', 'error'); return; }

  try {
    await loadMapData();
    await renderKeysList();
    renderAlliances();
    renderAllianceSelect();
  } catch (e) {
    console.error(e);
    toast('Ошибка загрузки данных: ' + e.message, 'error');
  }

  initKeyModal();
  initAllianceModal();
  initMapDataControls();
  initLabelControls();
  initToolbar();

  // Предупреждение при закрытии с несохранёнными изменениями
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
});

// ==== ЗАГРУЗКА ДАННЫХ КАРТЫ ====
async function loadMapData() {
  const al = await getDocs(collection(db, 'alliances'));
  workingAlliances = [];
  al.forEach(d => workingAlliances.push({ id: d.id, ...d.data() }));
  workingAlliances.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  const tt = await getDocs(collection(db, 'territories'));
  workingAssignments = {};
  tt.forEach(d => workingAssignments[d.id] = d.data().allianceId);

  applyWorking();
}

function applyWorking() {
  setPreviewData(
    Object.fromEntries(workingAlliances.map(a => [a.id, a])),
    workingAssignments
  );
}

// ==== КЛИК ПО ТЕРРИТОРИИ ====
function onTerritoryClick(id, el) {
  if (id === 'A') return;

  if (mode === 'territory-to-alliance') {
    const isSel = el.classList.contains('selected');
    selectTerritory(id, !isSel);
    updateSlidersFromSelection();
  } else {
    if (!selectedAllianceId) { toast('Сначала выберите союз', 'error'); return; }
    workingAssignments[id] = selectedAllianceId;
    hasUnsavedChanges = true;
    applyWorking();
  }
}

// ==== ПРИМЕНЕНИЕ СОЮЗА К ВЫБРАННЫМ ====
function applyAllianceToSelected(silent = false) {
  if (!selectedAllianceId) {
    if (!silent) toast('Выберите союз из списка', 'error');
    return;
  }
  const sel = getSelected();
  if (!sel.length) {
    if (!silent) toast('Сначала выберите территории на карте', 'error');
    return;
  }
  const alliance = workingAlliances.find(a => a.id === selectedAllianceId);
  if (!alliance) { if (!silent) toast('Союз не найден', 'error'); return; }

  sel.forEach(id => { workingAssignments[id] = selectedAllianceId; });
  clearSelection();
  applyWorking();
  hasUnsavedChanges = true;
  toast(`Назначено: ${sel.length} → ${alliance.tag}`, 'success');
}

// ==== СОХРАНЕНИЕ КАРТЫ (союзы + территории) ====
async function saveMapData() {
  try {
    toast('Сохранение...', 'info');

    const oldTt = await getDocs(collection(db, 'territories'));
    for (const d of oldTt.docs) await deleteDoc(doc(db, 'territories', d.id));
    for (const [tid, aid] of Object.entries(workingAssignments)) {
      await setDoc(doc(db, 'territories', tid), { allianceId: aid });
    }

    const oldAl = await getDocs(collection(db, 'alliances'));
    for (const d of oldAl.docs) await deleteDoc(doc(db, 'alliances', d.id));
    for (let i = 0; i < workingAlliances.length; i++) {
      const a = workingAlliances[i];
      await setDoc(doc(db, 'alliances', a.id), {
        tag: a.tag, name: a.name || '', color: a.color, rank: i + 1
      });
    }

    hasUnsavedChanges = false;
    toast('Карта сохранена', 'success');
  } catch (e) {
    console.error(e);
    toast('Ошибка сохранения: ' + e.message, 'error');
  }
}

// ==== КЛЮЧИ ====
async function renderKeysList() {
  const list = document.getElementById('keys-list');
  const snap = await getDocs(collection(db, 'access_keys'));
  const keys = [];
  snap.forEach(d => keys.push({ id: d.id, ...d.data() }));
  keys.sort((a, b) => (b.createdAt?.toDate?.() || 0) - (a.createdAt?.toDate?.() || 0));

  if (!keys.length) {
    list.innerHTML = '<p class="text-center text-gray-500 py-3 text-xs">Нет ключей</p>';
    return;
  }

  list.innerHTML = keys.map((k, i) => `
    <div class="flex items-center gap-1.5 py-1.5 border-b dark:border-gray-700 text-xs">
      <span class="text-gray-400 w-4 text-center">${i + 1}.</span>
      <div class="flex-1 min-w-0">
        <div class="font-medium truncate flex items-center gap-1">
          ${k.name}
          ${k.isMainManager ? '<span class="text-purple-500" title="Главный">★</span>' : ''}
          ${k.isRevoked ? '<span class="text-red-500 text-[10px]">(отозван)</span>' : ''}
        </div>
        <div class="font-mono text-gray-500 truncate text-[11px]">${k.key}</div>
      </div>
      <button class="copy-key text-blue-500 hover:text-blue-700 px-0.5" data-key="${k.key}" title="Копировать"><i class="fas fa-copy"></i></button>
      <button class="toggle-key text-${k.isRevoked ? 'green' : 'yellow'}-500 hover:opacity-80 px-0.5" data-id="${k.id}" data-revoked="${k.isRevoked}" title="${k.isRevoked ? 'Восстановить' : 'Отозвать'}">
        <i class="fas fa-${k.isRevoked ? 'check-circle' : 'ban'}"></i>
      </button>
      <button class="delete-key text-red-500 hover:text-red-700 px-0.5" data-id="${k.id}" title="Удалить"><i class="fas fa-trash"></i></button>
    </div>
  `).join('');

  list.querySelectorAll('.copy-key').forEach(b => b.addEventListener('click', () => {
    navigator.clipboard.writeText(b.dataset.key);
    toast('Ключ скопирован', 'success');
  }));
  list.querySelectorAll('.toggle-key').forEach(b => b.addEventListener('click', async () => {
    await updateDoc(doc(db, 'access_keys', b.dataset.id), { isRevoked: b.dataset.revoked !== 'true' });
    await renderKeysList();
  }));
  list.querySelectorAll('.delete-key').forEach(b => b.addEventListener('click', async () => {
    if (confirm('Удалить ключ?')) {
      await deleteDoc(doc(db, 'access_keys', b.dataset.id));
      await renderKeysList();
    }
  }));
}

function initKeyModal() {
  const modal = document.getElementById('modal-key');
  const gen = document.getElementById('key-gen');
  const nameInput = document.getElementById('key-name');
  const mainCheck = document.getElementById('key-main');

  document.getElementById('btn-create-key').addEventListener('click', () => {
    currentKeyId = null;
    gen.value = generateKey();
    nameInput.value = '';
    mainCheck.checked = false;
    modal.classList.remove('hidden');
  });
  document.getElementById('btn-regen-key').addEventListener('click', () => { gen.value = generateKey(); });
  document.getElementById('btn-close-key').addEventListener('click', () => modal.classList.add('hidden'));

  document.getElementById('btn-save-key').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return toast('Введите имя', 'error');
    try {
      if (currentKeyId) {
        await updateDoc(doc(db, 'access_keys', currentKeyId), {
          name, isMainManager: mainCheck.checked, key: gen.value
        });
      } else {
        const id = Date.now().toString();
        await setDoc(doc(db, 'access_keys', id), {
          key: gen.value,
          name,
          isMainManager: mainCheck.checked,
          isRevoked: false,
          createdAt: serverTimestamp()
        });
      }
      modal.classList.add('hidden');
      toast('Сохранено', 'success');
      await renderKeysList();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ==== СОЮЗЫ ====
function renderAlliances() {
  const list = document.getElementById('alliances-ranking');
  if (!list) return;
  if (!workingAlliances.length) {
    list.innerHTML = '<p class="text-center text-gray-500 py-2 text-xs">Нет союзов. Нажмите «+».</p>';
    return;
  }
  list.innerHTML = workingAlliances.map((a, i) => `
    <div class="flex items-center gap-1 py-1.5 border-b dark:border-gray-700 text-xs">
      <span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${a.color}"></span>
      <span class="w-5 text-gray-500">${i + 1}.</span>
      <span class="font-mono font-semibold">${a.tag}</span>
      <span class="flex-1 truncate text-gray-500">${a.name || ''}</span>
      <button class="rank-up text-blue-500 px-0.5 disabled:opacity-30" data-id="${a.id}" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
      <button class="rank-down text-blue-500 px-0.5 disabled:opacity-30" data-id="${a.id}" ${i === workingAlliances.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
      <button class="edit-alliance text-yellow-600 px-0.5" data-id="${a.id}"><i class="fas fa-pen"></i></button>
      <button class="del-alliance text-red-500 px-0.5" data-id="${a.id}"><i class="fas fa-trash"></i></button>
    </div>
  `).join('');

  list.querySelectorAll('.rank-up').forEach(b => b.addEventListener('click', () => moveRank(b.dataset.id, -1)));
  list.querySelectorAll('.rank-down').forEach(b => b.addEventListener('click', () => moveRank(b.dataset.id, 1)));
  list.querySelectorAll('.edit-alliance').forEach(b => b.addEventListener('click', () => editAlliance(b.dataset.id)));
  list.querySelectorAll('.del-alliance').forEach(b => b.addEventListener('click', () => deleteAlliance(b.dataset.id)));
}

function renderAllianceSelect() {
  const sel = document.getElementById('alliance-select');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Выберите —</option>' +
    workingAlliances.map(a => `<option value="${a.id}">${a.tag}${a.name ? ' — ' + a.name : ''}</option>`).join('');
  if (workingAlliances.some(a => a.id === cur)) sel.value = cur;
  if (selectedAllianceId && workingAlliances.some(a => a.id === selectedAllianceId)) sel.value = selectedAllianceId;
}

function moveRank(id, dir) {
  const idx = workingAlliances.findIndex(a => a.id === id);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= workingAlliances.length) return;
  [workingAlliances[idx], workingAlliances[newIdx]] = [workingAlliances[newIdx], workingAlliances[idx]];
  workingAlliances.forEach((a, i) => a.rank = i + 1);
  hasUnsavedChanges = true;
  renderAlliances();
  renderAllianceSelect();
}

function initAllianceModal() {
  document.getElementById('btn-add-alliance').addEventListener('click', () => {
    document.getElementById('modal-alliance').classList.remove('hidden');
    document.getElementById('al-tag').value = '';
    document.getElementById('al-name').value = '';
    document.getElementById('al-color').value = randomColor();
  });
  document.getElementById('btn-close-alliance').addEventListener('click', () => document.getElementById('modal-alliance').classList.add('hidden'));
  document.getElementById('btn-save-alliance').addEventListener('click', saveNewAlliance);
}

function saveNewAlliance() {
  const tag = document.getElementById('al-tag').value.trim().toUpperCase();
  const name = document.getElementById('al-name').value.trim();
  const color = document.getElementById('al-color').value;
  if (!/^[A-ZА-ЯЁ0-9]{3}$/.test(tag)) return toast('Тег — ровно 3 символа', 'error');
  if (workingAlliances.some(a => a.tag === tag)) return toast('Тег уже используется', 'error');

  const id = 'al_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  workingAlliances.push({ id, tag, name, color, rank: workingAlliances.length + 1 });
  hasUnsavedChanges = true;
  document.getElementById('modal-alliance').classList.add('hidden');
  renderAlliances();
  renderAllianceSelect();
  toast('Союз добавлен. Не забудьте «Сохранить карту»', 'success');
}

function editAlliance(id) {
  const a = workingAlliances.find(x => x.id === id);
  if (!a) return;
  const tag = prompt('Новый тег (3 символа):', a.tag);
  if (!tag) return;
  const t = tag.trim().toUpperCase();
  if (!/^[A-ZА-ЯЁ0-9]{3}$/.test(t)) return toast('Тег — ровно 3 символа', 'error');
  const name = prompt('Название:', a.name || '');
  a.tag = t;
  a.name = name ?? a.name;
  hasUnsavedChanges = true;
  renderAlliances();
  renderAllianceSelect();
}

function deleteAlliance(id) {
  if (!confirm('Удалить союз? Все его территории освободятся.')) return;
  workingAlliances = workingAlliances.filter(a => a.id !== id);
  workingAlliances.forEach((a, i) => a.rank = i + 1);
  Object.keys(workingAssignments).forEach(k => {
    if (workingAssignments[k] === id) delete workingAssignments[k];
  });
  if (selectedAllianceId === id) selectedAllianceId = null;
  hasUnsavedChanges = true;
  applyWorking();
  renderAlliances();
  renderAllianceSelect();
}

// ==== УПРАВЛЕНИЕ КАРТОЙ ====
function initMapDataControls() {
  document.querySelectorAll('input[name="edit-mode"]').forEach(r => {
    r.addEventListener('change', e => {
      mode = e.target.value;
      clearSelection();
    });
  });

  document.getElementById('alliance-select').addEventListener('change', e => {
    selectedAllianceId = e.target.value || null;
    if (mode === 'territory-to-alliance' && selectedAllianceId) {
      applyAllianceToSelected(true);
    }
  });
  document.getElementById('btn-apply-alliance').addEventListener('click', () => applyAllianceToSelected(false));

  document.getElementById('btn-select-all').addEventListener('click', () => {
    const count = selectAllFiltered();
    toast(`Выбрано: ${count}`, 'success');
    updateSlidersFromSelection();
  });

  document.getElementById('btn-clear-selection').addEventListener('click', () => {
    clearSelection();
    toast('Выбор сброшен', 'success');
  });

  document.getElementById('btn-clear-territories').addEventListener('click', () => {
    if (!confirm('Очистить ВСЕ назначения территорий?')) return;
    workingAssignments = {};
    clearSelection();
    hasUnsavedChanges = true;
    applyWorking();
    toast('Назначения очищены', 'success');
  });

  document.getElementById('btn-save-map').addEventListener('click', saveMapData);
}

// ==== ПОДПИСИ ====
function initLabelControls() {
  const DEFAULT = { dx: 0, dy: 0, rotation: 0, scale: 1 };

  const applyToSelected = (mutator) => {
    const ids = getSelected();
    if (!ids.length) return toast('Сначала выберите территории', 'error');
    const settings = getLabelSettings();
    ids.forEach(id => {
      const cur = settings[id] || { ...DEFAULT };
      settings[id] = mutator({ ...cur });
    });
    setLabelSettings(settings);
  };

  document.getElementById('lbl-dx').addEventListener('input', e => {
    applyToSelected(c => ({ ...c, dx: parseFloat(e.target.value) }));
  });
  document.getElementById('lbl-dy').addEventListener('input', e => {
    applyToSelected(c => ({ ...c, dy: parseFloat(e.target.value) }));
  });
  document.getElementById('lbl-rot').addEventListener('input', e => {
    applyToSelected(c => ({ ...c, rotation: parseFloat(e.target.value) }));
  });
  document.getElementById('lbl-scale').addEventListener('input', e => {
    applyToSelected(c => ({ ...c, scale: parseFloat(e.target.value) }));
  });

  document.getElementById('lbl-global-scale').addEventListener('input', e => {
    const value = parseFloat(e.target.value);
    const ids = getAllTerritoryIds();
    const settings = getLabelSettings();
    ids.forEach(id => {
      const cur = settings[id] || { ...DEFAULT };
      settings[id] = { ...cur, scale: value };
    });
    setLabelSettings(settings);
  });

  document.getElementById('btn-reset-selected').addEventListener('click', async () => {
    const ids = getSelected();
    if (!ids.length) return toast('Выберите территории', 'error');
    const updates = {};
    ids.forEach(id => updates[id] = { ...DEFAULT });
    await saveLabelSettings(updates, true);
    toast('Сброшено у выбранных', 'success');
  });

  document.getElementById('btn-reset-all').addEventListener('click', async () => {
    if (!confirm('Сбросить все настройки подписей?')) return;
    const all = {};
    getAllTerritoryIds().forEach(id => all[id] = { ...DEFAULT });
    await saveLabelSettings(all, true);
    toast('Сброшено у всех', 'success');
  });

  document.getElementById('btn-save-labels').addEventListener('click', async () => {
    await saveLabelSettings(getLabelSettings());
    toast('Настройки подписей сохранены', 'success');
  });
}

function updateSlidersFromSelection() {
  const ids = getSelected();
  if (ids.length === 0) return;
  const s = getLabelSettings();
  const cfg = s[ids[0]] || {};
  document.getElementById('lbl-dx').value = cfg.dx || 0;
  document.getElementById('lbl-dy').value = cfg.dy || 0;
  document.getElementById('lbl-rot').value = cfg.rotation || 0;
  document.getElementById('lbl-scale').value = cfg.scale || 1;
}

// ==== ТУЛБАР ====
function initToolbar() {
  setupLabelsToggle('btn-toggle-labels');
  document.getElementById('btn-download').addEventListener('click', () => document.getElementById('modal-download').classList.remove('hidden'));
  document.getElementById('btn-download-labels').addEventListener('click', () => { document.getElementById('modal-download').classList.add('hidden'); exportMapPNG(true); });
  document.getElementById('btn-download-plain').addEventListener('click', () => { document.getElementById('modal-download').classList.add('hidden'); exportMapPNG(false); });
  document.getElementById('btn-close-download').addEventListener('click', () => document.getElementById('modal-download').classList.add('hidden'));
}