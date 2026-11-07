import { db } from './firebase-config.js';
import { doc, getDoc, setDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let panZoom = null;
let svgRoot = null;
let originalSvgText = '';
let originalSvgViewBox = null;
let labelSettings = {};
let allianceMap = {};
let territoryAssignments = {};
let onTerritoryClick = null;
let selectedTerritories = new Set();
let hideUnassignedLabels = false;

const FALLBACK_VIEWBOX = [-10, -10, 550, 542];
const LABELS_STATE_KEY = 'ts_labels_visible';
const TRADE_STROKE_LIGHT = '#f59e0b';
const TRADE_STROKE_DARK = '#fbbf24';
const TRADE_STROKE_WIDTH = '2.5';

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
  const m = String(id || '').match(/^([A-Z])/);
  return m ? m[1] : null;
}
export function getTerritoryLevel(id) {
  const s = String(id || '');
  const m = s.match(/^[A-Z](\d+)?-/);
  if (!m) return null;
  if (m[1]) return parseInt(m[1]);
  const parts = s.split('-');
  return (parts.length >= 2 && /^\d+$/.test(parts[1])) ? parseInt(parts[1]) : null;
}
function safeParseViewBox(str) {
  if (typeof str !== 'string' || !str) return null;
  try {
    const parts = str.trim().split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n));
    if (parts.length !== 4 || parts[2] <= 0 || parts[3] <= 0) return null;
    return parts;
  } catch { return null; }
}

function addTradeLegend(container) {
  if (!container || container.querySelector('.map-trade-legend')) return;
  const el = document.createElement('div');
  el.className = 'map-trade-legend';
  el.innerHTML = '<span class="map-trade-legend-swatch"></span><span>Торговые посты</span>';
  container.appendChild(el);
}

