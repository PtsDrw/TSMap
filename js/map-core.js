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
let showUnassignedIcons = false;
let showHiddenLabels = false; 

const FALLBACK_VIEWBOX = [-10, -10, 550, 542];
const LABELS_STATE_KEY = 'ts_labels_visible';
const UNASSIGNED_ICONS_KEY = 'ts_unassigned_icons';
const TRADE_STROKE_LIGHT = '#f59e0b';
const TRADE_STROKE_DARK = '#fbbf24';
const TRADE_STROKE_WIDTH = '2.5';
const SVG_NS = 'http://www.w3.org/2000/svg';

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

const LEVEL_BY_TYPE = { D: 1, Z: 2, G: 3, M: 4, C: 5, V: 6 };

const ICON_SIZE = 10;
const ICON_HALF = ICON_SIZE / 2;
const ICON_GAP = 2;

function createIconShape(kind) {
  let fill, stroke, points;
  if (kind === 'bastion') {
    fill = '#7c3aed'; stroke = '#1e1b4b';
    points = `${ICON_HALF},0 ${ICON_SIZE},0 ${ICON_SIZE},${ICON_HALF + 3} ${ICON_HALF},${ICON_SIZE} 0,${ICON_HALF + 3} 0,0`;
  } else if (kind === 'trade') {
    fill = '#f59e0b'; stroke = '#7c2d12';
    points = `${ICON_HALF},0 ${ICON_SIZE},${ICON_HALF} ${ICON_HALF},${ICON_SIZE} 0,${ICON_HALF}`;
  } else {
    fill = '#3b82f6'; stroke = '#1e3a8a';
    points = `0,${ICON_HALF - 1} ${ICON_HALF},0 ${ICON_SIZE},${ICON_HALF - 1} ${ICON_SIZE},${ICON_SIZE} 0,${ICON_SIZE}`;
  }
  const shape = document.createElementNS(SVG_NS, 'polygon');
  shape.setAttribute('points', points);
  shape.setAttribute('fill', fill);
  shape.setAttribute('stroke', stroke);
  shape.setAttribute('stroke-width', '0.6');
  shape.setAttribute('stroke-linejoin', 'round');
  return shape;
}

function getIconTextColor(kind) {
  if (kind === 'trade') return '#7c2d12';
  return '#ffffff';
}

function createIconNumber(level, textColor = '#ffffff') {
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(ICON_HALF));
  t.setAttribute('y', String(ICON_HALF + 0.5));
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('dominant-baseline', 'central');
  t.setAttribute('font-family', 'Arial, sans-serif');
  t.setAttribute('font-size', '6.5');
  t.setAttribute('font-weight', 'bold');
  t.setAttribute('fill', textColor);
  t.textContent = String(level);
  return t;
}

function getLabelStyleColors() {
  const isDark = document.documentElement.classList.contains('dark');
  return { fill: isDark ? '#ffffff' : '#000000', stroke: isDark ? '#000000' : '#ffffff' };
}

const textMeasureCanvas = document.createElement('canvas');
const textMeasureCtx = textMeasureCanvas.getContext('2d');

function measureTextWidth(text, fontSize = 9, fontWeight = 'bold') {
  textMeasureCtx.font = `${fontWeight} ${fontSize}px Arial, sans-serif`;
  return textMeasureCtx.measureText(text).width;
}

function parsePoints(str) {
  if (!str) return [];
  const arr = str.trim().split(/[\s,]+/).map(Number);
  const out = [];
  for (let i = 0; i + 1 < arr.length; i += 2) out.push([arr[i], arr[i + 1]]);
  return out;
}

function isPointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function doesTextFit(id, tag, ox, oy, cfg) {
  if (!tag) return false;
  const dx = cfg.dx || 0, dy = cfg.dy || 0;
  const rot = cfg.rotation || 0, scale = cfg.scale || 1;
  const tagWidth = measureTextWidth(tag);
  const totalWidthWithTag = ICON_SIZE + ICON_GAP + tagWidth;
  const totalHeight = Math.max(ICON_SIZE, 9);
  const localW = totalWidthWithTag;
  const localH = totalHeight;
  const startX = -localW / 2;
  const corners = [
    { x: startX, y: -localH / 2 }, { x: startX + localW, y: -localH / 2 },
    { x: startX + localW, y: localH / 2 }, { x: startX, y: localH / 2 }
  ];
  const rad = rot * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const finalCorners = corners.map(c => ({
    x: ox + dx + scale * (c.x * cos - c.y * sin),
    y: oy + dy + scale * (c.x * sin + c.y * cos)
  }));
  const el = svgRoot.getElementById(id);
  if (!el) return true;
  const polyPts = parsePoints(el.getAttribute('points'));
  if (polyPts.length === 0) return true;
  for (const pt of finalCorners) {
    if (!isPointInPolygon(pt.x, pt.y, polyPts)) return false;
  }
  return true;
}

function buildLabelsLayer() {
  if (!svgRoot) return;
  const labelsLayer = svgRoot.getElementById('labels');
  if (!labelsLayer) return;
  labelsLayer.querySelectorAll('.label-group').forEach(el => el.remove());
  labelsLayer.querySelectorAll('.label').forEach(txt => { txt.style.display = 'none'; });
  const allIds = getAllTerritoryIds();
  allIds.forEach(id => {
    const allianceId = territoryAssignments[id];
    const info = getTerritoryLevelLabel(id);
    if (!info) return;
    
    const alliance = allianceId ? allianceMap[allianceId] : null;
    
    if (!alliance && !showUnassignedIcons && !showHiddenLabels) return;
    
    const cfg = labelSettings[id] || {};
    const dx = cfg.dx || 0, dy = cfg.dy || 0;
    const rot = cfg.rotation || 0, scale = cfg.scale || 1;
    const srcTxt = labelsLayer.querySelector(`.label[data-id="${id}"]`);
    if (!srcTxt) return;
    const ox = parseFloat(srcTxt.getAttribute('x')) || 0;
    const oy = parseFloat(srcTxt.getAttribute('y')) || 0;
    
    let tag = '';
    let isOverflowing = false;
    let isTemplate = false;
    let showTag = false;

    if (alliance) {
      tag = alliance.tag;
      const fits = doesTextFit(id, tag, ox, oy, cfg);
      showTag = fits || showHiddenLabels;
      isOverflowing = !fits && showHiddenLabels;
    } else if (showHiddenLabels) {
      tag = 'XXX';
      showTag = true;
      isTemplate = true;
    }

    const tagWidth = tag ? measureTextWidth(tag) : 0;
    const finalWidth = showTag ? (ICON_SIZE + ICON_GAP + tagWidth) : ICON_SIZE;
    const startX = -finalWidth / 2;
    
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'label-group');
    group.setAttribute('data-id', id);
    group.setAttribute('pointer-events', 'none');
    group.setAttribute('transform', `translate(${ox + dx} ${oy + dy}) rotate(${rot}) scale(${scale})`);
    
    const iconG = document.createElementNS(SVG_NS, 'g');
    iconG.setAttribute('transform', `translate(${startX} -${ICON_HALF})`);
    iconG.appendChild(createIconShape(info.kind));
    iconG.appendChild(createIconNumber(info.level, getIconTextColor(info.kind)));
    group.appendChild(iconG);
    
    if (showTag) {
      const colors = getLabelStyleColors();
      const txt = document.createElementNS(SVG_NS, 'text');
      txt.setAttribute('x', String(startX + ICON_SIZE + ICON_GAP));
      txt.setAttribute('y', '0');
      txt.setAttribute('text-anchor', 'start');
      txt.setAttribute('dominant-baseline', 'central');
      txt.setAttribute('font-family', 'Arial, sans-serif');
      txt.setAttribute('font-size', '9');
      txt.setAttribute('font-weight', 'bold');
      txt.setAttribute('fill', cfg.fill || colors.fill);
      
      // ⭐ НОВАЯ ЛОГИКА СТИЛЕЙ
      if (isTemplate) {
        // Синий пунктир для шаблона
        txt.setAttribute('stroke', '#3b82f6');
        txt.setAttribute('stroke-width', '1.5');
        txt.setAttribute('stroke-dasharray', '2, 2');
      } else if (isOverflowing) {
        // Красный для вылезающего текста
        txt.setAttribute('stroke', '#ef4444');
        txt.setAttribute('stroke-width', '2');
      } else {
        // Стандартный стиль
        txt.setAttribute('stroke', colors.stroke);
        txt.setAttribute('stroke-width', '1');
      }
      
      txt.setAttribute('stroke-linejoin', 'round');
      txt.setAttribute('paint-order', 'stroke');
      txt.textContent = tag;
      group.appendChild(txt);
    }
    labelsLayer.appendChild(group);
  });
}

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

