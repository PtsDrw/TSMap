import { db } from './firebase-config.js';
import { doc, getDoc, setDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let panZoom = null;
let svgRoot = null;
let labelSettings = {};
let allianceMap = {};
let territoryAssignments = {};
let onTerritoryClick = null;
let selectedTerritories = new Set();

const TERRITORY_TYPES = {
  D: { label: 'Деревни', subs: false },
  Z: { label: 'Заводы', subs: false },
  G: { label: 'Городки', subs: false },
  M: { label: 'Мегаполисы', subs: false },
  C: { label: 'Центры исследований', subs: false },
  V: { label: 'Военные комплексы', subs: false },
  B: { label: 'Бастионы', subs: true, levels: [1,2,3,4,5,6] },
  T: { label: 'Торговые посты', subs: true, levels: [1,2,3,4,5] }
};

export function getTerritoryType(id) {
  const m = id.match(/^([A-Z])/);
  return m ? m[1] : null;
}
export function getTerritoryLevel(id) {
  // Поддерживает оба формата:
  //   B1-1  → 1  (тип+уровень слитно)
  //   T-5-4 → 5  (тип-уровень-номер)
  const m = id.match(/^[A-Z](\d+)?-/);
  if (!m) return null;
  if (m[1]) return parseInt(m[1]); // B1- → 1
  const parts = id.split('-');
  return (parts.length >= 2 && /^\d+$/.test(parts[1])) ? parseInt(parts[1]) : null;
}

export async function initMap({ containerId, interactive = false, clickHandler = null }) {
  const container = document.getElementById(containerId);

  try {
    const res = await fetch('assets/map.svg');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const svgText = await res.text();
    container.innerHTML = svgText;
  } catch (e) {
    console.error('Map load error:', e);
    container.innerHTML = `
      <div class="p-6 text-center text-red-500">
        <p class="font-bold text-lg mb-2"><i class="fas fa-exclamation-triangle mr-2"></i>Карта не загружена</p>
        <p class="text-sm">Ошибка: ${e.message}</p>
        <p class="text-xs mt-3 text-gray-500">
          Проверьте, что файл <code>assets/map.svg</code> существует,<br>
          и что вы открываете сайт через <b>HTTP-сервер</b> (не <code>file://</code>).
        </p>
      </div>`;
    return null;
  }

  svgRoot = container.querySelector('svg');
  if (!svgRoot) return null;

  // ⭐ ЦЕНТРИРОВАНИЕ: обрезаем viewBox по реальному bbox группы территорий
  try {
    const group = svgRoot.getElementById('territories') || svgRoot;
    const bbox = group.getBBox();
    if (bbox.width > 0 && bbox.height > 0) {
      const pad = Math.max(bbox.width, bbox.height) * 0.02;
      svgRoot.setAttribute('viewBox',
        `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`);
    }
  } catch (e) { console.warn('viewBox calc failed:', e); }

  if (typeof svgPanZoom === 'function') {
    panZoom = svgPanZoom(svgRoot, {
      zoomEnabled: true, controlIconsEnabled: false,
      fit: true, center: true,
      minZoom: 0.4, maxZoom: 12,
      zoomScaleSensitivity: 0.4
    });
    // ⭐ Принудительный fit+center после инициализации
    try {
      panZoom.resize();
      panZoom.fit();
      panZoom.center();
    } catch {}
  }

  await loadAllData();
  onTerritoryClick = clickHandler;
  svgRoot.querySelectorAll('.territory').forEach(t => {
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!interactive) return;
      if (onTerritoryClick) onTerritoryClick(t.id, t);
      else toggleSelection(t);
    });
  });

  applyAll();
  return { panZoom, svgRoot };
}

function toggleSelection(el) {
  if (el.classList.contains('selected')) {
    el.classList.remove('selected');
    selectedTerritories.delete(el.id);
  } else {
    el.classList.add('selected');
    selectedTerritories.add(el.id);
  }
}

export function clearSelection() {
  if (!svgRoot) return;
  svgRoot.querySelectorAll('.territory.selected').forEach(t => t.classList.remove('selected'));
  selectedTerritories.clear();
}
export function getSelected() { return Array.from(selectedTerritories); }
export function selectTerritory(id, selected = true) {
  if (!svgRoot) return;
  const el = svgRoot.getElementById(id);
  if (!el) return;
  el.classList.toggle('selected', selected);
  if (selected) selectedTerritories.add(id); else selectedTerritories.delete(id);
}