function addMapControls(container, pz, interactive, handleTerritoryClick) {
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  let editMode = interactive && !isTouch;
  let panEnabled = isTouch ? true : !interactive;
  let isFullscreen = false;
  let savedEdit = editMode;
  let savedPan = panEnabled;

  const controls = document.createElement('div');
  controls.className = 'map-controls';
  container.style.position = 'relative';
  container.appendChild(controls);

  const render = () => {
    let html = `
      <button data-action="zoomIn" title="Увеличить"><i class="fas fa-search-plus"></i></button>
      <button data-action="zoomOut" title="Уменьшить"><i class="fas fa-search-minus"></i></button>
      <button data-action="reset" title="Сбросить вид"><i class="fas fa-compress-arrows-alt"></i></button>
      <button data-action="fullscreen" title="${isFullscreen ? 'Выйти из полного экрана' : 'Во весь экран'}">
        <i class="fas fa-${isFullscreen ? 'compress' : 'expand'}"></i>
      </button>
    `;
    if (interactive && !isFullscreen) {
      const editTitle = editMode
        ? 'Редактирование включено (клик по территориям)'
        : 'Редактирование выключено';
      html += `<button data-action="toggleEdit" class="${editMode ? 'active' : ''}" title="${editTitle}"><i class="fas fa-pen"></i></button>`;
    }
    if (!isFullscreen) {
      const panTitle = panEnabled
        ? 'Перемещение включено (1 палец двигает карту)'
        : 'Перемещение выключено (1 палец прокручивает страницу)';
      html += `<button data-action="togglePan" class="${panEnabled ? 'active' : ''}" title="${panTitle}"><i class="fas fa-arrows-alt"></i></button>`;
    }
    controls.innerHTML = html;
  };

  const applyInteraction = () => {
    container.style.touchAction = 'none';
    const svg = container.querySelector('svg');
    if (svg) {
      svg.style.touchAction = 'none';
      svg.querySelectorAll('*').forEach(el => { el.style.touchAction = 'none'; });
    }
    if (panEnabled) {
      pz.enablePan();
    } else {
      pz.disablePan();
      pz.enableZoom();
      if (typeof pz.enableTouchZoom === 'function') pz.enableTouchZoom();
    }
  };

  render();
  applyInteraction();

  let tapData = null;
  let scrollTouchY = null;
  let scrollMoved = false;
  const TAP_THRESHOLD = 10;
  const SCROLL_THRESHOLD = 5;
  const TAP_TIME_LIMIT = 600;

  const onTouchStart = (e) => {
    if (e.touches.length !== 1) { tapData = null; return; }
    const t = e.touches[0];
    tapData = { x: t.clientX, y: t.clientY, time: Date.now(), moved: false };
    if (!panEnabled) scrollTouchY = t.clientY;
  };

  const onTouchMove = (e) => {
    if (e.touches.length >= 2) {
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];

    if (tapData && !tapData.moved) {
      const dx = Math.abs(t.clientX - tapData.x);
      const dy = Math.abs(t.clientY - tapData.y);
      if (dx > TAP_THRESHOLD || dy > TAP_THRESHOLD) tapData.moved = true;
    }

    if (!panEnabled && scrollTouchY !== null) {
      const dy = scrollTouchY - t.clientY;
      if (Math.abs(dy) > SCROLL_THRESHOLD) {
        scrollMoved = true;
        window.scrollBy(0, dy);
        scrollTouchY = t.clientY;
      }
    }
  };

  const onTouchEnd = (e) => {
    let handled = false;

    if (tapData && !tapData.moved && !scrollMoved) {
      const dt = Date.now() - tapData.time;
      if (dt < TAP_TIME_LIMIT) {
        const touch = e.changedTouches && e.changedTouches[0];
        if (touch) {
          let el = document.elementFromPoint(touch.clientX, touch.clientY);
          if (el && el.closest && el.closest('#labels')) el = null;
          const territory = el && el.closest ? el.closest('.territory') : null;
          if (territory && interactive && !isFullscreen && editMode) {
            handled = true;
            try {
              handleTerritoryClick(territory.id, territory);
            } catch (err) { console.error('tap error:', err); }
          }
        }
      }
    }

    if (handled || scrollMoved || (tapData && tapData.moved)) {
      container._suppressClick = true;
      setTimeout(() => { container._suppressClick = false; }, 250);
    }

    tapData = null;
    scrollTouchY = null;
    scrollMoved = false;
  };

  const onTouchCancel = () => {
    tapData = null;
    scrollTouchY = null;
    scrollMoved = false;
  };

  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchCancel, { passive: true });

  const enterFullscreen = async () => {
    savedEdit = editMode;
    savedPan = panEnabled;
    editMode = false;
    panEnabled = true;
    isFullscreen = true;
    render();
    applyInteraction();
    container.classList.add('is-fullscreen');
    try {
      if (container.requestFullscreen) await container.requestFullscreen();
      else if (container.webkitRequestFullscreen) await container.webkitRequestFullscreen();
      else if (container.msRequestFullscreen) await container.msRequestFullscreen();
      else {
        container.classList.add('fullscreen-fallback');
        document.body.classList.add('no-scroll');
      }
    } catch (e) { console.warn('fullscreen error:', e); }
    setTimeout(() => { pz.resize(); pz.fit(); pz.center(); }, 200);
  };

  const exitFullscreen = async () => {
    isFullscreen = false;
    container.classList.remove('is-fullscreen', 'fullscreen-fallback');
    document.body.classList.remove('no-scroll');
    editMode = savedEdit;
    panEnabled = savedPan;
    render();
    applyInteraction();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.webkitFullscreenElement) await document.webkitExitFullscreen();
    } catch (e) { console.warn('exit fullscreen error:', e); }
    setTimeout(() => { pz.resize(); pz.fit(); pz.center(); }, 200);
  };

  const onFsChange = () => {
    const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!active && isFullscreen) {
      isFullscreen = false;
      container.classList.remove('is-fullscreen', 'fullscreen-fallback');
      document.body.classList.remove('no-scroll');
      editMode = savedEdit;
      panEnabled = savedPan;
      render();
      applyInteraction();
      setTimeout(() => { pz.resize(); pz.fit(); pz.center(); }, 200);
    }
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  controls.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'zoomIn') pz.zoomIn();
    else if (action === 'zoomOut') pz.zoomOut();
    else if (action === 'reset') { pz.resize(); pz.fit(); pz.center(); }
    else if (action === 'toggleEdit') {
      if (isFullscreen) return;
      editMode = !editMode;
      render();
    }
    else if (action === 'togglePan') {
      if (isFullscreen) return;
      panEnabled = !panEnabled;
      render();
      applyInteraction();
    }
    else if (action === 'fullscreen') {
      if (isFullscreen) await exitFullscreen();
      else await enterFullscreen();
    }
  });

  container._getEditMode = () => editMode;
}