export function getTerritoryLevelLabel(id) {
  const type = getTerritoryType(id);
  if (type === 'B') return { prefix: 'B', level: getTerritoryLevel(id), kind: 'bastion' };
  if (type === 'T') return { prefix: 'T', level: getTerritoryLevel(id), kind: 'trade' };
  if (type === 'A') return null;
  const lvl = LEVEL_BY_TYPE[type] || 0;
  return lvl ? { prefix: 'G', level: lvl, kind: 'city' } : null;
}

function safeParseViewBox(str) {
  if (typeof str !== 'string' || !str) return null;
  try {
    const parts = str.trim().split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n));
    if (parts.length !== 4 || parts[2] <= 0 || parts[3] <= 0) return null;
    return parts;
  } catch { return null; }
}

function pointOnSegment(px, py, x1, y1, x2, y2, eps = 1.5) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.abs(px - x1) < eps && Math.abs(py - y1) < eps;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const nx = x1 + t * dx;
  const ny = y1 + t * dy;
  return Math.sqrt((px - nx) ** 2 + (py - ny) ** 2) < eps;
}

function isAdjacent(pts1, pts2, eps = 1.5) {
  for (const [x1, y1] of pts1) {
    for (const [x2, y2] of pts2) {
      if (Math.abs(x1 - x2) < eps && Math.abs(y1 - y2) < eps) return true;
    }
  }
  for (let i = 0; i < pts1.length; i++) {
    const [px, py] = pts1[i];
    for (let j = 0; j < pts2.length; j++) {
      const [x1, y1] = pts2[j];
      const [x2, y2] = pts2[(j + 1) % pts2.length];
      if (pointOnSegment(px, py, x1, y1, x2, y2, eps)) return true;
    }
  }
  for (let i = 0; i < pts2.length; i++) {
    const [px, py] = pts2[i];
    for (let j = 0; j < pts1.length; j++) {
      const [x1, y1] = pts1[j];
      const [x2, y2] = pts1[(j + 1) % pts1.length];
      if (pointOnSegment(px, py, x1, y1, x2, y2, eps)) return true;
    }
  }
  return false;
}

export function getNeighbors(id) {
  if (!svgRoot) return new Set();
  const el = svgRoot.getElementById(id);
  if (!el) return new Set();
  const pts = parsePoints(el.getAttribute('points'));
  const neighbors = new Set();
  svgRoot.querySelectorAll('.territory').forEach(other => {
    if (other.id === id || other.id === 'A') return;
    const otherPts = parsePoints(other.getAttribute('points'));
    if (isAdjacent(pts, otherPts)) neighbors.add(other.id);
  });
  return neighbors;
}

export function canSelectWithAdjacency(territoryId, selectedIds, adjacencyMode) {
  if (!adjacencyMode) return true;
  if (!selectedIds.length) return true;
  const neighbors = getNeighbors(territoryId);
  return selectedIds.some(sid => neighbors.has(sid));
}

function addTradeLegend(container) {
  if (!container || container.querySelector('.map-trade-legend')) return;
  const el = document.createElement('div');
  el.className = 'map-trade-legend';
  el.innerHTML = '<span class="map-trade-legend-swatch"></span><span>Торговые посты</span>';
  container.appendChild(el);
}

