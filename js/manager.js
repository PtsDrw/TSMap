import { db } from './firebase-config.js';
import {
  collection, getDocs, doc, setDoc, deleteDoc, updateDoc, addDoc,
  serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { initTheme, toast, nowString, formatDate, setMeta, customConfirm } from './utils.js';
import {
  initMap, toggleLabels, exportMapPNG, getLabelSettings, setLabelSettings,
  saveLabelSettings, selectTerritory, getSelected, clearSelection, selectAllFiltered,
  getAllTerritoryIds, getTerritoryTypes, getFilteredTerritories,
  setPreviewData, getTerritoryType, getTerritoryLevel, setupLabelsToggle,
  setupUnassignedIconsToggle,
  computeAllianceStats, canSelectWithAdjacency,
  isLabelsVisible, isUnassignedIconsVisible, toggleLabelsExternal, toggleIconsExternal
} from './map-core.js';
import { requireAuth, logout } from './auth.js';
import { pickUniqueColor } from './palette.js';

const CITY_TYPES = ['D', 'Z', 'G', 'M', 'C', 'V'];

function addStatus(msg, ok = true) {
  const banner = document.getElementById('status-banner');
  const list = document.getElementById('status-list');
  if (!banner || !list) { console.log(`[STATUS ${ok ? 'OK' : 'ERR'}] ${msg}`); return; }
  banner.classList.remove('hidden');
  const li = document.createElement('li');
  li.textContent = msg;
  li.style.color = ok ? '#166534' : '#991b1b';
  list.appendChild(li);
  console.log(`[STATUS ${ok ? 'OK' : 'ERR'}] ${msg}`);
}

let session = null;
let mode = 'territory-to-alliance';
let selectedAllianceId = null;
let workingAlliances = [];
let workingAssignments = {};
let filters = {};
let savedLayoutId = null;
let mapReady = false;
let adjacencyMode = false;
let respectLimits = false;
let limitCities = 6;
let limitBastions = 6;
let limitTradePosts = Infinity;
let editingAllianceId = null;

function initFilters() {
  filters = {};
  for (const [t, cfg] of Object.entries(getTerritoryTypes())) {
    if (cfg.subs) {
      filters[t] = {};
      cfg.levels.forEach(l => filters[t][l] = true);
    } else {
      filters[t] = true;
    }
  }
}

// ⭐ Помощники для лимитов
function parseLimitInput(val) {
  if (val === undefined || val === null) return Infinity;
  const s = String(val).trim();
  if (s === '' || s === '∞' || s.toLowerCase() === 'infinity') return Infinity;
  const num = parseInt(s, 10);
  return isNaN(num) ? Infinity : Math.max(0, num);
}

function countAllianceTerritories(aid) {
  let cities = 0, bastions = 0, trade = 0;
  for (const [tid, a] of Object.entries(workingAssignments)) {
    if (a !== aid) continue;
    const t = getTerritoryType(tid);
    if (t === 'B') bastions++;
    else if (t === 'T') trade++;
    else cities++;
  }
  return { cities, bastions, trade };
}

function syncLimitUI() {
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val === Infinity ? '∞' : val;
  };
  setVal('limit-cities', limitCities);
  setVal('fs-limit-cities', limitCities);
  setVal('limit-bastions', limitBastions);
  setVal('fs-limit-bastions', limitBastions);
  setVal('limit-trade', limitTradePosts);
  setVal('fs-limit-trade', limitTradePosts);

  const setChk = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = val;
  };
  setChk('chk-respect-limits', respectLimits);
  setChk('fs-chk-respect-limits', respectLimits);
}