export async function initMap({ containerId, interactive = false, clickHandler = null }) {
  const container = document.getElementById(containerId);

  try {
    const res = await fetch('assets/map.svg');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    originalSvgText = await res.text();
    container.innerHTML = originalSvgText;
  } catch (e) {
    console.error('Map load error:', e);
    container.innerHTML = `
      <div class="p-6 text-center text-red-500">
        <p class="font-bold text-lg mb-2"><i class="fas fa-exclamation-triangle mr-2"></i>Карта не загружена</p>
        <p class="text-sm">Ошибка: ${e.message}</p>
      </div>`;
    return null;
  }

  svgRoot = container.querySelector('svg');
  if (!svgRoot) return null;

  originalSvgViewBox = safeParseViewBox(svgRoot.getAttribute('viewBox')) || [...FALLBACK_VIEWBOX];
  svgRoot.removeAttribute('width');
  svgRoot.removeAttribute('height');

  addTradeLegend(container);

  const handleTerritoryClick = (id, el) => {
    if (container._suppressClick) return;
    if (!interactive) return;
    if (container.classList.contains('is-fullscreen')) return;
    if (container._getEditMode && !container._getEditMode()) return;
    if (clickHandler) clickHandler(id, el);
    else toggleSelection(el);
  };

  onTerritoryClick = clickHandler;

  if (typeof svgPanZoom === 'function') {
    try {
      panZoom = svgPanZoom(svgRoot, {
        zoomEnabled: true, controlIconsEnabled: false,
        fit: true, center: true,
        minZoom: 0.4, maxZoom: 12,
        zoomScaleSensitivity: 0.4,
        preventClickEventEnabled: false
      });

      panZoom.enableZoom();
      if (typeof panZoom.enableTouchZoom === 'function') panZoom.enableTouchZoom();

      const doFit = () => {
        try { panZoom.resize(); panZoom.fit(); panZoom.center(); } catch (e) { console.warn('fit failed:', e); }
      };
      doFit();
      requestAnimationFrame(doFit);
      setTimeout(doFit, 150);
      setTimeout(doFit, 500);

      try {
        let lastW = 0, lastH = 0;
        const ro = new ResizeObserver(() => {
          const w = container.clientWidth;
          const h = container.clientHeight;
          if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) {
            lastW = w; lastH = h;
            doFit();
          }
        });
        ro.observe(container);
      } catch (e) { console.warn('ResizeObserver failed:', e); }

      addMapControls(container, panZoom, interactive, handleTerritoryClick);
    } catch (e) {
      console.error('panZoom init failed:', e);
    }
  }

  await loadAllData();

  svgRoot.querySelectorAll('.territory').forEach(t => {
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      handleTerritoryClick(t.id, t);
    });
  });

  applyAll();
  return { panZoom, svgRoot };
}