// ⭐ Выбрать все (с учётом опционального фильтра)
export function selectAllFiltered(filterFn) {
  if (!svgRoot) return 0;
  const ids = getAllTerritoryIds();
  let count = 0;
  ids.forEach(id => {
    if (!filterFn || filterFn(id)) {
      selectTerritory(id, true);
      count++;
    }
  });
  return count;
}

async function loadAllData() {
  const ls = await getDocs(collection(db, 'label_settings'));
  labelSettings = {};
  ls.forEach(d => labelSettings[d.id] = d.data());

  const al = await getDocs(collection(db, 'alliances'));
  allianceMap = {};
  al.forEach(d => allianceMap[d.id] = { id: d.id, ...d.data() });

  const tt = await getDocs(collection(db, 'territories'));
  territoryAssignments = {};
  tt.forEach(d => territoryAssignments[d.id] = d.data().allianceId);
}

export function applyAll() {
  applyTerritoryColors();
  applyLabelSettings();
  applyLabelTexts();
}

export function applyTerritoryColors(assignments = null, alliances = null) {
  if (!svgRoot) return;
  const a = alliances || allianceMap;
  const as = assignments || territoryAssignments;
  svgRoot.querySelectorAll('.territory').forEach(t => {
    const allianceId = as[t.id];
    if (allianceId && a[allianceId]) t.style.fill = a[allianceId].color;
    else t.style.fill = '';
  });
}

export function applyLabelTexts(assignments = null, alliances = null) {
  if (!svgRoot) return;
  const a = alliances || allianceMap;
  const as = assignments || territoryAssignments;
  svgRoot.querySelectorAll('#labels .label').forEach(txt => {
    const id = txt.dataset.id;
    const allianceId = as[id];
    txt.textContent = (allianceId && a[allianceId]) ? a[allianceId].tag : 'XXX';
  });
}