function addMapControls(container, pz, interactive, handleTerritoryClick, onFullscreenEditToggle) {
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  let editMode = interactive && !isTouch;
  let panEnabled = isTouch ? true : !interactive;
  let isFullscreen = false;
  let fullscreenEditPanel = false;
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
    if (interactive) {
      if (isFullscreen) {
        html += `<button data-action="toggleFullscreenEdit" class="${fullscreenEditPanel ? 'active' : ''}" title="${fullscreenEditPanel ? 'Скрыть инструменты' : 'Инструменты редактирования'}"><i class="fas fa-tools"></i></button>`;
      } else {
        const editTitle = editMode ? 'Редактирование включено' : 'Редактирование выключено';
        html += `<button data-action="toggleEdit" class="${editMode ? 'active' : ''}" title="${editTitle}"><i class="fas fa-pen"></i></button>`;
      }
    }
    if (!isFullscreen) {
      const panTitle = panEnabled ? 'Перемещение включено' : 'Перемещение выключено';
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
    if (panEnabled) { pz.enablePan(); } else { pz.disablePan(); pz.enableZoom(); if (typeof pz.enableTouchZoom === 'function') pz.enableTouchZoom(); }
  };

  render();
  applyInteraction();

  let tapData = null, scrollTouchY = null, scrollMoved = false;
  const TAP_THRESHOLD = 10, SCROLL_THRESHOLD = 5, TAP_TIME_LIMIT = 600;

  const onTouchStart = (e) => {
    if (e.touches.length !== 1) { tapData = null; return; }
    const t = e.touches[0];
    tapData = { x: t.clientX, y: t.clientY, time: Date.now(), moved: false };
    if (!panEnabled) scrollTouchY = t.clientY;
  };

  const onTouchMove = (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (tapData && !tapData.moved) {
      const dx = Math.abs(t.clientX - tapData.x);
      const dy = Math.abs(t.clientY - tapData.y);
      if (dx > TAP_THRESHOLD || dy > TAP_THRESHOLD) tapData.moved = true;
    }
    if (!panEnabled && scrollTouchY !== null) {
      const dy = scrollTouchY - t.clientY;
      if (Math.abs(dy) > SCROLL_THRESHOLD) { scrollMoved = true; window.scrollBy(0, dy); scrollTouchY = t.clientY; }
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
            try { handleTerritoryClick(territory.id, territory); } catch (err) { console.error(err); }
          }
        }
      }
    }
    if (handled || scrollMoved || (tapData && tapData.moved)) {
      container._suppressClick = true;
      setTimeout(() => { container._suppressClick = false; }, 250);
    }
    tapData = null; scrollTouchY = null; scrollMoved = false;
  };

  const onTouchCancel = () => { tapData = null; scrollTouchY = null; scrollMoved = false; };
  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchCancel, { passive: true });

  const enterFullscreen = async () => {
    savedEdit = editMode; savedPan = panEnabled; editMode = false; panEnabled = true; isFullscreen = true; fullscreenEditPanel = false;
    render(); applyInteraction(); container.classList.add('is-fullscreen');
    try {
      if (container.requestFullscreen) await container.requestFullscreen();
      else if (container.webkitRequestFullscreen) await container.webkitRequestFullscreen();
      else if (container.msRequestFullscreen) await container.msRequestFullscreen();
      else { container.classList.add('fullscreen-fallback'); document.body.classList.add('no-scroll'); }
    } catch (e) {}
    setTimeout(() => { pz.resize(); pz.fit(); pz.center(); }, 200);
  };

  const exitFullscreen = async () => {
    isFullscreen = false; fullscreenEditPanel = false; container.classList.remove('is-fullscreen', 'fullscreen-fallback'); document.body.classList.remove('no-scroll');
    editMode = savedEdit; panEnabled = savedPan; render(); applyInteraction();
    if (onFullscreenEditToggle) onFullscreenEditToggle(false);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.webkitFullscreenElement) await document.webkitExitFullscreen();
    } catch (e) {}
    setTimeout(() => { pz.resize(); pz.fit(); pz.center(); }, 200);
  };

  const onFsChange = () => {
    const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!active && isFullscreen) exitFullscreen();
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
    else if (action === 'toggleEdit') { if (isFullscreen) return; editMode = !editMode; render(); }
    else if (action === 'toggleFullscreenEdit') {
      if (!isFullscreen) return;
      fullscreenEditPanel = !fullscreenEditPanel;
      editMode = fullscreenEditPanel;
      render();
      if (onFullscreenEditToggle) onFullscreenEditToggle(fullscreenEditPanel);
    }
    else if (action === 'togglePan') { if (isFullscreen) return; panEnabled = !panEnabled; render(); applyInteraction(); }
    else if (action === 'fullscreen') { if (isFullscreen) await exitFullscreen(); else await enterFullscreen(); }
  });
  container._getEditMode = () => editMode;
}