export function setupLabelsToggle(buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  let visible = localStorage.getItem(LABELS_STATE_KEY) !== 'false';
  const updateBtn = () => {
    if (visible) {
      btn.innerHTML = '<i class="fas fa-eye mr-1"></i>Подписи вкл';
      btn.classList.remove('bg-gray-200', 'dark:bg-gray-700', 'bg-gray-600');
      btn.classList.add('bg-green-600', 'text-white');
    } else {
      btn.innerHTML = '<i class="fas fa-eye-slash mr-1"></i>Подписи выкл';
      btn.classList.remove('bg-green-600', 'text-white', 'bg-gray-600');
      btn.classList.add('bg-gray-200', 'dark:bg-gray-700');
    }
    toggleLabels(visible);
  };
  updateBtn();
  btn.addEventListener('click', () => {
    visible = !visible;
    localStorage.setItem(LABELS_STATE_KEY, String(visible));
    updateBtn();
  });
}

export function setHideUnassignedLabels(v) {
  hideUnassignedLabels = !!v;
  applyLabelTexts();
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
    if (allianceId && a[allianceId]) {
      txt.textContent = a[allianceId].tag;
    } else {
      txt.textContent = hideUnassignedLabels ? '' : 'ABC';
    }
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
    if (cfg.fill !== undefined && cfg.fill !== null && cfg.fill !== '') txt.style.fill = cfg.fill;
    else txt.style.fill = '';
    txt.style.stroke = '';
    txt.style.strokeWidth = '';
    txt.style.paintOrder = '';
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

export function getTerritoryAssignments() { return { ...territoryAssignments }; }

export function computeAllianceStats(assignments) {
  const stats = {};
  for (const [tid, aid] of Object.entries(assignments || {})) {
    if (!aid) continue;
    if (!stats[aid]) stats[aid] = { bastions: 0, general: 0, trade: 0, total: 0 };
    const type = getTerritoryType(tid);
    if (type === 'B') stats[aid].bastions++;
    else if (type === 'T') stats[aid].trade++;
    else stats[aid].general++;
    stats[aid].total++;
  }
  return stats;
}

// ⭐ EXPORT PNG с поддержкой темы
export async function exportMapPNG(withLabels, theme = 'light') {
  try {
    if (!originalSvgText) { alert('Карта ещё не загружена.'); return; }
    const isDark = theme === 'dark';

    // Цвета в зависимости от выбранной темы (не от темы страницы)
    const canvasBg = isDark ? '#1e293b' : '#ffffff';
    const emptyFill = isDark ? '#334155' : '#ffffff';
    const arcadiaFill = isDark ? '#0f172a' : '#f4f4f4';
    const territoryStroke = isDark ? '#94a3b8' : '#000000';
    const tradeStroke = isDark ? TRADE_STROKE_DARK : TRADE_STROKE_LIGHT;
    const labelFill = isDark ? '#ffffff' : '#000000';
    const labelStroke = isDark ? '#000000' : '#ffffff';
    const legendLine = isDark ? '#334155' : '#cccccc';
    const legendText = isDark ? '#e2e8f0' : '#000000';
    const legendBorder = isDark ? '#64748b' : '#000000';

    const parser = new DOMParser();
    const doc = parser.parseFromString(originalSvgText, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName === 'parsererror') throw new Error('Не удалось распарсить SVG');
    svg.removeAttribute('style');
    svg.removeAttribute('width');
    svg.removeAttribute('height');

    const labels = svg.getElementById('labels');
    if (labels && !withLabels) labels.remove();

    svg.querySelectorAll('.territory').forEach(t => {
      const allianceId = territoryAssignments[t.id];
      const alliance = allianceId ? allianceMap[allianceId] : null;
      t.removeAttribute('class');
      t.removeAttribute('style');
      t.style.fill = alliance ? alliance.color : emptyFill;
      const isTrade = String(t.id).startsWith('T-');
      t.style.stroke = isTrade ? tradeStroke : territoryStroke;
      t.style.strokeWidth = isTrade ? TRADE_STROKE_WIDTH + 'px' : '1px';
      if (t.id === 'A') t.style.fill = arcadiaFill;
    });

    if (withLabels && labels) {
      labels.querySelectorAll('.label').forEach(txt => {
        const id = txt.dataset.id;
        const cfg = labelSettings[id] || {};
        const dx = cfg.dx || 0, dy = cfg.dy || 0;
        const rot = cfg.rotation || 0, scale = cfg.scale || 1;
        const ox = parseFloat(txt.getAttribute('x')) || 0;
        const oy = parseFloat(txt.getAttribute('y')) || 0;
        const allianceId = territoryAssignments[id];
        const alliance = allianceId ? allianceMap[allianceId] : null;
        if (!alliance && hideUnassignedLabels) { txt.remove(); return; }
        txt.textContent = alliance ? alliance.tag : 'ABC';
        txt.removeAttribute('class');
        txt.setAttribute('transform',
          `translate(${ox + dx} ${oy + dy}) rotate(${rot}) scale(${scale}) translate(${-ox} ${-oy})`
        );
        txt.style.fill = cfg.fill || labelFill;
        txt.style.stroke = labelStroke;
        txt.style.strokeWidth = '2px';
        txt.style.strokeLinejoin = 'round';
        txt.style.paintOrder = 'stroke';
        txt.style.fontFamily = 'Arial, sans-serif';
        txt.style.fontSize = '10px';
        txt.style.textAnchor = 'middle';
        txt.style.dominantBaseline = 'central';
      });
    }

    const vb = originalSvgViewBox || [...FALLBACK_VIEWBOX];
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('viewBox', vb.join(' '));
    svg.setAttribute('width', String(vb[2]));
    svg.setAttribute('height', String(vb[3]));

    const svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const width = 2000;
    const mapHeight = Math.round(width * vb[3] / vb[2]);

    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = (e) => { console.error('img load error', e); rej(e); };
      img.src = url;
    });

    const legend = buildLegend();
    const cols = Math.min(3, Math.max(1, Math.ceil(legend.length / 4)));
    const rows = legend.length ? Math.ceil(legend.length / cols) : 0;
    const L_FONT = 22, L_LINE = 36, L_PAD = 24, L_SWATCH = 20;
    const legendHeight = legend.length ? L_PAD * 2 + rows * L_LINE : 0;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = mapHeight + legendHeight;
    const ctx = canvas.getContext('2d');

    // Фон всей картинки
    ctx.fillStyle = canvasBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, width, mapHeight);
    URL.revokeObjectURL(url);

    // Легенда
    if (legend.length) {
      ctx.strokeStyle = legendLine;
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

        ctx.fillStyle = item.color;
        ctx.fillRect(x, y - L_SWATCH / 2, L_SWATCH, L_SWATCH);
        ctx.strokeStyle = legendBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y - L_SWATCH / 2, L_SWATCH, L_SWATCH);

        ctx.fillStyle = legendText;
        ctx.font = `bold ${L_FONT}px Arial, sans-serif`;
        ctx.textBaseline = 'middle';
        const text = `${item.rank}. ${item.tag} — ${totalTerr(item)}  |  Б:${item.bastions} Г:${item.general} Т:${item.trade}`;
        ctx.fillText(text, x + L_SWATCH + 10, y);
      });
    }

    const link = document.createElement('a');
    link.download = `map-217-${theme}-${withLabels ? 'labels' : 'plain'}-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (err) {
    console.error('exportMapPNG failed:', err);
    alert('Ошибка экспорта PNG: ' + err.message);
  }
}

function buildLegend() {
  const stats = computeAllianceStats(territoryAssignments);
  const list = Object.values(allianceMap).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  return list.map((a, idx) => {
    const s = stats[a.id] || { bastions: 0, general: 0, trade: 0, total: 0 };
    return { id: a.id, tag: a.tag, color: a.color, rank: idx + 1, ...s };
  }).filter(item => item.total > 0);
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