export function applyLabelSettings(settings = null) {
  if (!svgRoot) return;
  const s = settings || labelSettings;
  svgRoot.querySelectorAll('#labels .label').forEach(txt => {
    const id = txt.dataset.id;
    const cfg = s[id] || {};
    const dx = cfg.dx || 0, dy = cfg.dy || 0;
    const rot = cfg.rotation || 0, scale = cfg.scale || 1;

    txt.style.transformOrigin = 'center center';
    txt.style.transformBox = 'fill-box';
    txt.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(${scale})`;

    // ⭐ Цвет: только если явно задан (для совместимости со старыми данными), иначе — по CSS-теме
    if (cfg.fill !== undefined && cfg.fill !== null && cfg.fill !== '') {
      txt.style.fill = cfg.fill;
    } else {
      txt.style.fill = '';
    }
    // Обводку убрали из UI, но старые данные поддерживаем
    if (cfg.strokeWidth && cfg.strokeWidth > 0) {
      txt.style.stroke = cfg.stroke || '#ffffff';
      txt.style.strokeWidth = cfg.strokeWidth + 'px';
      txt.style.paintOrder = 'stroke';
    } else {
      txt.style.stroke = '';
      txt.style.strokeWidth = '';
    }
  });
}

export function toggleLabels(show) {
  if (!svgRoot) return;
  const layer = svgRoot.getElementById('labels');
  if (layer) layer.style.display = show ? 'block' : 'none';
}

export function getLabelSettings() { return { ...labelSettings }; }
export function setLabelSettings(s) { labelSettings = s; applyLabelSettings(); }

export function setPreviewData(alliances, assignments) {
  allianceMap = alliances;
  territoryAssignments = assignments;
  applyTerritoryColors(assignments, alliances);
  applyLabelTexts(assignments, alliances);
}

export async function saveLabelSettings(newSettings, replace = false) {
  const promises = [];
  for (const [id, cfg] of Object.entries(newSettings)) {
    if (replace) promises.push(setDoc(doc(db, 'label_settings', id), cfg));
    else promises.push(setDoc(doc(db, 'label_settings', id), cfg, { merge: true }));
  }
  await Promise.all(promises);
  labelSettings = { ...labelSettings, ...newSettings };
  applyLabelSettings();
}

export async function exportMapPNG(withLabels) {
  if (!svgRoot) return;

  // ═══ ПОДГОТОВКА SVG ═══
  const svg = svgRoot.cloneNode(true);
  const labels = svg.getElementById('labels');
  if (labels && !withLabels) labels.remove();

  svg.querySelectorAll('.territory').forEach(t => {
    const inlineFill = t.style.fill;
    t.removeAttribute('class');
    t.removeAttribute('style');
    t.setAttribute('fill', inlineFill || '#ffffff');
    t.setAttribute('stroke', '#000000');
    t.setAttribute('stroke-width', '1');
    if (t.id === 'A') t.setAttribute('fill', '#f4f4f4');
  });

  if (withLabels && labels) {
    labels.querySelectorAll('.label').forEach(txt => {
      const id = txt.dataset.id;
      const cfg = labelSettings[id] || {};
      const dx = cfg.dx || 0, dy = cfg.dy || 0;
      const rot = cfg.rotation || 0, scale = cfg.scale || 1;
      txt.removeAttribute('class');
      txt.removeAttribute('style');
      txt.setAttribute('transform', `translate(${dx}, ${dy}) rotate(${rot}) scale(${scale})`);
      txt.setAttribute('fill', cfg.fill || '#000000');
      if (cfg.strokeWidth && cfg.strokeWidth > 0) {
        txt.setAttribute('stroke', cfg.stroke || '#ffffff');
        txt.setAttribute('stroke-width', cfg.strokeWidth);
        txt.setAttribute('paint-order', 'stroke');
      }
      txt.setAttribute('font-family', 'Arial, sans-serif');
      txt.setAttribute('font-size', '10px');
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('dominant-baseline', 'central');
    });
  }

  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
  const width = 2000;
  const mapHeight = Math.round(width * viewBox[3] / viewBox[2]);

  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

  // ═══ ЛЕГЕНДА ═══
  const legend = buildLegend();
  const cols = Math.min(3, Math.max(1, Math.ceil(legend.length / 4)));
  const rows = legend.length ? Math.ceil(legend.length / cols) : 0;

  const L_FONT = 22;
  const L_LINE = 36;
  const L_PAD = 24;
  const L_SWATCH = 20;
  const legendHeight = legend.length ? L_PAD * 2 + rows * L_LINE : 0;

  // ═══ CANVAS ═══
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = mapHeight + legendHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.drawImage(img, 0, 0, width, mapHeight);
  URL.revokeObjectURL(url);

  // Легенда
  if (legend.length) {
    // Разделитель
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, mapHeight);
    ctx.lineTo(width, mapHeight);
    ctx.stroke();

    const colWidth = width / cols;
    const totalTerr = (item) => item.bastions + item.general + item.trade;

    legend.forEach((item, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      const x = L_PAD + col * colWidth;
      const y = mapHeight + L_PAD + row * L_LINE + L_LINE / 2;

      // Цветной квадрат
      ctx.fillStyle = item.color;
      ctx.fillRect(x, y - L_SWATCH / 2, L_SWATCH, L_SWATCH);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y - L_SWATCH / 2, L_SWATCH, L_SWATCH);

      // Текст
      ctx.fillStyle = '#000000';
      ctx.font = `bold ${L_FONT}px Arial, sans-serif`;
      ctx.textBaseline = 'middle';
      const text = `${item.rank}. ${item.tag} — ${totalTerr(item)}  |  Б:${item.bastions} Г:${item.general} Т:${item.trade}`;
      ctx.fillText(text, x + L_SWATCH + 10, y);
    });
  }

  const link = document.createElement('a');
  link.download = `map-217-${withLabels ? 'labels' : 'plain'}-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// ⭐ Собирает статистику по союзам для легенды
function buildLegend() {
  const stats = {};
  for (const [tid, aid] of Object.entries(territoryAssignments)) {
    if (!aid) continue;
    if (!stats[aid]) stats[aid] = { bastions: 0, general: 0, trade: 0 };
    const type = getTerritoryType(tid);
    if (type === 'B') stats[aid].bastions++;
    else if (type === 'T') stats[aid].trade++;
    else stats[aid].general++;
  }

  const list = Object.values(allianceMap)
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  return list.map((a, idx) => {
    const s = stats[a.id] || { bastions: 0, general: 0, trade: 0 };
    return { id: a.id, tag: a.tag, color: a.color, rank: idx + 1, ...s };
  }).filter(item => (item.bastions + item.general + item.trade) > 0);
}

export function getTerritoryTypes() { return TERRITORY_TYPES; }

export function getAllTerritoryIds() {
  if (!svgRoot) return [];
  return Array.from(svgRoot.querySelectorAll('.territory')).map(t => t.id).filter(id => id !== 'A');
}

export function getFilteredTerritories(filters) {
  const ids = [];
  getAllTerritoryIds().forEach(id => {
    const type = getTerritoryType(id);
    if (type === 'B' || type === 'T') {
      const level = getTerritoryLevel(id);
      if (filters[type] && filters[type][level]) ids.push(id);
    } else {
      if (filters[type]) ids.push(id);
    }
  });
  return ids;
}