export async function initMap({ containerId, interactive = false, clickHandler = null, onFullscreenEditToggle = null }) {
  const container = document.getElementById(containerId);
  try {
    const res = await fetch('assets/map.svg');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    originalSvgText = await res.text();
    container.innerHTML = originalSvgText;
  } catch (e) {
    container.innerHTML = `<div class="p-6 text-center text-red-500"><p class="font-bold">Ошибка карты: ${e.message}</p></div>`;
    return null;
  }
  svgRoot = container.querySelector('svg');
  if (!svgRoot) return null;
  originalSvgViewBox = safeParseViewBox(svgRoot.getAttribute('viewBox')) || [...FALLBACK_VIEWBOX];
  svgRoot.removeAttribute('width'); svgRoot.removeAttribute('height');
  addTradeLegend(container);

  const handleTerritoryClick = (id, el) => {
    if (container._suppressClick) return;
    if (!interactive) return;
    if (container.classList.contains('is-fullscreen') && !container._getEditMode()) return;
    if (!container._getEditMode()) return;
    if (clickHandler) clickHandler(id, el); else toggleSelection(el);
  };
  onTerritoryClick = clickHandler;

  if (typeof svgPanZoom === 'function') {
    try {
      panZoom = svgPanZoom(svgRoot, { 
        zoomEnabled: true, 
        controlIconsEnabled: false, 
        fit: true, 
        center: true, 
        minZoom: 0.4, 
        maxZoom: 12, 
        zoomScaleSensitivity: 0.4, 
        preventClickEventEnabled: false,
        touchZoomEnabled: true 
      });
      
      panZoom.enableZoom();
      if (typeof panZoom.enableTouchZoom === 'function') panZoom.enableTouchZoom();

      svgRoot.addEventListener('touchstart', (e) => {
        if (e.touches.length > 1 && e.cancelable) e.preventDefault();
      }, { passive: false });
      svgRoot.addEventListener('touchmove', (e) => {
        if (e.touches.length > 1 && e.cancelable) e.preventDefault();
      }, { passive: false });

      const doFit = () => { try { panZoom.resize(); panZoom.fit(); panZoom.center(); } catch (e) {} };
      doFit(); requestAnimationFrame(doFit); setTimeout(doFit, 150); setTimeout(doFit, 500);
      try {
        let lastW = 0, lastH = 0;
        new ResizeObserver(() => {
          const w = container.clientWidth, h = container.clientHeight;
          if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) { lastW = w; lastH = h; doFit(); }
        }).observe(container);
      } catch (e) {}
      addMapControls(container, panZoom, interactive, handleTerritoryClick, onFullscreenEditToggle);
    } catch (e) {}
  }

  await loadAllData();
  svgRoot.querySelectorAll('.territory').forEach(t => {
    t.addEventListener('click', (e) => { e.stopPropagation(); handleTerritoryClick(t.id, t); });
  });

  new MutationObserver(() => { buildLabelsLayer(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  applyAll();
  return { panZoom, svgRoot };
}

export function setupLabelsToggle(buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  let visible = localStorage.getItem(LABELS_STATE_KEY) !== 'false';
  const updateBtn = () => {
    if (visible) { btn.innerHTML = '<i class="fas fa-eye mr-1"></i>Подписи вкл'; btn.classList.add('bg-green-600', 'text-white'); btn.classList.remove('bg-gray-200', 'dark:bg-gray-700'); }
    else { btn.innerHTML = '<i class="fas fa-eye-slash mr-1"></i>Подписи выкл'; btn.classList.remove('bg-green-600', 'text-white'); btn.classList.add('bg-gray-200', 'dark:bg-gray-700'); }
    toggleLabels(visible);
  };
  updateBtn();
  btn.addEventListener('click', () => { 
    visible = !visible; localStorage.setItem(LABELS_STATE_KEY, String(visible)); 
    updateBtn(); 
    if (typeof window.updateFsVisualToggles === 'function') window.updateFsVisualToggles();
  });
}

export function setupUnassignedIconsToggle(buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  let visible = localStorage.getItem(UNASSIGNED_ICONS_KEY) === 'true';
  showUnassignedIcons = visible;
  const updateBtn = () => {
    if (visible) { btn.innerHTML = '<i class="fas fa-layer-group mr-1"></i>Иконки вкл'; btn.classList.add('bg-indigo-600', 'text-white'); btn.classList.remove('bg-gray-200', 'dark:bg-gray-700'); }
    else { btn.innerHTML = '<i class="fas fa-layer-group mr-1"></i>Иконки выкл'; btn.classList.remove('bg-indigo-600', 'text-white'); btn.classList.add('bg-gray-200', 'dark:bg-gray-700'); }
    buildLabelsLayer();
  };
  updateBtn();
  btn.addEventListener('click', () => { visible = !visible; showUnassignedIcons = visible; 
    localStorage.setItem(UNASSIGNED_ICONS_KEY, String(visible)); 
    updateBtn(); 
    if (typeof window.updateFsVisualToggles === 'function') window.updateFsVisualToggles();
  });
}

export function setHideUnassignedLabels(v) { hideUnassignedLabels = !!v; buildLabelsLayer(); }

function toggleSelection(el) {
  if (el.classList.contains('selected')) { el.classList.remove('selected'); selectedTerritories.delete(el.id); }
  else { el.classList.add('selected'); selectedTerritories.add(el.id); }
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
  let count = 0;
  getAllTerritoryIds().forEach(id => { if (!filterFn || filterFn(id)) { selectTerritory(id, true); count++; } });
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

export function applyAll() { applyTerritoryColors(); buildLabelsLayer(); }

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
  if (assignments) territoryAssignments = assignments;
  if (alliances) allianceMap = alliances;
  buildLabelsLayer();
}

export function applyLabelSettings(settings = null) {
  if (settings) labelSettings = settings;
  buildLabelsLayer();
}

export function toggleLabels(show) {
  if (!svgRoot) return;
  const layer = svgRoot.getElementById('labels');
  if (layer) layer.style.display = show ? 'block' : 'none';
}

export function getLabelSettings() { return { ...labelSettings }; }
export function setLabelSettings(s) { labelSettings = s; buildLabelsLayer(); }
export function setPreviewData(alliances, assignments) {
  allianceMap = alliances; territoryAssignments = assignments;
  applyTerritoryColors(assignments, alliances); buildLabelsLayer();
}

export async function saveLabelSettings(newSettings, replace = false) {
  const promises = [];
  for (const [id, cfg] of Object.entries(newSettings)) {
    if (replace) promises.push(setDoc(doc(db, 'label_settings', id), cfg));
    else promises.push(setDoc(doc(db, 'label_settings', id), cfg, { merge: true }));
  }
  await Promise.all(promises);
  labelSettings = { ...labelSettings, ...newSettings };
  buildLabelsLayer();
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

export async function exportMapPNG(withLabels, theme = 'light') {
  try {
    if (!originalSvgText) { alert('Карта ещё не загружена.'); return; }
    const isDark = theme === 'dark';
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
    svg.removeAttribute('style'); svg.removeAttribute('width'); svg.removeAttribute('height');

    const labelsLayer = svg.getElementById('labels');
    if (labelsLayer && !withLabels) labelsLayer.remove();

    svg.querySelectorAll('.territory').forEach(t => {
      const allianceId = territoryAssignments[t.id];
      const alliance = allianceId ? allianceMap[allianceId] : null;
      t.removeAttribute('class'); t.removeAttribute('style');
      t.style.fill = alliance ? alliance.color : emptyFill;
      const isTrade = String(t.id).startsWith('T-');
      t.style.stroke = isTrade ? tradeStroke : territoryStroke;
      t.style.strokeWidth = isTrade ? TRADE_STROKE_WIDTH + 'px' : '1px';
      if (t.id === 'A') t.style.fill = arcadiaFill;
    });

    if (withLabels && labelsLayer) {
      labelsLayer.querySelectorAll('.label-group, .label').forEach(el => el.remove());
      const NS = 'http://www.w3.org/2000/svg';
      getAllTerritoryIds().forEach(id => {
        const allianceId = territoryAssignments[id];
        const info = getTerritoryLevelLabel(id);
        if (!info) return;
        
        const alliance = allianceId ? allianceMap[allianceId] : null;
        
        if (!alliance && !showHiddenLabels) return;

        const cfg = labelSettings[id] || {};
        const dx = cfg.dx || 0, dy = cfg.dy || 0, rot = cfg.rotation || 0, scale = cfg.scale || 1;
        const srcLabel = svgRoot.querySelector(`#labels .label[data-id="${id}"]`);
        if (!srcLabel) return;
        const ox = parseFloat(srcLabel.getAttribute('x')) || 0;
        const oy = parseFloat(srcLabel.getAttribute('y')) || 0;
        
        let tag = '';
        let showTag = false;
        let isOverflowing = false;
        let isTemplate = false;

        if (alliance) {
          tag = alliance.tag;
          const fits = doesTextFit(id, tag, ox, oy, cfg);
          showTag = fits || showHiddenLabels;
          isOverflowing = !fits && showHiddenLabels;
        } else if (showHiddenLabels) {
          tag = 'XXX';
          showTag = true;
          isTemplate = true;
        }

        const tagWidth = measureTextWidth(tag);
        const finalWidth = showTag ? (ICON_SIZE + ICON_GAP + tagWidth) : ICON_SIZE;
        const startX = -finalWidth / 2;

        const group = document.createElementNS(NS, 'g');
        group.setAttribute('transform', `translate(${ox + dx} ${oy + dy}) rotate(${rot}) scale(${scale})`);

        const iconG = document.createElementNS(NS, 'g');
        iconG.setAttribute('transform', `translate(${startX} -${ICON_HALF})`);

        let fill, stroke, points;
        if (info.kind === 'bastion') { fill = '#7c3aed'; stroke = '#1e1b4b'; points = `${ICON_HALF},0 ${ICON_SIZE},0 ${ICON_SIZE},${ICON_HALF + 3} ${ICON_HALF},${ICON_SIZE} 0,${ICON_HALF + 3} 0,0`; }
        else if (info.kind === 'trade') { fill = '#f59e0b'; stroke = '#7c2d12'; points = `${ICON_HALF},0 ${ICON_SIZE},${ICON_HALF} ${ICON_HALF},${ICON_SIZE} 0,${ICON_HALF}`; }
        else { fill = '#3b82f6'; stroke = '#1e3a8a'; points = `0,${ICON_HALF - 1} ${ICON_HALF},0 ${ICON_SIZE},${ICON_HALF - 1} ${ICON_SIZE},${ICON_SIZE} 0,${ICON_SIZE}`; }
        
        const shape = document.createElementNS(NS, 'polygon');
        shape.setAttribute('points', points); shape.setAttribute('fill', fill); shape.setAttribute('stroke', stroke); shape.setAttribute('stroke-width', '0.6'); shape.setAttribute('stroke-linejoin', 'round');
        iconG.appendChild(shape);

        const num = document.createElementNS(NS, 'text');
        num.setAttribute('x', String(ICON_HALF)); num.setAttribute('y', String(ICON_HALF + 0.5)); num.setAttribute('text-anchor', 'middle'); num.setAttribute('dominant-baseline', 'central'); num.setAttribute('font-family', 'Arial, sans-serif'); num.setAttribute('font-size', '6.5'); num.setAttribute('font-weight', 'bold'); num.setAttribute('fill', getIconTextColor(info.kind)); num.textContent = String(info.level);
        iconG.appendChild(num); group.appendChild(iconG);

        if (showTag) {
          const txt = document.createElementNS(NS, 'text');
          txt.setAttribute('x', String(startX + ICON_SIZE + ICON_GAP)); txt.setAttribute('y', '0'); txt.setAttribute('text-anchor', 'start'); txt.setAttribute('dominant-baseline', 'central'); txt.setAttribute('font-family', 'Arial, sans-serif'); txt.setAttribute('font-size', '9'); txt.setAttribute('font-weight', 'bold'); txt.setAttribute('fill', cfg.fill || labelFill); 
          
          if (isTemplate) {
            txt.setAttribute('stroke', '#3b82f6');
            txt.setAttribute('stroke-width', '1.5');
            txt.setAttribute('stroke-dasharray', '2, 2');
          } else if (isOverflowing) {
            txt.setAttribute('stroke', '#ef4444');
            txt.setAttribute('stroke-width', '2');
          } else {
            txt.setAttribute('stroke', labelStroke);
            txt.setAttribute('stroke-width', '1');
          }
          
          txt.setAttribute('stroke-linejoin', 'round'); txt.setAttribute('paint-order', 'stroke');
          txt.textContent = tag; group.appendChild(txt);
        }
        labelsLayer.appendChild(group);
      });
    }

    const vb = originalSvgViewBox || [...FALLBACK_VIEWBOX];
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('viewBox', vb.join(' ')); svg.setAttribute('width', String(vb[2])); svg.setAttribute('height', String(vb[3]));
    const svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const width = 2000;
    const mapHeight = Math.round(width * vb[3] / vb[2]);

    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

    const legend = buildLegend();
    const cols = Math.min(3, Math.max(1, Math.ceil(legend.length / 4)));
    const rows = legend.length ? Math.ceil(legend.length / cols) : 0;
    const L_FONT = 22, L_LINE = 36, L_PAD = 24, L_SWATCH = 20;
    const legendHeight = legend.length ? L_PAD * 2 + rows * L_LINE : 0;

    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = mapHeight + legendHeight;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = canvasBg; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, width, mapHeight);
    URL.revokeObjectURL(url);

    if (legend.length) {
      ctx.strokeStyle = legendLine; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, mapHeight); ctx.lineTo(width, mapHeight); ctx.stroke();
      const colWidth = width / cols;
      const totalTerr = (item) => item.bastions + item.general + item.trade;
      legend.forEach((item, i) => {
        const col = Math.floor(i / rows), row = i % rows;
        const x = L_PAD + col * colWidth, y = mapHeight + L_PAD + row * L_LINE + L_LINE / 2;
        ctx.fillStyle = item.color; ctx.fillRect(x, y - L_SWATCH / 2, L_SWATCH, L_SWATCH);
        ctx.strokeStyle = legendBorder; ctx.lineWidth = 1; ctx.strokeRect(x, y - L_SWATCH / 2, L_SWATCH, L_SWATCH);
        ctx.fillStyle = legendText; ctx.font = `bold ${L_FONT}px Arial, sans-serif`; ctx.textBaseline = 'middle';
        ctx.fillText(`${item.rank}. ${item.tag} — ${totalTerr(item)}  |  Б:${item.bastions} Г:${item.general} Т:${item.trade}`, x + L_SWATCH + 10, y);
      });
    }

    const link = document.createElement('a');
    link.download = `map-217-${theme}-${withLabels ? 'labels' : 'plain'}-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (err) {
    console.error(err);
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

// ⭐ Функции для управления состоянием извне
export function isLabelsVisible() {
  return localStorage.getItem(LABELS_STATE_KEY) !== 'false';
}

export function isUnassignedIconsVisible() {
  return localStorage.getItem(UNASSIGNED_ICONS_KEY) === 'true';
}

export function toggleLabelsExternal() {
  const btn = document.getElementById('btn-toggle-labels');
  if (btn) btn.click();
}

export function toggleIconsExternal() {
  const btn = document.getElementById('btn-toggle-icons');
  if (btn) btn.click();
}

// ⭐ Функции для Скрытого текста (Админка)
export function isHiddenLabelsVisible() {
  return showHiddenLabels;
}

export function toggleHiddenLabelsExternal() {
  showHiddenLabels = !showHiddenLabels;
  buildLabelsLayer();
}