document.addEventListener('DOMContentLoaded', async () => {
  addStatus('✓ JS-модуль manager.js загружен');

  session = requireAuth(['manager']);
  if (!session) { addStatus('✗ Не авторизован', false); return; }
  addStatus(`✓ Сессия: ${session.name}${session.isMainManager ? ' (Главный)' : ''}`);

  try { initFilters(); addStatus('✓ Фильтры инициализированы'); }
  catch (e) { addStatus('✗ Фильтры: ' + e.message, false); return; }

  try { initUIBindings(); addStatus('✓ Обработчики кнопок привязаны'); }
  catch (e) { addStatus('✗ Ошибка привязки UI: ' + e.message, false); console.error(e); return; }

  try { initTheme(); addStatus('✓ Тема инициализирована'); }
  catch (e) { addStatus('✗ Ошибка темы: ' + e.message, false); }

  document.getElementById('user-name').textContent = session.name || 'Управляющий';
  if (!session.isMainManager) document.getElementById('btn-approve-text').textContent = 'На утверждение';
  else document.getElementById('user-badge').classList.remove('hidden');

  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await customConfirm('Выйти? Несохранённые изменения будут потеряны.')) logout();
  });

  try {
    const res = await initMap({
      containerId: 'map-container',
      interactive: true,
      clickHandler: onTerritoryClick,
      onFullscreenEditToggle: (active) => {
        const panel = document.getElementById('fullscreen-edit-panel');
        if (panel) {
          panel.classList.toggle('hidden', !active);
          if (active) updateFsVisualToggles();
        }
      }
    });
    
    if (!res) {
      addStatus('✗ Карта НЕ загружена', false);
      toast('Карта не загружена', 'error');
      return;
    }
    mapReady = true;
    addStatus('✓ Карта загружена');

    const mapContainer = document.getElementById('map-container');
    if (mapContainer && !document.getElementById('fullscreen-edit-panel')) {
      const panelHtml = `
        <div id="fullscreen-edit-panel" class="hidden absolute top-0 right-0 h-full w-[320px] bg-white/95 dark:bg-gray-800/95 backdrop-blur shadow-2xl z-30 overflow-y-auto flex flex-col border-l border-gray-200 dark:border-gray-700">
          <div class="p-3 border-b dark:border-gray-700 flex justify-between items-center sticky top-0 bg-white/95 dark:bg-gray-800/95 z-10">
            <h3 class="font-bold text-sm"><i class="fas fa-tools mr-1 text-blue-500"></i>Инструменты</h3>
            <button id="btn-close-fullscreen-panel" class="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"><i class="fas fa-times"></i></button>
          </div>
          <div class="p-3 space-y-4 text-sm">
            <div class="grid grid-cols-2 gap-2 pb-2 border-b dark:border-gray-700">
              <button id="fs-btn-labels" class="px-2 py-1 bg-gray-200 dark:bg-gray-700 text-xs rounded text-gray-700 dark:text-gray-200">
                <i class="fas fa-eye mr-1"></i>Подписи
              </button>
              <button id="fs-btn-icons" class="px-2 py-1 bg-gray-200 dark:bg-gray-700 text-xs rounded text-gray-700 dark:text-gray-200">
                <i class="fas fa-layer-group mr-1"></i>Иконки
              </button>
            </div>
            <div>
              <div class="font-semibold mb-1">Режим:</div>
              <div class="space-y-1 text-xs">
                <label class="flex items-center"><input type="radio" name="fs-edit-mode" value="territory-to-alliance" checked class="mr-2">Территории → Союз</label>
                <label class="flex items-center"><input type="radio" name="fs-edit-mode" value="alliance-to-territory" class="mr-2">Союз → Территории</label>
              </div>
            </div>
            <div>
              <label class="block font-semibold mb-1">Активный союз:</label>
              <div class="flex gap-1">
                <select id="fs-alliance-select" class="flex-1 border rounded p-1.5 dark:bg-gray-700 dark:border-gray-600 text-xs"></select>
                <button id="fs-btn-apply-alliance" class="px-2 py-1.5 bg-blue-600 text-white rounded text-xs whitespace-nowrap hover:bg-blue-700"><i class="fas fa-check"></i></button>
              </div>
            </div>
            <label class="flex items-center text-xs cursor-pointer">
              <input type="checkbox" id="fs-chk-adjacency" class="mr-2">
              Только соседние территории
            </label>
            <label class="flex items-center text-xs cursor-pointer">
              <input type="checkbox" id="fs-chk-respect-limits" class="mr-2">
              Учитывать лимиты территорий
            </label>
            <div id="fs-selection-controls" class="grid grid-cols-2 gap-1">
              <button id="fs-btn-select-all" class="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"><i class="fas fa-check-square mr-1"></i>Все</button>
              <button id="fs-btn-clear-selection" class="px-2 py-1 bg-gray-600 text-white rounded text-xs hover:bg-gray-700"><i class="fas fa-square mr-1"></i>Сброс</button>
            </div>
            <div class="space-y-1">
              <button id="fs-btn-clear-selected" class="w-full px-2 py-1 bg-yellow-600 text-white rounded text-xs hover:bg-yellow-700">Очистить выбранное</button>
              <button id="fs-btn-clear-all" class="w-full px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700">Очистить всё</button>
              <button id="fs-btn-clear-filtered" class="w-full px-2 py-1 bg-orange-600 text-white rounded text-xs hover:bg-orange-700">Очистить по фильтрам</button>
            </div>
            <div class="pt-2 border-t dark:border-gray-700">
              <button id="fs-btn-shuffle-colors" class="w-full px-2 py-2 bg-pink-600 text-white rounded text-xs hover:bg-pink-700 font-semibold">
                <i class="fas fa-random mr-1"></i>Перемешать цвета
              </button>
            </div>
            <div class="pt-2 border-t dark:border-gray-700">
              <div class="font-semibold mb-1 text-xs">Лимиты:</div>
              <div class="grid grid-cols-3 gap-1">
                <div>
                  <label class="block text-[10px] text-gray-500">Города</label>
                  <input type="number" id="fs-limit-cities" value="6" min="0" class="w-full border rounded p-1 dark:bg-gray-700 dark:border-gray-600 text-xs">
                </div>
                <div>
                  <label class="block text-[10px] text-gray-500">Бастионы</label>
                  <input type="number" id="fs-limit-bastions" value="6" min="0" class="w-full border rounded p-1 dark:bg-gray-700 dark:border-gray-600 text-xs">
                </div>
                <div>
                  <label class="block text-[10px] text-gray-500">Торг.</label>
                  <input type="text" id="fs-limit-trade" value="∞" class="w-full border rounded p-1 dark:bg-gray-700 dark:border-gray-600 text-xs">
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
      mapContainer.insertAdjacentHTML('beforeend', panelHtml);
      initFullscreenPanelControls();
      syncLimitUI();
    }
  } catch (e) {
    addStatus('✗ Ошибка карты: ' + e.message, false); console.error(e); return;
  }

  try {
    await loadCurrentState();
    addStatus(`✓ Данные загружены: ${workingAlliances.length} союзов, ${Object.keys(workingAssignments).length} назначений`);
    syncLimitUI();
  } catch (e) {
    addStatus('✗ Ошибка данных: ' + e.message, false); console.error(e);
    toast('Ошибка данных: ' + e.message, 'error');
  }

  try { renderAll(); addStatus('✓ Карта отрисована'); }
  catch (e) { addStatus('✗ Ошибка отрисовки: ' + e.message, false); console.error(e); }
});

async function loadCurrentState() {
  const stored = sessionStorage.getItem('ts_working_' + session.keyId);
  if (stored) {
    try {
      const s = JSON.parse(stored);
      workingAlliances = s.alliances || [];
      workingAssignments = s.assignments || {};
      savedLayoutId = s.layoutId || null;
      if (s.limits) {
        limitCities = s.limits.cities ?? 6;
        limitBastions = s.limits.bastions ?? 6;
        limitTradePosts = s.limits.trade ?? Infinity;
        respectLimits = s.limits.respect ?? false;
      }
      applyWorking();
      return;
    } catch {}
  }

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

function saveWorkingToSession() {
  sessionStorage.setItem('ts_working_' + session.keyId, JSON.stringify({
    alliances: workingAlliances, 
    assignments: workingAssignments, 
    layoutId: savedLayoutId,
    limits: {
      cities: limitCities,
      bastions: limitBastions,
      trade: limitTradePosts,
      respect: respectLimits
    }
  }));
}

async function updateLayoutOrCreate(updateData, fallbackFullData) {
  if (savedLayoutId) {
    try {
      await updateDoc(doc(db, 'layouts', savedLayoutId), updateData);
      return savedLayoutId;
    } catch (e) {
      const isNotFound = e.code === 'not-found' || /No document to update/i.test(e.message || '');
      if (!isNotFound) throw e;
      savedLayoutId = null;
    }
  }
  const ref = await addDoc(collection(db, 'layouts'), fallbackFullData);
  savedLayoutId = ref.id;
  return savedLayoutId;
}

function onTerritoryClick(id, el) {
  if (!mapReady) return;
  if (id === 'A') return;
  if (!territoryPassesFilter(id)) { toast('Территория скрыта фильтрами', 'error'); return; }

  if (mode === 'territory-to-alliance') {
    const isSel = el.classList.contains('selected');
    if (!isSel && adjacencyMode) {
      const selected = getSelected();
      if (!canSelectWithAdjacency(id, selected, true)) {
        toast('Можно выбирать только соседние территории', 'error');
        return;
      }
    }
    selectTerritory(id, !isSel);
  } else {
    if (!selectedAllianceId) { toast('Сначала выберите союз', 'error'); return; }
    const isRemoving = workingAssignments[id] === selectedAllianceId;
    
    if (!isRemoving) {
      // ⭐ Проверка лимитов
      if (respectLimits) {
        const counts = countAllianceTerritories(selectedAllianceId);
        const type = getTerritoryType(id);
        if (type === 'B' && counts.bastions >= limitBastions) {
          toast(`Лимит бастионов для этого союза достигнут (${limitBastions})`, 'error'); return;
        }
        if (type === 'T' && counts.trade >= limitTradePosts) {
          toast(`Лимит торговых постов для этого союза достигнут (${limitTradePosts})`, 'error'); return;
        }
        if (CITY_TYPES.includes(type) && counts.cities >= limitCities) {
          toast(`Лимит городов для этого союза достигнут (${limitCities})`, 'error'); return;
        }
      }

      // ⭐ Проверка соседства
      if (adjacencyMode) {
        const allianceTerrs = Object.keys(workingAssignments).filter(k => workingAssignments[k] === selectedAllianceId);
        if (allianceTerrs.length > 0) {
          if (!canSelectWithAdjacency(id, allianceTerrs, true)) {
            toast('Территория должна граничить с уже назначенными территориями этого союза', 'error');
            return;
          }
        }
      }
    }

    if (isRemoving) {
      delete workingAssignments[id];
    } else {
      workingAssignments[id] = selectedAllianceId;
    }
    applyWorking();
    saveWorkingToSession();
    renderAlliancesList();
  }
}

function territoryPassesFilter(id) {
  const type = getTerritoryType(id);
  if (type === 'B' || type === 'T') {
    const level = getTerritoryLevel(id);
    return !!(filters[type] && filters[type][level]);
  }
  return !!filters[type];
}

function applyAllianceToSelected(silent = false) {
  if (!selectedAllianceId) {
    if (!silent) toast('Выберите союз из списка', 'error');
    return;
  }
  const sel = getSelected();
  if (!sel.length) {
    if (!silent) toast('Сначала выберите территории кликом на карте', 'error');
    return;
  }
  const alliance = workingAlliances.find(a => a.id === selectedAllianceId);
  if (!alliance) { if (!silent) toast('Союз не найден', 'error'); return; }

  // Пакетная проверка лимитов
  if (respectLimits) {
    const counts = countAllianceTerritories(selectedAllianceId);
    let addCities = 0, addBastions = 0, addTrade = 0;
    sel.forEach(id => {
      if (workingAssignments[id] === selectedAllianceId) return;
      const type = getTerritoryType(id);
      if (type === 'B') addBastions++;
      else if (type === 'T') addTrade++;
      else addCities++;
    });

    if (counts.bastions + addBastions > limitBastions) {
      if (!silent) toast(`Превышен лимит бастионов (${limitBastions})`, 'error'); return;
    }
    if (counts.trade + addTrade > limitTradePosts) {
      if (!silent) toast(`Превышен лимит торговых постов (${limitTradePosts})`, 'error'); return;
    }
    if (counts.cities + addCities > limitCities) {
      if (!silent) toast(`Превышен лимит городов (${limitCities})`, 'error'); return;
    }
  }

  sel.forEach(id => { workingAssignments[id] = selectedAllianceId; });
  clearSelection();
  applyWorking();
  saveWorkingToSession();
  renderAlliancesList();
  toast(`Назначено: ${sel.length} → ${alliance.tag}`, 'success');
}

function setMode(newMode) {
  mode = newMode;
  document.querySelectorAll('input[name="edit-mode"], input[name="fs-edit-mode"]').forEach(r => {
    r.checked = (r.value === mode);
  });
  clearSelection();
  renderAll();
  updateModeUI();
}

function setSelectedAlliance(id) {
  selectedAllianceId = id;
  const mainSel = document.getElementById('alliance-select');
  const fsSel = document.getElementById('fs-alliance-select');
  if (mainSel) mainSel.value = id || '';
  if (fsSel) fsSel.value = id || '';
}

function setAdjacencyMode(val) {
  adjacencyMode = val;
  const mainChk = document.getElementById('chk-adjacency');
  const fsChk = document.getElementById('fs-chk-adjacency');
  if (mainChk) mainChk.checked = val;
  if (fsChk) fsChk.checked = val;
}

function updateModeUI() {
  const isTerritoryMode = mode === 'territory-to-alliance';
  
  const selControls = document.getElementById('selection-controls');
  const clearSel = document.getElementById('btn-clear-selected');
  if (selControls) selControls.classList.toggle('hidden', !isTerritoryMode);
  if (clearSel) clearSel.classList.toggle('hidden', !isTerritoryMode);

  const fsSelControls = document.getElementById('fs-selection-controls');
  const fsClearSel = document.getElementById('fs-btn-clear-selected');
  if (fsSelControls) fsSelControls.classList.toggle('hidden', !isTerritoryMode);
  if (fsClearSel) fsClearSel.classList.toggle('hidden', !isTerritoryMode);
}

function initUIBindings() {
  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (!el) { console.warn('Не найден элемент:', id); return; }
    el.addEventListener(ev, fn);
  };

  document.querySelectorAll('input[name="edit-mode"]').forEach(r => {
    r.addEventListener('change', e => setMode(e.target.value));
  });

  on('btn-toggle-labels', 'click', () => {
    const l = document.getElementById('labels');
    if (l) toggleLabels(l.style.display === 'none');
  });
  on('btn-download', 'click', () => document.getElementById('modal-download').classList.remove('hidden'));
  document.getElementById('modal-download').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-download]');
    if (!btn) return;
    const [theme, mode] = btn.dataset.download.split('-');
    document.getElementById('modal-download').classList.add('hidden');
    exportMapPNG(mode === 'labels', theme);
  });
  on('btn-close-download', 'click', () => document.getElementById('modal-download').classList.add('hidden'));

  renderFilters();

  on('btn-filters-all', 'click', () => {
    for (const [t, cfg] of Object.entries(getTerritoryTypes())) {
      if (cfg.subs) cfg.levels.forEach(l => filters[t][l] = true);
      else filters[t] = true;
    }
    renderFilters(); highlightFiltered();
  });
  on('btn-filters-none', 'click', () => {
    for (const [t, cfg] of Object.entries(getTerritoryTypes())) {
      if (cfg.subs) cfg.levels.forEach(l => filters[t][l] = false);
      else filters[t] = false;
    }
    renderFilters(); highlightFiltered();
  });

  const adjCb = document.getElementById('chk-adjacency');
  if (adjCb) adjCb.addEventListener('change', e => {
    setAdjacencyMode(e.target.checked);
    toast(adjacencyMode ? 'Режим: только соседние территории' : 'Режим: любые территории', 'info');
  });

  // ⭐ Привязка чекбоксов лимитов
  const chkLimits = document.getElementById('chk-respect-limits');
  if (chkLimits) chkLimits.addEventListener('change', e => { respectLimits = e.target.checked; syncLimitUI(); saveWorkingToSession(); });

  // ⭐ Привязка полей ввода лимитов
  on('limit-cities', 'input', e => { limitCities = parseLimitInput(e.target.value); syncLimitUI(); saveWorkingToSession(); });
  on('limit-bastions', 'input', e => { limitBastions = parseLimitInput(e.target.value); syncLimitUI(); saveWorkingToSession(); });
  on('limit-trade', 'input', e => { limitTradePosts = parseLimitInput(e.target.value); syncLimitUI(); saveWorkingToSession(); });

  on('btn-select-all', 'click', () => {
    const count = selectAllFiltered(id => territoryPassesFilter(id));
    toast(`Выбрано: ${count}`, 'success');
  });
  on('btn-clear-selection', 'click', () => { clearSelection(); toast('Выбор сброшен', 'success'); });

  on('btn-add-alliance', 'click', () => {
    document.getElementById('modal-alliance').classList.remove('hidden');
    document.getElementById('al-tag').value = '';
    document.getElementById('al-name').value = '';
    const usedColors = workingAlliances.map(a => a.color);
    document.getElementById('al-color').value = pickUniqueColor(usedColors);
  });
  on('btn-close-alliance', 'click', () => document.getElementById('modal-alliance').classList.add('hidden'));
  on('btn-save-alliance', 'click', saveNewAlliance);

  on('btn-shuffle-colors', 'click', async () => {
    if (!workingAlliances.length) return toast('Нет союзов', 'error');
    if (!await customConfirm('Перемешать цвета всех союзов?')) return;
    const used = [];
    workingAlliances.forEach(a => {
      a.color = pickUniqueColor(used);
      used.push(a.color);
    });
    saveWorkingToSession();
    renderAll();
    toast('Цвета перемешаны', 'success');
  });

  on('btn-save-edit-alliance', 'click', saveEditAlliance);
  on('btn-close-edit-alliance', 'click', () => {
    document.getElementById('modal-edit-alliance').classList.add('hidden');
    editingAllianceId = null;
  });

  on('alliance-select', 'change', e => {
    setSelectedAlliance(e.target.value || null);
    if (mode === 'territory-to-alliance' && selectedAllianceId) {
      applyAllianceToSelected(true);
    }
  });
  on('btn-apply-alliance', 'click', () => applyAllianceToSelected(false));

  on('btn-clear-selected', 'click', () => {
    const sel = getSelected();
    if (!sel.length) return toast('Ничего не выбрано', 'error');
    sel.forEach(id => delete workingAssignments[id]);
    clearSelection(); applyWorking(); saveWorkingToSession();
    renderAlliancesList();
    toast('Очищено выбранное', 'success');
  });

  on('btn-clear-all', 'click', async () => {
    if (!await customConfirm('Очистить все назначения?')) return;
    workingAssignments = {}; clearSelection(); applyWorking(); saveWorkingToSession();
    renderAlliancesList();
    toast('Очищено всё', 'success');
  });

  on('btn-clear-filtered', 'click', async () => {
    if (!await customConfirm('Очистить территории по фильтрам?')) return;
    const ids = getFilteredTerritories(filters);
    ids.forEach(id => delete workingAssignments[id]);
    applyWorking(); saveWorkingToSession();
    renderAlliancesList();
    toast(`Очищено ${ids.length}`, 'success');
  });

  on('btn-save-layout', 'click', () => {
    document.getElementById('modal-save').classList.remove('hidden');
    document.getElementById('save-name').value = nowString();
    document.getElementById('save-desc').value = '';
  });
  on('btn-close-save', 'click', () => document.getElementById('modal-save').classList.add('hidden'));
  on('btn-do-save', 'click', doSaveLayout);

  on('btn-cancel', 'click', async () => {
    if (await customConfirm('Несохранённые изменения будут потеряны. Выйти?')) {
      sessionStorage.removeItem('ts_working_' + session.keyId);
      window.location.href = 'index.html';
    }
  });

  on('btn-approve', 'click', async () => {
    if (session.isMainManager) {
      if (await customConfirm('Утвердить? Станет видимым для всех.')) doApprove();
    } else {
      document.getElementById('modal-submit').classList.remove('hidden');
      document.getElementById('submit-name').value = nowString();
      document.getElementById('submit-desc').value = '';
    }
  });
  on('btn-close-submit', 'click', () => document.getElementById('modal-submit').classList.add('hidden'));
  on('btn-do-submit', 'click', doSubmitForApproval);

  on('btn-load-layouts', 'click', showLayoutsModal);
  on('btn-close-layouts', 'click', () => document.getElementById('modal-layouts').classList.add('hidden'));

  updateModeUI();
  try { setupUnassignedIconsToggle('btn-toggle-icons'); } catch (e) { console.warn('setupUnassignedIconsToggle:', e); }
}

function updateFsVisualToggles() {
  const fsBtnLabels = document.getElementById('fs-btn-labels');
  const fsBtnIcons = document.getElementById('fs-btn-icons');
  if (fsBtnLabels) {
    const isVis = isLabelsVisible();
    fsBtnLabels.className = isVis ? 'px-2 py-1 bg-green-600 text-white text-xs rounded' : 'px-2 py-1 bg-gray-200 dark:bg-gray-700 text-xs rounded text-gray-700 dark:text-gray-200';
  }
  if (fsBtnIcons) {
    const isVis = isUnassignedIconsVisible();
    fsBtnIcons.className = isVis ? 'px-2 py-1 bg-indigo-600 text-white text-xs rounded' : 'px-2 py-1 bg-gray-200 dark:bg-gray-700 text-xs rounded text-gray-700 dark:text-gray-200';
  }
}
window.updateFsVisualToggles = updateFsVisualToggles;

function initFullscreenPanelControls() {
  const panel = document.getElementById('fullscreen-edit-panel');
  if (!panel) return;

  const closeBtn = document.getElementById('btn-close-fullscreen-panel');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      const toolsBtn = document.querySelector('.map-controls [data-action="toggleFullscreenEdit"]');
      if (toolsBtn) toolsBtn.click();
    });
  }

  panel.querySelectorAll('input[name="fs-edit-mode"]').forEach(r => {
    r.addEventListener('change', e => setMode(e.target.value));
  });

  const fsAdj = document.getElementById('fs-chk-adjacency');
  if (fsAdj) fsAdj.addEventListener('change', e => {
    setAdjacencyMode(e.target.checked);
    toast(adjacencyMode ? 'Режим: только соседние территории' : 'Режим: любые территории', 'info');
  });

  // Привязка лимитов в fullscreen
  const fsChkLimits = document.getElementById('fs-chk-respect-limits');
  if (fsChkLimits) fsChkLimits.addEventListener('change', e => { respectLimits = e.target.checked; syncLimitUI(); saveWorkingToSession(); });
  
  const fsLimC = document.getElementById('fs-limit-cities');
  if (fsLimC) fsLimC.addEventListener('input', e => { limitCities = parseLimitInput(e.target.value); syncLimitUI(); saveWorkingToSession(); });
  const fsLimB = document.getElementById('fs-limit-bastions');
  if (fsLimB) fsLimB.addEventListener('input', e => { limitBastions = parseLimitInput(e.target.value); syncLimitUI(); saveWorkingToSession(); });
  const fsLimT = document.getElementById('fs-limit-trade');
  if (fsLimT) fsLimT.addEventListener('input', e => { limitTradePosts = parseLimitInput(e.target.value); syncLimitUI(); saveWorkingToSession(); });

  const fsSel = document.getElementById('fs-alliance-select');
  if (fsSel) {
    fsSel.addEventListener('change', e => {
      setSelectedAlliance(e.target.value || null);
      if (mode === 'territory-to-alliance' && selectedAllianceId) applyAllianceToSelected(true);
    });
  }

  const fsApply = document.getElementById('fs-btn-apply-alliance');
  if (fsApply) fsApply.addEventListener('click', () => applyAllianceToSelected(false));

  const fsSelectAll = document.getElementById('fs-btn-select-all');
  if (fsSelectAll) fsSelectAll.addEventListener('click', () => {
    const count = selectAllFiltered(id => territoryPassesFilter(id));
    toast(`Выбрано: ${count}`, 'success');
  });

  const fsClearSel = document.getElementById('fs-btn-clear-selection');
  if (fsClearSel) fsClearSel.addEventListener('click', () => { clearSelection(); toast('Выбор сброшен', 'success'); });

  const fsClearSelected = document.getElementById('fs-btn-clear-selected');
  if (fsClearSelected) fsClearSelected.addEventListener('click', () => {
    const sel = getSelected();
    if (!sel.length) return toast('Ничего не выбрано', 'error');
    sel.forEach(id => delete workingAssignments[id]);
    clearSelection(); applyWorking(); saveWorkingToSession(); renderAlliancesList();
    toast('Очищено выбранное', 'success');
  });

  const fsClearAll = document.getElementById('fs-btn-clear-all');
  if (fsClearAll) fsClearAll.addEventListener('click', async () => {
    if (!await customConfirm('Очистить все назначения?')) return;
    workingAssignments = {}; clearSelection(); applyWorking(); saveWorkingToSession(); renderAlliancesList();
    toast('Очищено всё', 'success');
  });

  const fsClearFiltered = document.getElementById('fs-btn-clear-filtered');
  if (fsClearFiltered) fsClearFiltered.addEventListener('click', async () => {
    if (!await customConfirm('Очистить территории по фильтрам?')) return;
    const ids = getFilteredTerritories(filters);
    ids.forEach(id => delete workingAssignments[id]);
    applyWorking(); saveWorkingToSession(); renderAlliancesList();
    toast(`Очищено ${ids.length}`, 'success');
  });

  const fsShuffle = document.getElementById('fs-btn-shuffle-colors');
  if (fsShuffle) {
    fsShuffle.addEventListener('click', async () => {
      if (!workingAlliances.length) return toast('Нет союзов', 'error');
      if (!await customConfirm('Перемешать цвета всех союзов?')) return;
      const used = [];
      workingAlliances.forEach(a => {
        a.color = pickUniqueColor(used);
        used.push(a.color);
      });
      saveWorkingToSession();
      renderAll();
      toast('Цвета перемешаны', 'success');
    });
  }

  const fsBtnLabels = document.getElementById('fs-btn-labels');
  const fsBtnIcons = document.getElementById('fs-btn-icons');
  updateFsVisualToggles();

  if (fsBtnLabels) {
    fsBtnLabels.addEventListener('click', () => {
      toggleLabelsExternal();
      updateFsVisualToggles();
    });
  }

  if (fsBtnIcons) {
    fsBtnIcons.addEventListener('click', () => {
      toggleIconsExternal();
      updateFsVisualToggles();
    });
  }

  updateModeUI();
  renderAllianceSelect();
}

function renderFilters() {
  const container = document.getElementById('filters-container');
  if (!container) return;
  const types = getTerritoryTypes();
  let html = '';
  for (const [t, cfg] of Object.entries(types)) {
    if (cfg.subs) {
      const sub = filters[t] || {};
      html += `
        <div class="mb-2">
          <label class="flex items-center font-semibold mb-1">
            <input type="checkbox" class="filter-group mr-2" data-type="${t}" ${Object.values(sub).some(v => v) ? 'checked' : ''}>
            ${cfg.label}
          </label>
          <div class="ml-5 space-y-0.5">
            ${cfg.levels.map(l => `
              <label class="flex items-center">
                <input type="checkbox" class="filter-level mr-2" data-type="${t}" data-level="${l}" ${sub[l] ? 'checked' : ''}>
                ${cfg.label} ${l} ур.
              </label>
            `).join('')}
          </div>
        </div>`;
    } else {
      html += `<label class="flex items-center mb-1"><input type="checkbox" class="filter-flat mr-2" data-type="${t}" ${filters[t] ? 'checked' : ''}>${cfg.label}</label>`;
    }
  }
  container.innerHTML = html;

  container.querySelectorAll('.filter-flat').forEach(cb => {
    cb.addEventListener('change', () => { filters[cb.dataset.type] = cb.checked; highlightFiltered(); });
  });
  container.querySelectorAll('.filter-group').forEach(cb => {
    cb.addEventListener('change', () => {
      const t = cb.dataset.type;
      if (!filters[t]) filters[t] = {};
      getTerritoryTypes()[t].levels.forEach(l => filters[t][l] = cb.checked);
      renderFilters(); highlightFiltered();
    });
  });
  container.querySelectorAll('.filter-level').forEach(cb => {
    cb.addEventListener('change', () => {
      const t = cb.dataset.type;
      if (!filters[t]) filters[t] = {};
      filters[t][cb.dataset.level] = cb.checked;
      highlightFiltered();
    });
  });
}

function highlightFiltered() {
  document.querySelectorAll('.territory').forEach(t => {
    if (t.id === 'A') return;
    t.style.opacity = territoryPassesFilter(t.id) ? '' : '0.25';
  });
}

function renderAll() {
  applyWorking();
  renderAlliancesList();
  renderAllianceSelect();
  highlightFiltered();
}

function renderAlliancesList() {
  const list = document.getElementById('alliances-ranking');
  if (!list) return;
  if (!workingAlliances.length) {
    list.innerHTML = '<p class="text-center text-gray-500 py-2 text-sm">Нет союзов. Нажмите «Добавить союз».</p>';
    return;
  }

  const stats = computeAllianceStats(workingAssignments);

  list.innerHTML = workingAlliances.map((a, i) => {
    const s = stats[a.id] || { bastions: 0, general: 0, trade: 0, total: 0 };
    return `
      <div class="flex items-center gap-1 p-2 bg-white dark:bg-gray-800 rounded shadow-sm border dark:border-gray-700">
        <span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${a.color}"></span>
        <span class="font-bold w-6 text-sm">${i + 1}</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline gap-1">
            <span class="font-mono font-semibold text-sm">${a.tag}</span>
            <span class="text-xs text-gray-500 truncate">${a.name || ''}</span>
          </div>
          <div class="text-[10px] text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-2 gap-y-0.5">
            <span><b class="text-gray-700 dark:text-gray-200">${s.total}</b> всего</span>
            <span>Б:<b class="text-gray-700 dark:text-gray-200">${s.bastions}</b></span>
            <span>Г:<b class="text-gray-700 dark:text-gray-200">${s.general}</b></span>
            <span>Т:<b class="text-gray-700 dark:text-gray-200">${s.trade}</b></span>
          </div>
        </div>
        <button class="rank-up text-blue-500 px-1 disabled:opacity-30" data-id="${a.id}" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
        <button class="rank-down text-blue-500 px-1 disabled:opacity-30" data-id="${a.id}" ${i === workingAlliances.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
        <button class="edit-alliance text-yellow-600 px-1" data-id="${a.id}"><i class="fas fa-pen"></i></button>
        <button class="del-alliance text-red-500 px-1" data-id="${a.id}"><i class="fas fa-trash"></i></button>
      </div>`;
  }).join('');

  list.querySelectorAll('.rank-up').forEach(b => b.addEventListener('click', () => moveRank(b.dataset.id, -1)));
  list.querySelectorAll('.rank-down').forEach(b => b.addEventListener('click', () => moveRank(b.dataset.id, 1)));
  list.querySelectorAll('.edit-alliance').forEach(b => b.addEventListener('click', () => editAlliance(b.dataset.id)));
  list.querySelectorAll('.del-alliance').forEach(b => b.addEventListener('click', () => deleteAlliance(b.dataset.id)));
}

function renderAllianceSelect() {
  const options = '<option value="">— Выберите —</option>' +
    workingAlliances.map(a => `<option value="${a.id}">${a.tag}${a.name ? ' — ' + a.name : ''}</option>`).join('');

  const mainSel = document.getElementById('alliance-select');
  if (mainSel) {
    const cur = mainSel.value;
    mainSel.innerHTML = options;
    if (workingAlliances.some(a => a.id === cur)) mainSel.value = cur;
    if (selectedAllianceId && workingAlliances.some(a => a.id === selectedAllianceId)) mainSel.value = selectedAllianceId;
  }

  const fsSel = document.getElementById('fs-alliance-select');
  if (fsSel) {
    const cur = fsSel.value;
    fsSel.innerHTML = options;
    if (workingAlliances.some(a => a.id === cur)) fsSel.value = cur;
    if (selectedAllianceId && workingAlliances.some(a => a.id === selectedAllianceId)) fsSel.value = selectedAllianceId;
  }
}

function moveRank(id, dir) {
  const idx = workingAlliances.findIndex(a => a.id === id);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= workingAlliances.length) return;
  [workingAlliances[idx], workingAlliances[newIdx]] = [workingAlliances[newIdx], workingAlliances[idx]];
  workingAlliances.forEach((a, i) => a.rank = i + 1);
  saveWorkingToSession(); renderAlliancesList(); renderAllianceSelect();
}

async function saveNewAlliance() {
  const tag = document.getElementById('al-tag').value.trim().toUpperCase();
  const name = document.getElementById('al-name').value.trim();
  let color = document.getElementById('al-color').value;
  if (!/^[A-ZА-ЯЁ0-9]{3}$/.test(tag)) return toast('Тег — ровно 3 символа', 'error');
  if (workingAlliances.some(a => a.tag === tag)) return toast('Тег уже используется', 'error');

  const usedColors = workingAlliances.map(a => a.color);
  if (!color || color === '#000000') color = pickUniqueColor(usedColors);

  const id = 'al_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  workingAlliances.push({ id, tag, name, color, rank: workingAlliances.length + 1 });
  saveWorkingToSession();
  document.getElementById('modal-alliance').classList.add('hidden');
  renderAll();
  toast('Союз добавлен', 'success');
}

function editAlliance(id) {
  const a = workingAlliances.find(x => x.id === id);
  if (!a) return;
  editingAllianceId = id;
  document.getElementById('edit-al-tag').value = a.tag || '';
  document.getElementById('edit-al-name').value = a.name || '';
  document.getElementById('edit-al-color').value = a.color || '#3b82f6';
  document.getElementById('modal-edit-alliance').classList.remove('hidden');
}

function saveEditAlliance() {
  const a = workingAlliances.find(x => x.id === editingAllianceId);
  if (!a) return;

  const tag = document.getElementById('edit-al-tag').value.trim().toUpperCase();
  const name = document.getElementById('edit-al-name').value.trim();
  const color = document.getElementById('edit-al-color').value;

  if (!/^[A-ZА-ЯЁ0-9]{3}$/.test(tag)) return toast('Тег — ровно 3 символа', 'error');
  if (workingAlliances.some(x => x.id !== editingAllianceId && x.tag === tag)) {
    return toast('Тег уже используется', 'error');
  }

  a.tag = tag;
  a.name = name;
  a.color = color;
  saveWorkingToSession();
  document.getElementById('modal-edit-alliance').classList.add('hidden');
  renderAll();
  toast('Союз обновлён', 'success');
  editingAllianceId = null;
}

async function deleteAlliance(id) {
  if (!await customConfirm('Удалить союз?')) return;
  workingAlliances = workingAlliances.filter(a => a.id !== id);
  workingAlliances.forEach((a, i) => a.rank = i + 1);
  Object.keys(workingAssignments).forEach(k => { if (workingAssignments[k] === id) delete workingAssignments[k]; });
  if (selectedAllianceId === id) selectedAllianceId = null;
  saveWorkingToSession(); renderAll();
}

async function doSaveLayout() {
  const name = document.getElementById('save-name').value.trim() || nowString();
  const description = document.getElementById('save-desc').value.trim();
  const data = {
    name, description,
    authorId: session.keyId, authorName: session.name,
    date: serverTimestamp(),
    status: 'draft',
    data: { alliances: workingAlliances, assignments: workingAssignments }
  };
  try {
    await updateLayoutOrCreate(data, data);
    saveWorkingToSession();
    document.getElementById('modal-save').classList.add('hidden');
    toast('Сохранено', 'success');
  } catch (e) { console.error(e); toast('Ошибка сохранения: ' + e.message, 'error'); }
}

async function doSubmitForApproval() {
  const name = document.getElementById('submit-name').value.trim() || nowString();
  const description = document.getElementById('submit-desc').value.trim();
  const data = {
    name, description,
    authorId: session.keyId, authorName: session.name,
    date: serverTimestamp(),
    status: 'pending',
    data: { alliances: workingAlliances, assignments: workingAssignments }
  };
  try {
    await updateLayoutOrCreate(data, data);
    saveWorkingToSession();
    document.getElementById('modal-submit').classList.add('hidden');
    toast('Отправлено', 'success');
  } catch (e) { console.error(e); toast('Ошибка: ' + e.message, 'error'); }
}

async function doApprove() {
  try {
    const oldTt = await getDocs(collection(db, 'territories'));
    for (const d of oldTt.docs) await deleteDoc(doc(db, 'territories', d.id));
    for (const [tid, aid] of Object.entries(workingAssignments)) await setDoc(doc(db, 'territories', tid), { allianceId: aid });

    const oldAl = await getDocs(collection(db, 'alliances'));
    for (const d of oldAl.docs) await deleteDoc(doc(db, 'alliances', d.id));
    for (let i = 0; i < workingAlliances.length; i++) {
      const a = workingAlliances[i];
      await setDoc(doc(db, 'alliances', a.id), { tag: a.tag, name: a.name || '', color: a.color, rank: i + 1 });
    }
    await updateLayoutOrCreate(
      { status: 'approved', approvedAt: serverTimestamp() },
      {
        name: nowString(), description: '',
        authorId: session.keyId, authorName: session.name,
        date: serverTimestamp(),
        status: 'approved',
        data: { alliances: workingAlliances, assignments: workingAssignments }
      }
    );
    await setMeta({ approvedLayoutId: savedLayoutId });
    sessionStorage.removeItem('ts_working_' + session.keyId);
    toast('Утверждено!', 'success');
    setTimeout(() => window.location.href = 'index.html', 1000);
  } catch (e) { toast('Ошибка утверждения: ' + e.message, 'error'); }
}

async function showLayoutsModal() {
  const modal = document.getElementById('modal-layouts');
  const list = document.getElementById('layouts-list');
  list.innerHTML = '<p class="text-center py-4 text-gray-500">Загрузка...</p>';
  modal.classList.remove('hidden');
  try {
    const snap = await getDocs(collection(db, 'layouts'));
    const all = []; snap.forEach(d => all.push({ id: d.id, ...d.data() }));
    const layouts = all.filter(l => l.authorId === session.keyId || (session.isMainManager && l.status === 'pending'));
    layouts.sort((a, b) => (b.date?.toDate?.() || 0) - (a.date?.toDate?.() || 0));
    if (!layouts.length) { list.innerHTML = '<p class="text-center py-4 text-gray-500">Нет сохранённых раскладок</p>'; return; }

    const stLabels = { draft: { t: 'Черновик', c: 'bg-gray-500' }, pending: { t: 'На рассмотрении', c: 'bg-yellow-500' }, rejected: { t: 'Отклонено', c: 'bg-red-600' }, approved: { t: 'Утверждено', c: 'bg-green-600' } };
    list.innerHTML = layouts.map(l => {
      const st = stLabels[l.status] || stLabels.draft;
      const isOwn = l.authorId === session.keyId;
      const canApprove = session.isMainManager && l.status === 'pending' && !isOwn;
      return `
        <div class="border dark:border-gray-700 rounded p-3 mb-2 bg-white dark:bg-gray-800">
          <div class="flex justify-between items-start mb-1">
            <div><span class="font-semibold">${l.name}</span><span class="text-xs ${st.c} text-white px-1.5 py-0.5 rounded ml-2">${st.t}</span></div>
            ${isOwn ? `<button class="del-layout text-red-500" data-id="${l.id}"><i class="fas fa-trash"></i></button>` : ''}
          </div>
          <div class="text-xs text-gray-500 mb-2">${l.authorName} · ${formatDate(l.date)}</div>
          ${l.description ? `<p class="text-sm mb-2">${l.description}</p>` : ''}
          <div class="flex flex-wrap gap-2">
            <button class="load-layout bg-blue-600 text-white text-sm px-3 py-1 rounded" data-id="${l.id}" data-merge="1">Загрузить (сохранить)</button>
            <button class="load-layout bg-orange-600 text-white text-sm px-3 py-1 rounded" data-id="${l.id}" data-merge="0">Загрузить (заменить)</button>
            ${canApprove ? `<button class="approve-layout bg-green-600 text-white text-sm px-3 py-1 rounded" data-id="${l.id}">Утвердить</button><button class="reject-layout bg-red-600 text-white text-sm px-3 py-1 rounded" data-id="${l.id}">Отклонить</button>` : ''}
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.load-layout').forEach(b => b.addEventListener('click', () => loadLayout(b.dataset.id, b.dataset.merge === '1')));
    list.querySelectorAll('.del-layout').forEach(b => b.addEventListener('click', () => delLayout(b.dataset.id)));
    list.querySelectorAll('.approve-layout').forEach(b => b.addEventListener('click', () => approveLayout(b.dataset.id)));
    list.querySelectorAll('.reject-layout').forEach(b => b.addEventListener('click', () => rejectLayout(b.dataset.id)));
  } catch (e) { list.innerHTML = `<p class="text-red-500">Ошибка: ${e.message}</p>`; }
}

async function loadLayout(id, merge) {
  try {
    const snap = await getDoc(doc(db, 'layouts', id));
    if (!snap.exists()) return toast('Не найдено', 'error');
    const l = snap.data();
    if (merge) { workingAlliances = l.data.alliances; workingAssignments = { ...workingAssignments, ...l.data.assignments }; }
    else { workingAlliances = l.data.alliances; workingAssignments = { ...l.data.assignments }; }
    savedLayoutId = id; saveWorkingToSession(); renderAll();
    document.getElementById('modal-layouts').classList.add('hidden');
    toast('Загружено', 'success');
  } catch (e) { toast('Ошибка загрузки: ' + e.message, 'error'); }
}

async function delLayout(id) {
  if (!await customConfirm('Удалить?')) return;
  try {
    await deleteDoc(doc(db, 'layouts', id));
    if (savedLayoutId === id) { savedLayoutId = null; saveWorkingToSession(); }
    await showLayoutsModal();
  } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
}

async function approveLayout(id) {
  try {
    const snap = await getDoc(doc(db, 'layouts', id));
    if (!snap.exists()) return;
    const l = snap.data();
    if (!await customConfirm(`Утвердить «${l.name}» от ${l.authorName}?`)) return;
    workingAlliances = l.data.alliances;
    workingAssignments = l.data.assignments;
    savedLayoutId = id;
    await doApprove();
  } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
}

async function rejectLayout(id) {
  if (!await customConfirm('Отклонить?')) return;
  try { 
    await updateDoc(doc(db, 'layouts', id), { status: 'rejected' }); 
    await showLayoutsModal(); 
    toast('Отклонено', 'success'); 
  } catch (e) { 
    toast('Ошибка: ' + e.message, 'error'); 
  }
}