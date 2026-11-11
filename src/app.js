/* FiberDraft — app shell: map, drawing, data loading, rules, results, exports. */
(function () {
'use strict';
/* global L, Engine, KML, ICONS, DEMO */

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const esc = KML.esc;
const icon = (n, cls) => `<svg class="i ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 16)));
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ================================================================ state */
const KEY = 'fiberdraft.v1';
const GKEY = 'fiberdraft.gkey';
const LIVE = new Set(['fiberSpare', 'cableSlack', 'dropSlack', 'cableSizes', 'txPower', 'rxSens', 'safety', 'att', 'spliceLoss',
  'connLoss', 'connectors', 'feederKm', 'feederSplices', 'maxReachKm', 'method', 'aerialShare', 'poleSpan', 'includeOnt', 'pfpSplit', 'cascadeFibers']);
const COL = { ink: '#0a0a0a', blue1: '#8ec5ff', blue2: '#2b7fff', blue3: '#155dfc', blue4: '#1447e6', blue5: '#193cb8', red: '#e7000b', amber: '#f59e0b', gray: '#a1a1a1' };
const STATUS_COL = { pass: COL.blue2, warn: COL.amber, fail: COL.red, unserved: COL.gray };
const cableColor = (s) => s <= 12 ? COL.blue1 : s <= 24 ? COL.blue2 : s <= 72 ? COL.blue3 : s <= 144 ? COL.blue4 : COL.blue5;
const cableWeight = (s) => s <= 12 ? 3 : s <= 24 ? 3.5 : s <= 72 ? 4.5 : s <= 144 ? 5.5 : 6.5;

const state = {
  boundary: null, areaName: '',
  osm: null, homes: [], removed: [], unitOverrides: {},
  routes: [], refs: [],
  pfpMode: 'auto', pfps: [],
  params: Engine.normalizeParams({}), rates: Engine.normalizeRates(null),
  bopts: { includeNonRes: true, mduUnits: true, minArea: 25 },
  est: { spacing: 20, setback: 15 },
  design: null, ctx: null, stale: false, alts: null,
  mode: 'idle', tab: 'plan', basemap: 'hybrid', legendOpen: true,
  layers: { area: true, roads: true, refs: true, drops: true, cables: true, homes: true, closures: true, terminals: true, pfps: true, labels: true },
};

/* ================================================================ formatting */
const nfIN = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const nfUS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmt = {
  int: (v) => nfIN.format(Math.round(v || 0)),
  num: (v) => (Math.abs(v) >= 100 ? nfIN.format(v) : String(Math.round(v * 100) / 100)),
  dist: (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2) + ' km' : Math.round(m || 0) + ' m'),
  dbm: (v) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(1),
  db: (v) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(1),
  money(v, compact) {
    const c = state.rates.currency || '';
    if (v == null || !isFinite(v)) return '–';
    const inr = c === '₹' || c === 'Rs' || c === 'INR';
    if (compact) {
      if (inr) {
        if (Math.abs(v) >= 1e7) return c + (v / 1e7).toFixed(2) + ' Cr';
        if (Math.abs(v) >= 1e5) return c + (v / 1e5).toFixed(2) + ' L';
      } else {
        if (Math.abs(v) >= 1e6) return c + (v / 1e6).toFixed(2) + 'M';
        if (Math.abs(v) >= 1e4) return c + (v / 1e3).toFixed(1) + 'k';
      }
    }
    return c + (inr ? nfIN : nfUS).format(Math.round(v));
  },
};

/* ================================================================ small UI helpers */
function toast(msg, kind, ms) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.innerHTML = `${icon(kind === 'err' ? 'circle-x' : kind === 'info' ? 'info' : 'circle-check')}<div class="t">${esc(msg)}</div><button class="icon-btn" style="width:22px;height:22px" aria-label="Dismiss">${icon('x', 'i-sm')}</button>`;
  el.querySelector('button').onclick = () => el.remove();
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), ms || (kind === 'err' ? 7000 : 4200));
}

function setBusy(text) {
  const b = $('#busy');
  if (!text) { b.hidden = true; return; }
  $('#busyText').textContent = text;
  b.hidden = false;
}

function openModal(html, onOpen) {
  const d = $('#modal');
  d.innerHTML = html;
  if (!d.open) d.showModal();
  if (onOpen) onOpen(d);
}
function closeModal() { const d = $('#modal'); if (d.open) d.close(); }

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

const slug = (s) => String(s || 'fiberdraft').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'fiberdraft';
const projectTitle = () => state.areaName || 'FTTH service area';

/* ================================================================ persistence */
function snapshot(withOsm) {
  return {
    v: 1, boundary: state.boundary, areaName: state.areaName,
    homes: state.homes.filter(h => h.kind !== 'osm'), removed: state.removed, unitOverrides: state.unitOverrides,
    routes: state.routes, refs: state.refs, pfpMode: state.pfpMode, pfps: state.pfps,
    params: state.params, rates: state.rates, bopts: state.bopts, est: state.est,
    osm: withOsm ? state.osm : null, hadDesign: !!state.design,
    view: map ? { c: map.getCenter(), z: map.getZoom() } : null, basemap: state.basemap, layers: state.layers, legendOpen: state.legendOpen,
  };
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(snapshot(true))); }
    catch (e) { try { localStorage.setItem(KEY, JSON.stringify(snapshot(false))); } catch (e2) { /* storage unavailable */ } }
  }, 500);
}
function applySnapshot(s) {
  state.boundary = Array.isArray(s.boundary) && s.boundary.length >= 3 ? s.boundary : null;
  state.areaName = s.areaName || '';
  state.osm = s.osm && Array.isArray(s.osm.roads) ? s.osm : null;
  state.homes = Array.isArray(s.homes) ? s.homes.filter(h => h && isFinite(h.lat) && isFinite(h.lng)) : [];
  state.removed = Array.isArray(s.removed) ? s.removed : [];
  state.unitOverrides = s.unitOverrides || {};
  state.routes = Array.isArray(s.routes) ? s.routes : [];
  state.refs = Array.isArray(s.refs) ? s.refs : [];
  state.pfpMode = s.pfpMode === 'manual' ? 'manual' : 'auto';
  state.pfps = Array.isArray(s.pfps) ? s.pfps : [];
  state.params = Engine.normalizeParams(s.params || {});
  state.rates = Engine.normalizeRates(s.rates || null);
  if (s.bopts) Object.assign(state.bopts, s.bopts);
  if (s.est) Object.assign(state.est, s.est);
  if (s.layers) Object.assign(state.layers, s.layers);
  if (s.basemap) state.basemap = s.basemap;
  if (typeof s.legendOpen === 'boolean') state.legendOpen = s.legendOpen;
  state.design = null; state.ctx = null; state.stale = false; state.alts = null;
  rebuildOsmHomes();
}

/* ================================================================ homes */
function rebuildOsmHomes() {
  const keep = state.homes.filter(h => h.kind !== 'osm');
  if (!state.osm) { state.homes = keep; return; }
  const removed = new Set(state.removed);
  const osmHomes = Engine.buildingsToHomes(state.osm.buildings || [], state.boundary, state.bopts)
    .filter(h => !removed.has(h.id))
    .map(h => (state.unitOverrides[h.id] ? Object.assign(h, { units: state.unitOverrides[h.id] }) : h));
  state.homes = osmHomes.concat(keep);
}
const homeCounts = () => {
  const c = { osm: 0, est: 0, manual: 0, kml: 0, units: 0 };
  for (const h of state.homes) { c[h.kind] = (c[h.kind] || 0) + 1; c.units += h.units || 1; }
  return c;
};
function markStructural() {
  if (state.design) state.stale = true;
  state.alts = null;
}

/* ================================================================ map */
let map = null;
const LG = {};
const RN = {};
const marks = { homes: new Map(), terms: new Map(), pfps: new Map(), closures: new Map() };
let baseLayer = null;
let google = null;

function isDarkBase() { return state.basemap !== 'streets' && state.basemap !== 'osm'; }

function initMap() {
  map = L.map('map', { zoomControl: false, preferCanvas: true, doubleClickZoom: false, worldCopyJump: true, maxZoom: 21, minZoom: 2, zoomSnap: 0.5 });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 110 }).addTo(map);
  for (const [n, z] of [['pArea', 405], ['pRoads', 410], ['pRefs', 412], ['pDrops', 420], ['pCables', 430], ['pHomes', 440], ['pDraw', 590]]) {
    const pane = map.createPane(n);
    pane.style.zIndex = z;
    if (n === 'pDraw' || n === 'pArea' || n === 'pDrops') pane.style.pointerEvents = 'none';
    RN[n] = L.canvas({ pane: n, padding: 0.4, tolerance: 5 });
  }
  for (const k of ['area', 'roads', 'refs', 'drops', 'cables', 'homes', 'closures', 'terminals', 'pfps', 'draw', 'vertices']) LG[k] = L.layerGroup();
  for (const k of Object.keys(LG)) if (state.layers[k] !== false) LG[k].addTo(map);
  setBasemap(state.basemap, true);
  map.on('click', (e) => handleMapClick(e.latlng));
  map.on('dblclick', () => { if (state.mode === 'draw-poly') finishPoly(); });
  map.on('mousemove', (e) => {
    $('#coords').textContent = e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6);
    if (state.mode === 'draw-poly' && draw.pts.length) drawGuide(e.latlng);
    else if (state.mode === 'draw-rect' && draw.start) drawRectGuide(e.latlng);
  });
  map.on('zoomend', () => { updateLabels(); restyleHomes(); });
  map.on('moveend', () => { save(); if (state.basemap === 'google') updateGoogleAttribution(); });
}

function makeBase(kind) {
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const esri = (svc, opt) => L.tileLayer(ESRI + svc + '/MapServer/tile/{z}/{y}/{x}', Object.assign({ maxZoom: 21, maxNativeZoom: 19 }, opt));
  const imagery = () => esri('World_Imagery', { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
  if (kind === 'satellite') return imagery();
  if (kind === 'hybrid') return L.layerGroup([imagery(), esri('Reference/World_Transportation', { maxNativeZoom: 18 }), esri('Reference/World_Boundaries_and_Places', { maxNativeZoom: 18, attribution: 'Labels © Esri' })]);
  if (kind === 'streets') return L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 21, maxNativeZoom: 20, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors © CARTO' });
  if (kind === 'google' && google) return google.layer;
  return null;
}

function setBasemap(kind, quiet) {
  if (kind === 'google' && !google) { openGoogleDialog(); return; }
  const layer = makeBase(kind);
  if (!layer) return;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = layer.addTo(map);
  if (baseLayer.bringToBack) baseLayer.bringToBack();
  state.basemap = kind;
  renderBaseSeg();
  if (!quiet) { renderRoads(); renderDesign(); save(); }
}

async function enableGoogle(key) {
  const r = await fetch('https://tile.googleapis.com/v1/createSession?key=' + encodeURIComponent(key), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'satellite', language: 'en-US', region: 'IN', layerTypes: ['layerRoadmap'] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.session) throw new Error((j.error && j.error.message) || ('Google answered ' + r.status));
  const url = `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(j.session)}&key=${encodeURIComponent(key)}`;
  google = { key, session: j.session, layer: L.tileLayer(url, { maxZoom: 22, maxNativeZoom: 21, attribution: 'Google' }), attribution: 'Google' };
}

async function updateGoogleAttribution() {
  if (!google) return;
  try {
    const b = map.getBounds();
    const u = `https://tile.googleapis.com/tile/v1/viewport?session=${encodeURIComponent(google.session)}&key=${encodeURIComponent(google.key)}&zoom=${Math.round(map.getZoom())}&north=${b.getNorth()}&south=${b.getSouth()}&east=${b.getEast()}&west=${b.getWest()}`;
    const j = await (await fetch(u)).json();
    const text = 'Google' + (j.copyright ? ' · ' + j.copyright : '');
    map.attributionControl.removeAttribution(google.attribution);
    google.attribution = esc(text);
    map.attributionControl.addAttribution(google.attribution);
  } catch (e) { /* attribution refresh is best effort */ }
}

function openGoogleDialog() {
  let saved = '';
  try { saved = localStorage.getItem(GKEY) || ''; } catch (e) { /* ignore */ }
  openModal(`
    <div class="m-h"><div class="grow"><h2>Google satellite</h2><div class="sub">Shows Google imagery through the Map Tiles API with your own API key.</div></div><button class="icon-btn" data-act="close-modal" aria-label="Close">${icon('x')}</button></div>
    <div class="m-b">
      <div class="field"><label for="gk">Google Maps Platform API key</label><input class="input mono" id="gk" type="password" autocomplete="off" value="${esc(saved)}" placeholder="AIza…"><span class="hint">Enable the <b>Map Tiles API</b> and billing on the key. The key is kept only in this browser.</span></div>
      <div class="alert note">${icon('info')}<div class="a-t">No key? Hybrid and Satellite already use free Esri imagery, and every export opens in Google Earth.</div></div>
    </div>
    <div class="m-f"><button class="btn btn-outline" data-act="close-modal">Cancel</button><button class="btn" data-act="google-save">Use Google satellite</button></div>`,
  (d) => d.querySelector('#gk').focus());
}

/* ================================================================ rendering: map layers */
function renderArea() {
  LG.area.clearLayers();
  if (!state.boundary) return;
  const ring = state.boundary.map(p => [p[0], p[1]]);
  L.polygon(ring, { renderer: RN.pArea, color: COL.ink, weight: 5, opacity: 0.35, fill: false, interactive: false }).addTo(LG.area);
  L.polygon(ring, { renderer: RN.pArea, color: '#ffffff', weight: 2.5, dashArray: '8 6', fillColor: COL.ink, fillOpacity: 0.05, interactive: false }).addTo(LG.area);
}

function renderRoads() {
  LG.roads.clearLayers(); LG.refs.clearLayers();
  const dark = isDarkBase();
  if (state.osm && state.osm.roads.length) {
    L.polyline(state.osm.roads.map(r => r.coords), { renderer: RN.pRoads, color: dark ? '#ffffff' : '#525252', weight: 1.5, opacity: dark ? 0.42 : 0.3, interactive: false }).addTo(LG.roads);
  }
  if (state.routes.length) {
    L.polyline(state.routes.map(r => r.coords), { renderer: RN.pRoads, color: dark ? '#fafafa' : '#262626', weight: 2.5, opacity: 0.9, dashArray: '7 5', interactive: false }).addTo(LG.roads);
  }
  for (const f of state.refs) {
    const st = { renderer: RN.pRefs, color: dark ? '#e5e5e5' : '#525252', weight: 1.5, fillColor: dark ? '#525252' : '#d4d4d4', fillOpacity: 0.9 };
    let lyr;
    if (f.type === 'Point') lyr = L.circleMarker(f.coords, Object.assign({ radius: 3.5 }, st));
    else if (f.type === 'LineString') lyr = L.polyline(f.coords, Object.assign({}, st, { dashArray: '2 4' }));
    else lyr = L.polygon(f.coords, Object.assign({}, st, { fillOpacity: 0.15 }));
    if (f.name) lyr.bindTooltip(esc(f.name), { direction: 'top' });
    lyr.addTo(LG.refs);
  }
}

function homeRadius(h) {
  const z = map.getZoom();
  const r = z >= 18 ? 5.5 : z >= 17 ? 4.5 : z >= 16 ? 3.6 : 2.8;
  return (h.units || 1) > 1 ? r + 1.6 : r;
}

function homeStyle(h) {
  const dh = state.design ? state.design.homes[h.id] : null;
  const est = h.kind === 'est';
  const radius = homeRadius(h);
  if (!dh) return { radius, color: COL.ink, weight: 1.5, fillColor: '#ffffff', fillOpacity: est ? 0.45 : 1, dashArray: est ? '2 2' : null };
  return { radius, color: '#ffffff', weight: 1.5, fillColor: STATUS_COL[dh.status] || COL.gray, fillOpacity: est ? 0.65 : 1, dashArray: null };
}

function renderHomes() {
  LG.homes.clearLayers();
  marks.homes.clear();
  for (const h of state.homes) {
    const m = L.circleMarker([h.lat, h.lng], Object.assign({ renderer: RN.pHomes, bubblingMouseEvents: false }, homeStyle(h)));
    m.on('click', (e) => onHomeClick(h.id, e));
    m.addTo(LG.homes);
    marks.homes.set(h.id, m);
  }
}

function restyleHomes() {
  if (!map) return;
  const byId = new Map(state.homes.map(h => [h.id, h]));
  for (const [id, m] of marks.homes) { const h = byId.get(id); if (h) m.setStyle(homeStyle(h)).setRadius(homeRadius(h)); }
}

function divIcon(kind, label, extra, up) {
  if (kind === 'term') return L.divIcon({ className: 'mk', html: `<div class="mk-term ${extra || ''}"><span class="d"></span><span class="mk-lbl${up ? ' up' : ''}">${esc(label)}</span></div>`, iconSize: [14, 14], iconAnchor: [7, 7], popupAnchor: [0, -8] });
  if (kind === 'sc') return L.divIcon({ className: 'mk', html: `<div class="mk-sc"><span class="d"></span><span class="mk-lbl">${esc(label)}</span></div>`, iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -8] });
  return L.divIcon({ className: 'mk', html: `<div class="mk-pfp ${extra || ''}"><span class="d">P</span><span class="mk-lbl">${esc(label)}</span></div>`, iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -13] });
}

function popupAt(latlng, html) {
  L.popup({ maxWidth: 320, autoPanPadding: [40, 40] }).setLatLng(latlng).setContent(html).openOn(map);
}

function renderDesign() {
  for (const k of ['drops', 'cables', 'closures', 'terminals', 'pfps']) LG[k].clearLayers();
  marks.terms.clear(); marks.pfps.clear(); marks.closures.clear();
  const D = state.design;
  const idle = state.mode === 'idle';
  if (D) {
    const dark = isDarkBase();
    if (D.drops.length) L.polyline(D.drops.map(d => d.coords), { renderer: RN.pDrops, color: dark ? '#ffffff' : '#404040', weight: 1.2, opacity: dark ? 0.8 : 0.6, dashArray: '3 3', interactive: false }).addTo(LG.drops);
    const runs = D.runs.slice().sort((a, b) => a.size - b.size);
    for (const r of runs) L.polyline(r.coords, { renderer: RN.pCables, color: '#ffffff', weight: cableWeight(r.size) + 3, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(LG.cables);
    for (const r of runs) {
      const line = L.polyline(r.coords, { renderer: RN.pCables, color: cableColor(r.size), weight: cableWeight(r.size), lineCap: 'round', lineJoin: 'round' });
      line.on('click', (e) => { if (state.mode === 'idle') popupAt(e.latlng, cablePopup(r)); });
      line.addTo(LG.cables);
    }
    for (const c of D.closures) {
      const m = L.marker([c.lat, c.lng], { icon: divIcon('sc', c.id), keyboard: false, riseOnHover: true });
      m.on('click', (e) => featureClick(e, () => popupAt([c.lat, c.lng], closurePopup(c))));
      m.addTo(LG.closures); marks.closures.set(c.id, m);
    }
    for (const t of D.terminals) {
      const m = L.marker([t.lat, t.lng], { icon: divIcon('term', t.id, t.status !== 'pass' ? t.status : '', t.direct), draggable: idle, autoPan: true, riseOnHover: true, title: t.id });
      m.on('click', (e) => featureClick(e, () => popupAt([t.lat, t.lng], termPopup(t))));
      m.on('dragend', (e) => onTermDrag(t.id, e.target.getLatLng()));
      m.addTo(LG.terminals); marks.terms.set(t.id, m);
    }
    for (const p of D.pfps) {
      const m = L.marker([p.lat, p.lng], { icon: divIcon('pfp', p.id), draggable: idle, zIndexOffset: 1000, title: p.id });
      m.on('click', (e) => featureClick(e, () => popupAt([p.lat, p.lng], pfpPopup(p))));
      m.on('dragend', (e) => onPfpDrag(p.id, e.target.getLatLng()));
      m.addTo(LG.pfps); marks.pfps.set(p.id, m);
    }
  }
  if (state.pfpMode === 'manual' && (!D || state.stale)) {
    state.pfps.forEach((p, i) => {
      const m = L.marker([p.lat, p.lng], { icon: divIcon('pfp', 'PFP ' + (i + 1), 'pending'), draggable: idle, zIndexOffset: 1100, title: 'Placed PFP' });
      m.on('dragend', (e) => { const ll = e.target.getLatLng(); p.lat = ll.lat; p.lng = ll.lng; markStructural(); renderFoot(); renderResults(); save(); });
      m.on('click', (e) => featureClick(e, () => popupAt([p.lat, p.lng], `<div class="pop"><div class="pop-h"><b>PFP ${i + 1}</b><span class="badge">Placed</span></div><p class="muted" style="font-size:12.5px">Used on the next Generate. Drag to move.</p><div class="pop-links"><button class="link" data-act="remove-pfp" data-id="${esc(p.id)}">Remove</button></div></div>`)));
      m.addTo(LG.pfps);
    });
  }
  restyleHomes();
  updateLabels();
  renderLegend();
}

function featureClick(e, open) {
  if (state.mode !== 'idle') { handleMapClick(e.latlng); return; }
  open();
}

function updateLabels() {
  if (!map) return;
  map.getContainer().classList.toggle('show-labels', !!state.layers.labels && map.getZoom() >= 17);
}

/* ================================================================ popups */
const gmaps = (lat, lng) => `<div class="pop-links"><a href="https://www.google.com/maps/search/?api=1&query=${lat.toFixed(7)},${lng.toFixed(7)}" target="_blank" rel="noopener">Google Maps ${icon('external-link', 'i-sm')}</a><a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(7)},${lng.toFixed(7)}" target="_blank" rel="noopener">Street View ${icon('external-link', 'i-sm')}</a></div>`;
const statusBadge = (s) => s === 'fail' ? '<span class="badge badge-fail">Fail</span>' : s === 'warn' ? '<span class="badge badge-warn">Low margin</span>' : s === 'unserved' ? '<span class="badge">Not served</span>' : '<span class="badge badge-pass">Pass</span>';
const kv = (rows) => '<dl class="kv">' + rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('') + '</dl>';

function termPopup(t) {
  return `<div class="pop"><div class="pop-h"><b>${esc(t.id)}</b>${statusBadge(t.status)}</div>${kv([
    ['Ports used', `${t.used} of ${t.ports}`], ['Buildings', t.buildings], ['Fed by', esc(t.fibers || t.cable || 'PFP stub')],
    ['F2 from PFP', fmt.dist(t.f2m)], ['Closures on path', t.closuresOnPath], ['Longest drop', fmt.dist(t.maxDrop)],
    t.worstRx != null ? ['Worst Rx', `${fmt.dbm(t.worstRx)} dBm`] : null, t.worstMargin != null ? ['Margin', `${fmt.db(t.worstMargin)} dB`] : null,
  ])}<p class="hint" style="margin-top:6px">Drag the terminal to move it; cables and drops re-route.</p>${gmaps(t.lat, t.lng)}</div>`;
}
function closurePopup(c) {
  return `<div class="pop"><div class="pop-h"><b>${esc(c.id)}</b><span class="badge">Splice closure</span></div>${kv([
    ['Cable in', esc(c.inCable)], ['Cables out', esc(c.outCables.join(', '))], c.terminals.length ? ['Terminal here', esc(c.terminals.join(', '))] : null, ['Splices', c.splices],
  ])}${gmaps(c.lat, c.lng)}</div>`;
}
function pfpPopup(p) {
  const P = state.design.params;
  return `<div class="pop"><div class="pop-h"><b>${esc(p.id)}</b><span class="badge badge-solid">PFP</span>${p.over ? '<span class="badge badge-warn">Over limit</span>' : ''}</div>${kv([
    ['Homes', p.units], ['Terminals', p.terminals], ['Cabinet', `${p.cabinet}-port`], ['Splitters', `${p.splitters} × 1:${P.pfpSplit}`],
    ['F2 cables', esc(p.cables.join(', ') || '—')], isFinite(p.worstRx) ? ['Worst Rx', `${fmt.dbm(p.worstRx)} dBm`] : null,
  ])}<p class="hint" style="margin-top:6px">Drag to move the PFP; the layout updates and the spot is kept for the next Generate.</p>${gmaps(p.lat, p.lng)}</div>`;
}
function cablePopup(r) {
  return `<div class="pop"><div class="pop-h"><b>${esc(r.id)}</b><span class="badge">${r.count > 1 ? r.count + ' × ' : ''}${r.size}F</span></div>${kv([
    ['Fibres used', `${r.need} of ${r.size * r.count}`], ['Route length', fmt.dist(r.length)], ['Cable incl. slack', fmt.dist(r.cableLen)],
    ['From', esc(r.from)], ['To', esc(r.to || '—')], r.terminals.length ? ['Terminals tapped', esc(r.terminals.join(', '))] : null,
  ])}</div>`;
}
function homePopup(h) {
  const dh = state.design ? state.design.homes[h.id] : null;
  const src = { osm: 'OpenStreetMap building', est: 'Estimated', manual: 'Added by hand', kml: 'Imported KML' }[h.kind] || h.kind;
  const b = dh && dh.budget;
  return `<div class="pop"><div class="pop-h"><b>${esc(h.label || 'Home')}</b>${dh ? statusBadge(dh.status) : ''}</div>${kv([
    ['Source', esc(src)], h.btype ? ['Building', esc(h.btype)] : null,
    dh && dh.termId ? ['Terminal', esc(dh.termId)] : null, dh && dh.drop ? ['Drop', fmt.dist(dh.drop)] : null,
    b ? ['Path', `${b.km.toFixed(2)} km`] : null, b ? ['Loss', `${b.loss.toFixed(1)} dB`] : null,
    b ? ['Rx', `${fmt.dbm(b.rx)} dBm`] : null, b ? ['Margin', `${fmt.db(b.margin)} dB`] : null,
    dh && dh.reason ? ['Why', esc(dh.reason)] : null,
  ])}
  <div class="fields" style="margin-top:10px;grid-template-columns:1fr auto;align-items:end">
    <div class="field"><label for="hu">Units (flats)</label><input class="input input-sm" id="hu" type="number" min="1" max="96" value="${h.units || 1}"></div>
    <button class="btn btn-outline btn-sm" data-act="set-units" data-id="${esc(h.id)}">Save</button>
  </div>
  <div class="pop-links"><button class="link" data-act="remove-home" data-id="${esc(h.id)}">Remove home</button></div></div>`;
}

/* ================================================================ drawing & map modes */
const draw = { pts: [], start: null };

function setMode(mode) {
  LG.draw.clearLayers();
  if (state.mode === 'edit-area' && mode !== 'edit-area') LG.vertices.clearLayers();
  draw.pts = []; draw.start = null;
  state.mode = mode;
  if (map) {
    map.getContainer().classList.toggle('crosshair', mode !== 'idle' && mode !== 'edit-area');
    map.closePopup();
    const on = mode === 'idle';
    for (const m of marks.terms.values()) on ? m.dragging.enable() : m.dragging.disable();
    for (const m of marks.pfps.values()) on ? m.dragging.enable() : m.dragging.disable();
  }
  renderHint();
  renderPlan();
}

function renderHint() {
  const h = $('#hint');
  const m = state.mode;
  if (m === 'idle') { h.hidden = true; h.innerHTML = ''; return; }
  const n = draw.pts.length;
  const txt = {
    'draw-poly': n < 3 ? 'Click to add the corners of your service area' : 'Click the first point, double-click or press Enter to finish',
    'draw-rect': draw.start ? 'Click the opposite corner' : 'Click one corner of the rectangle',
    pfp: 'Click on or near a street to place a PFP',
    homes: 'Click to add a home · click a home to remove it',
    'edit-area': 'Drag the white handles to reshape the area',
  }[m];
  const done = m === 'pfp' || m === 'homes' || m === 'edit-area';
  h.innerHTML = `<div class="hint-pill"><span>${esc(txt)}</span>${m === 'draw-poly' && n ? '<button class="btn" data-act="undo-vertex">Undo</button>' : ''}${m === 'draw-poly' && n >= 3 ? '<button class="btn w" data-act="finish-draw">Finish</button>' : ''}<button class="btn ${done ? 'w' : ''}" data-act="cancel-mode">${done ? 'Done' : 'Cancel'}</button></div>`;
  h.hidden = false;
}

function handleMapClick(latlng) {
  const m = state.mode;
  if (m === 'draw-poly') {
    if (draw.pts.length >= 3) {
      const p0 = map.latLngToContainerPoint(draw.pts[0]), p = map.latLngToContainerPoint(latlng);
      if (p0.distanceTo(p) < 12) { finishPoly(); return; }
    }
    draw.pts.push(latlng);
    drawGuide();
    renderHint();
  } else if (m === 'draw-rect') {
    if (!draw.start) { draw.start = latlng; renderHint(); }
    else {
      const a = draw.start, b = latlng;
      if (Math.abs(a.lat - b.lat) < 1e-6 || Math.abs(a.lng - b.lng) < 1e-6) return;
      setBoundary([[a.lat, a.lng], [a.lat, b.lng], [b.lat, b.lng], [b.lat, a.lng]], true);
      setMode('idle');
    }
  } else if (m === 'pfp') {
    state.pfpMode = 'manual';
    state.pfps.push({ id: uid('p'), lat: latlng.lat, lng: latlng.lng });
    markStructural(); renderDesign(); renderPlan(); renderFoot(); renderResults(); save();
  } else if (m === 'homes') {
    state.homes.push({ id: uid('m'), lat: latlng.lat, lng: latlng.lng, units: 1, kind: 'manual', label: 'Added by hand' });
    markStructural(); renderHomes(); renderPlan(); renderFoot(); renderResults(); save();
  }
}

function drawGuide(cursor) {
  LG.draw.clearLayers();
  const pts = draw.pts.slice();
  if (cursor) pts.push(cursor);
  if (pts.length >= 2) {
    L.polyline(pts, { renderer: RN.pDraw, color: COL.ink, weight: 5, opacity: 0.3, interactive: false }).addTo(LG.draw);
    L.polyline(pts, { renderer: RN.pDraw, color: '#ffffff', weight: 2.5, dashArray: '6 5', interactive: false }).addTo(LG.draw);
  }
  draw.pts.forEach((p, i) => L.circleMarker(p, { renderer: RN.pDraw, radius: i === 0 ? 6 : 4, color: COL.ink, weight: 2, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(LG.draw));
}

function drawRectGuide(cursor) {
  LG.draw.clearLayers();
  const a = draw.start;
  L.rectangle([[a.lat, a.lng], [cursor.lat, cursor.lng]], { renderer: RN.pDraw, color: '#ffffff', weight: 2.5, dashArray: '6 5', fillColor: COL.ink, fillOpacity: 0.08, interactive: false }).addTo(LG.draw);
}

function finishPoly() {
  const pts = [];
  for (const p of draw.pts) {
    const last = pts[pts.length - 1];
    if (last && map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(p)) < 3) continue;
    pts.push(p);
  }
  if (pts.length < 3) { toast('An area needs at least three corners.', 'err'); return; }
  setBoundary(pts.map(p => [p.lat, p.lng]), true);
  setMode('idle');
}

function setBoundary(ring, fresh) {
  state.boundary = ring;
  if (fresh) {
    state.design = null; state.ctx = null; state.stale = false; state.alts = null;
    state.areaName = '';
    if (state.osm && state.osm.bbox) {
      const b = Engine.ringBBox(ring), o = state.osm.bbox;
      if (b.s < o.s || b.n > o.n || b.w < o.w || b.e > o.e) state.osm = null;
    }
  } else markStructural();
  rebuildOsmHomes();
  renderArea(); renderRoads(); renderHomes(); renderDesign(); renderPlan(); renderResults(); renderFoot(); save();
  if (fresh) {
    map.fitBounds(L.latLngBounds(ring), { padding: [60, 60], maxZoom: 18 });
    if (!state.osm) toast('Area set. Next, load streets and buildings for it.', 'info');
  }
}

function startEditArea() {
  if (!state.boundary) return;
  setMode('edit-area');
  LG.vertices.clearLayers();
  state.boundary.forEach((p, i) => {
    const mk = L.marker(p, { icon: L.divIcon({ className: 'mk', html: '<div class="mk-vtx"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }), draggable: true, zIndexOffset: 3000, keyboard: false });
    mk.on('drag', (ev) => { const ll = ev.target.getLatLng(); state.boundary[i] = [ll.lat, ll.lng]; renderArea(); });
    mk.on('dragend', () => {
      if (state.osm && state.osm.bbox) {
        const b = Engine.ringBBox(state.boundary), o = state.osm.bbox;
        if (b.s < o.s || b.n > o.n || b.w < o.w || b.e > o.e) toast('The area now reaches past the loaded streets. Reload streets and buildings to cover it.', 'info');
      }
      setBoundary(state.boundary, false);
    });
    mk.addTo(LG.vertices);
  });
  if (!map.hasLayer(LG.vertices)) LG.vertices.addTo(map);
}

function onHomeClick(id, e) {
  if (state.mode === 'homes') { removeHome(id); return; }
  if (state.mode !== 'idle') { handleMapClick(e.latlng); return; }
  const h = state.homes.find(x => x.id === id);
  if (h) popupAt([h.lat, h.lng], homePopup(h));
}

function removeHome(id) {
  const h = state.homes.find(x => x.id === id);
  if (!h) return;
  if (h.kind === 'osm') state.removed.push(id);
  state.homes = state.homes.filter(x => x.id !== id);
  map.closePopup();
  markStructural(); renderHomes(); renderPlan(); renderFoot(); renderResults(); save();
}

/* ================================================================ data loading */
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function fetchOSM() {
  if (!state.boundary) { toast('Draw or import a service area first.', 'err'); return; }
  const bb = Engine.bufferBBox(Engine.ringBBox(state.boundary), 150);
  const km2 = Engine.bboxAreaKm2(bb);
  if (km2 > 40) { toast(`This area spans about ${Math.round(km2)} km². Draw a smaller one (under 40 km²) and plan it in parts.`, 'err'); return; }
  const q = Engine.overpassQuery(bb);
  let lastErr = null;
  for (let i = 0; i < OVERPASS.length; i++) {
    const url = OVERPASS[i];
    setBusy(i === 0 ? 'Downloading streets and buildings from OpenStreetMap…' : `Server busy, trying mirror ${i + 1} of ${OVERPASS.length}…`);
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 70000);
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
      clearTimeout(tm);
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
      const json = await res.json();
      if (json && json.remark && /error|timed out|out of memory/i.test(json.remark) && !(json.elements || []).length) throw new Error(json.remark.slice(0, 80));
      const parsed = Engine.parseOverpass(json);
      state.osm = { roads: parsed.roads, buildings: parsed.buildings, bbox: bb, at: Date.now(), source: new URL(url).host };
      rebuildOsmHomes();
      markStructural();
      setBusy(null);
      renderRoads(); renderHomes(); renderPlan(); renderFoot(); renderResults(); save();
      const c = homeCounts();
      toast(`Loaded ${fmt.int(parsed.roads.length)} street segments and ${fmt.int(parsed.buildings.length)} buildings (${fmt.int(c.osm)} homes inside the area).`);
      if (c.osm < 5 && parsed.roads.length) toast('OpenStreetMap has few buildings here. Use "Estimate homes along streets" or add homes by hand.', 'info', 8000);
      nameArea();
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  setBusy(null);
  toast(`Couldn't reach OpenStreetMap (${lastErr ? (lastErr.name === 'AbortError' ? 'timed out' : lastErr.message) : 'unknown error'}). Try again in a minute, or import a KML with homes and routes.`, 'err', 10000);
}

async function nameArea() {
  if (state.areaName || !state.boundary) return;
  try {
    const b = Engine.ringBBox(state.boundary);
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=15&lat=${((b.s + b.n) / 2).toFixed(6)}&lon=${((b.w + b.e) / 2).toFixed(6)}`);
    const j = await r.json();
    const a = j.address || {};
    const parts = [a.neighbourhood || a.suburb || a.quarter || a.village || a.hamlet, a.city || a.town || a.county || a.state_district].filter(Boolean);
    if (parts.length && !state.areaName) { state.areaName = [...new Set(parts)].join(', '); renderPlan(); save(); }
  } catch (e) { /* naming is optional */ }
}

function estimate() {
  if (!state.boundary) { toast('Draw or import a service area first.', 'err'); return; }
  let roads = state.osm ? state.osm.roads : [];
  if (!roads.length && state.routes.length) roads = state.routes.map(r => ({ coords: r.coords, cls: 'residential', name: r.name || '' }));
  if (!roads.length) { toast('Load streets first (or import route lines), then estimate homes along them.', 'err'); return; }
  const existing = state.homes.filter(h => h.kind !== 'est');
  const est = Engine.estimateHomes(roads, state.boundary, existing, state.est);
  state.homes = existing.concat(est);
  markStructural(); renderHomes(); renderPlan(); renderFoot(); renderResults(); save();
  toast(est.length ? `Added ${fmt.int(est.length)} estimated homes, one every ${state.est.spacing} m on both sides of residential streets.` : 'No gaps found to fill with estimated homes.');
}

function loadDemo() {
  setMode('idle');
  state.boundary = DEMO.boundary.map(p => p.slice());
  state.areaName = 'Three Rivers, Michigan (demo)';
  const parsed = Engine.parseOverpass(DEMO.osm);
  state.osm = { roads: parsed.roads, buildings: parsed.buildings, bbox: Engine.bufferBBox(Engine.ringBBox(state.boundary), 150), at: Date.now(), source: 'bundled demo' };
  state.homes = []; state.removed = []; state.unitOverrides = {}; state.routes = []; state.refs = [];
  state.pfpMode = 'auto'; state.pfps = [];
  state.design = null; state.ctx = null; state.stale = false; state.alts = null;
  rebuildOsmHomes();
  state.homes = state.homes.concat(Engine.estimateHomes(state.osm.roads, state.boundary, state.homes, { spacing: 22, setback: 15 }));
  renderAll();
  map.fitBounds(L.latLngBounds(state.boundary), { padding: [40, 40] });
  generate().then(() => toast('Demo: real OpenStreetMap streets, with OSM buildings plus estimated homes where buildings are missing.', 'info', 7000));
}

/* ================================================================ KML import */
let pendingImport = null;

async function importFile(file) {
  if (!file) return;
  if (/\.json$/i.test(file.name)) { openProject(file); return; }
  if (!/\.km[lz]$/i.test(file.name)) { toast('Import a .kml or .kmz file (from Google Earth, My Maps or any GIS).', 'err'); return; }
  try {
    setBusy('Reading ' + file.name + '…');
    const res = await KML.readFile(file);
    setBusy(null);
    if (!res.features.length) { toast('No placemarks found in this file.', 'err'); return; }
    openImportDialog(file.name, res.name, KML.groupFeatures(res.features));
  } catch (e) {
    setBusy(null);
    toast(e.message || 'Could not read that file.', 'err');
  }
}

function openImportDialog(fname, docName, groups) {
  pendingImport = { fname, docName, groups };
  const n = groups.reduce((s, g) => s + g.features.length, 0);
  const hasArea = groups.some(g => g.role === 'area');
  const tIcon = { Point: 'map-pin', LineString: 'route', Polygon: 'pentagon' };
  const tName = { Point: ['point', 'points'], LineString: ['line', 'lines'], Polygon: ['polygon', 'polygons'] };
  openModal(`
    <div class="m-h"><div class="grow"><h2>Import ${esc(fname)}</h2><div class="sub">${fmt.int(n)} placemarks in ${groups.length} group${groups.length > 1 ? 's' : ''}. Choose what each group is.</div></div><button class="icon-btn" data-act="close-modal" aria-label="Close">${icon('x')}</button></div>
    <div class="m-b">
      <div>${groups.map((g, i) => {
        const ex = g.features.slice(0, 3).map(f => f.name).filter(Boolean).join(', ');
        return `<div class="imp-row"><div style="min-width:0"><div class="nm">${icon(tIcon[g.type], 'i-sm')} ${esc(g.label)}</div><div class="hint">${fmt.int(g.features.length)} ${tName[g.type][g.features.length === 1 ? 0 : 1]}${ex ? ' · ' + esc(ex) : ''}</div></div>
        <select class="select select-sm" data-imp="${i}" aria-label="Use ${esc(g.label)} as">${KML.ROLE_OPTIONS[g.type].map(([v, l]) => `<option value="${v}"${v === g.role ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
      }).join('')}</div>
      <div class="chk-row"><div class="t"><label class="lbl" for="impReplace">Start a fresh plan</label><span class="hint">Clears the current area, homes, PFPs and design first.</span></div><input type="checkbox" class="chk" id="impReplace"${hasArea || !state.boundary ? ' checked' : ''}></div>
      <div class="hint">Lines become paths the cables can follow, such as pole lines or streets OpenStreetMap is missing. Homes can be points or building outlines.</div>
    </div>
    <div class="m-f"><button class="btn btn-outline" data-act="close-modal">Cancel</button><button class="btn" data-act="do-import">${icon('upload')}Import</button></div>`);
}

function doImport() {
  if (!pendingImport) return;
  const { groups, docName, fname } = pendingImport;
  const roles = $$('[data-imp]').map(s => s.value);
  if ($('#impReplace').checked) {
    state.boundary = null; state.osm = null; state.homes = []; state.removed = []; state.unitOverrides = {};
    state.routes = []; state.refs = []; state.pfps = []; state.pfpMode = 'auto'; state.areaName = '';
    state.design = null; state.ctx = null; state.stale = false; state.alts = null;
  }
  const counts = { area: 0, homes: 0, pfp: 0, routes: 0, ref: 0 };
  let areas = [];
  const unitsFrom = (name) => { const m = String(name || '').match(/(\d{1,3})\s*(units?|flats?|hh|homes?|du|apts?)\b/i); return m ? Math.min(96, Math.max(1, +m[1])) : 1; };
  groups.forEach((g, gi) => {
    const role = roles[gi];
    for (const [k, f] of g.features.entries()) {
      if (role === 'area' && f.type === 'Polygon') areas.push(f);
      else if (role === 'homes') {
        const c = f.type === 'Point' ? { lat: f.coords[0], lng: f.coords[1] } : f.type === 'Polygon' ? Engine.polyCentroid(f.coords) : null;
        if (!c) continue;
        state.homes.push({ id: 'k' + gi + '_' + k + '_' + uid(''), lat: c.lat, lng: c.lng, units: unitsFrom(f.name), kind: 'kml', label: f.name || g.label });
        counts.homes++;
      } else if (role === 'pfp' && f.type === 'Point') {
        state.pfps.push({ id: uid('p'), lat: f.coords[0], lng: f.coords[1], name: f.name });
        state.pfpMode = 'manual'; counts.pfp++;
      } else if (role === 'routes' && f.type === 'LineString') {
        state.routes.push({ coords: f.coords, name: f.name || g.label }); counts.routes++;
      } else if (role === 'ref') { state.refs.push(f); counts.ref++; }
    }
  });
  if (areas.length) {
    areas.sort((a, b) => Engine.ringAreaM2(b.coords) - Engine.ringAreaM2(a.coords));
    state.boundary = areas[0].coords; counts.area = 1;
    state.areaName = areas[0].name || docName || fname.replace(/\.km[lz]$/i, '');
    if (state.osm && state.osm.bbox) {
      const b = Engine.ringBBox(state.boundary), o = state.osm.bbox;
      if (b.s < o.s || b.n > o.n || b.w < o.w || b.e > o.e) state.osm = null;
    }
  } else if (!state.boundary) {
    const pts = state.homes.map(h => [h.lat, h.lng]).concat(state.pfps.map(p => [p.lat, p.lng]));
    for (const r of state.routes) pts.push(...r.coords);
    if (pts.length) { state.boundary = Engine.hullAround(pts, 60); state.areaName = docName || fname.replace(/\.km[lz]$/i, ''); }
  }
  rebuildOsmHomes();
  markStructural();
  closeModal();
  pendingImport = null;
  renderAll();
  const all = [];
  if (state.boundary) all.push(...state.boundary);
  for (const h of state.homes) all.push([h.lat, h.lng]);
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [50, 50], maxZoom: 18 });
  const parts = [];
  if (counts.area) parts.push('the service area');
  if (counts.homes) parts.push(`${fmt.int(counts.homes)} homes`);
  if (counts.pfp) parts.push(`${counts.pfp} PFP${counts.pfp > 1 ? 's' : ''}`);
  if (counts.routes) parts.push(`${counts.routes} route path${counts.routes > 1 ? 's' : ''}`);
  if (counts.ref) parts.push(`${counts.ref} reference feature${counts.ref > 1 ? 's' : ''}`);
  toast(parts.length ? 'Imported ' + parts.join(', ') + '.' : 'Nothing was imported (all groups set to Ignore).', parts.length ? 'ok' : 'err');
  if (!areas.length && counts.homes) toast('The file had no area polygon, so one was drawn around the imported features.', 'info', 7000);
}

/* ================================================================ generate */
async function generate() {
  if (!state.homes.length) { toast('Add homes first: load buildings, estimate them along streets, import a KML or click them on the map.', 'err'); return; }
  setMode('idle');
  setBusy('Building the street network…');
  await nextFrame();
  try {
    const input = {
      boundary: state.boundary,
      roads: state.osm ? state.osm.roads : [],
      routes: state.routes,
      homes: state.homes,
      pfps: state.pfpMode === 'manual' ? state.pfps : [],
    };
    state.ctx = Engine.prepare(input, state.params);
    setBusy('Placing PFP, terminals, closures and cables…');
    await nextFrame();
    state.design = Engine.plan(state.ctx, state.params, state.rates);
    state.stale = false; state.alts = null;
    renderDesign(); renderResults(); renderFoot(); renderPlan(); save();
    setTab('results');
    if (window.matchMedia('(max-width: 900px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
    const S = state.design.stats;
    if (S.terminals) toast(`Design ready: ${S.pfps} PFP, ${S.terminals} terminals and ${S.closures} closures for ${fmt.int(S.units)} homes (${S.ms} ms).`);
    else toast(state.design.issues[0] ? state.design.issues[0].text : 'No design could be made.', 'err');
  } catch (e) {
    console.error(e);
    toast('Design failed: ' + (e && e.message ? e.message : e), 'err');
  } finally {
    setBusy(null);
  }
}

function afterLayoutChange(msg) {
  state.alts = null;
  renderDesign(); renderResults(); renderFoot(); save();
  if (msg) toast(msg);
}

function onTermDrag(id, ll) {
  if (!state.ctx || !state.design) return;
  const node = Engine.nearestNode(state.ctx, ll.lat, ll.lng);
  if (node < 0) { toast('No street near there, so the terminal went back.', 'err'); renderDesign(); return; }
  const cur = state.design.terminals.find(t => t.id === id);
  if (cur && cur.node === node) { renderDesign(); toast(`${id} stays on its street. Drop it on or next to a street to move it.`, 'info'); return; }
  state.design = Engine.relayout(state.ctx, state.design, state.params, state.rates, { [id]: node });
  afterLayoutChange(`Moved ${id}. Cable, drops and budget updated.`);
}

function onPfpDrag(id, ll) {
  if (!state.ctx || !state.design) return;
  const node = Engine.nearestNode(state.ctx, ll.lat, ll.lng);
  if (node < 0) { toast('No street near there, so the PFP went back.', 'err'); renderDesign(); return; }
  const curP = state.design.pfps.find(p => p.id === id);
  if (curP && curP.node === node) { renderDesign(); toast(`${id} stays on its street. Drop it on or next to a street to move it.`, 'info'); return; }
  state.design = Engine.relayout(state.ctx, state.design, state.params, state.rates, { [id]: node });
  state.pfpMode = 'manual';
  state.pfps = state.design.pfps.map((p, i) => ({ id: 'p' + (i + 1) + '_' + Date.now().toString(36), lat: p.lat, lng: p.lng }));
  renderPlan();
  afterLayoutChange(`Moved ${id}. F2 cables re-routed; Generate will keep this PFP spot.`);
}

async function compare() {
  if (!state.ctx || !state.design) return;
  setBusy('Comparing terminal sizes and drop limits…');
  await nextFrame();
  try { state.alts = Engine.alternatives(state.ctx, state.params, state.rates); }
  catch (e) { console.error(e); toast('Comparison failed: ' + e.message, 'err'); }
  finally { setBusy(null); }
  renderResults();
  const el = $('#altsCard');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applyAlt(i) {
  const a = state.alts && state.alts[i];
  if (!a) return;
  state.params = Engine.normalizeParams(Object.assign({}, state.params, a.params));
  renderRules();
  generate();
}

/* ================================================================ rules */
function setParam(k, v, input) {
  const next = Object.assign({}, state.params, { [k]: v });
  if (k === 'arch') {
    next.pfpSplit = v === 'cascaded' ? 8 : 32;
    if (!Engine.PORT_OPTIONS[v].includes(+next.termPorts)) next.termPorts = 8;
  }
  state.params = Engine.normalizeParams(next);
  if (input && input.type === 'number') input.value = state.params[k];
  if (k === 'cableSizes' && input) input.value = state.params.cableSizes.join(', ');
  if (state.design) {
    if (LIVE.has(k) && !state.stale && state.ctx) {
      state.design = Engine.relayout(state.ctx, state.design, state.params, state.rates, {});
      state.alts = null;
      renderDesign(); renderResults();
    } else { state.stale = true; state.alts = null; renderResults(); }
  }
  if (k === 'arch' || k === 'method') renderRules();
  renderFoot(); save();
}

function setRate(path, v) {
  const [a, b] = path.split('.');
  const val = a === 'currency' ? String(v).slice(0, 4) : (v === '' ? null : Math.max(0, parseFloat(v) || 0));
  if (b) state.rates[a][b] = val; else state.rates[a] = val;
  if (state.design && state.ctx && !state.stale) {
    state.design = Engine.relayout(state.ctx, state.design, state.params, state.rates, {});
    state.alts = null;
  }
  renderResults(); save();
}

function numField(k, label, unit, opts) {
  const o = opts || {};
  const v = state.params[k];
  return `<div class="field${o.full ? ' full' : ''}"><label for="p-${k}">${esc(label)}</label><div class="unit"><input class="input input-sm" type="number" id="p-${k}" data-p="${k}" value="${esc(v)}" step="${o.step || 'any'}"${o.min != null ? ` min="${o.min}"` : ''}${o.max != null ? ` max="${o.max}"` : ''}>${unit ? `<span>${esc(unit)}</span>` : ''}</div>${o.hint ? `<span class="hint">${o.hint}</span>` : ''}</div>`;
}
function selField(k, label, options, hint) {
  const v = String(state.params[k]);
  return `<div class="field"><label for="p-${k}">${esc(label)}</label><select class="select select-sm" id="p-${k}" data-p="${k}">${options.map(([val, l]) => `<option value="${esc(val)}"${String(val) === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
}
function switchField(k, label, hint, src) {
  const on = src === 'b' ? state.bopts[k] : state.params[k];
  const attr = src === 'b' ? 'data-b' : 'data-p';
  return `<div class="chk-row full"><div class="t"><label class="lbl" for="${src || 'p'}-${k}">${esc(label)}</label>${hint ? `<span class="hint">${hint}</span>` : ''}</div><input type="checkbox" class="chk" id="${src || 'p'}-${k}" ${attr}="${k}"${on ? ' checked' : ''}></div>`;
}
function rateField(path, label, unit) {
  const [a, b] = path.split('.');
  const v = b ? state.rates[a][b] : state.rates[a];
  return `<div class="field"><label for="r-${path.replace('.', '-')}">${esc(label)}</label><div class="unit"><input class="input input-sm" type="number" min="0" step="any" id="r-${path.replace('.', '-')}" data-r="${path}" value="${v == null ? '' : esc(v)}" placeholder="unpriced"><span>${esc(unit)}</span></div></div>`;
}

function renderRules() {
  const P = state.params;
  const cas = P.arch === 'cascaded';
  const ports = Engine.PORT_OPTIONS[P.arch];
  const cur = esc(state.rates.currency || '');
  const sizesUsed = P.cableSizes;
  const open = new Set($$('#panel-rules details.acc[open]').map(d => d.dataset.k));
  if (!open.size) open.add('arch');
  const sec = (k, title, sub, body) => `<details class="acc" data-k="${k}"${open.has(k) ? ' open' : ''}><summary><span><span>${title}</span><br><span class="sub">${sub}</span></span>${icon('chevron-down', 'chev')}</summary><div class="acc-b">${body}</div></details>`;
  $('#panel-rules').innerHTML = [
    sec('arch', 'Network architecture', cas ? `Cascaded 1:${P.pfpSplit} × 1:${P.termPorts}` : `Centralized 1:${P.pfpSplit} at the PFP`, `
      <div class="field"><span class="lbl">Splitting</span><div class="seg full" role="group" aria-label="Splitting">
        <button data-act="set-arch" data-v="centralized" aria-pressed="${!cas}">Centralized</button><button data-act="set-arch" data-v="cascaded" aria-pressed="${cas}">Cascaded</button></div>
        <span class="hint">${cas ? 'A splitter in the PFP feeds a second splitter inside every terminal. Few F2 fibres, higher loss.' : 'All splitting happens in the PFP; every terminal port gets its own F2 fibre.'}</span></div>
      <div class="fields">
        ${selField('pfpSplit', 'PFP splitter', [2, 4, 8, 16, 32, 64].map(n => [n, '1:' + n]))}
        ${numField('pfpMaxHomes', 'Homes per PFP', 'max', { min: 8, step: 1 })}
      </div>`),
    sec('term', 'Terminals and drops', `${P.termPorts}-port, drops up to ${P.maxDrop} m`, `
      <div class="fields">
        ${selField('termPorts', cas ? 'Terminal splitter / ports' : 'Terminal ports', ports.map(n => [n, cas ? `1:${n} (${n} ports)` : `${n} ports`]))}
        ${numField('termSpare', 'Spare ports', 'ports', { min: 0, step: 1 })}
        ${numField('maxDrop', 'Max drop length', 'm', { min: 10, step: 5 })}
        ${numField('dropSlack', 'Drop slack', '%', { min: 0, step: 1 })}
        ${cas ? numField('cascadeFibers', 'F2 fibres per terminal', '', { min: 1, max: 4, step: 1 }) : ''}
      </div>
      <span class="hint">Drop length is measured along the street from the terminal, then across to the building.</span>`),
    sec('cable', 'F2 cable and routing', `${sizesUsed[0]}F to ${sizesUsed[sizesUsed.length - 1]}F, ${P.fiberSpare}% spare`, `
      <div class="field"><label for="p-cableSizes">Cable sizes</label><input class="input input-sm" id="p-cableSizes" data-p="cableSizes" value="${esc(P.cableSizes.join(', '))}"><span class="hint">Fibre counts you stock, comma separated.</span></div>
      <div class="fields">
        ${numField('fiberSpare', 'Spare fibre', '%', { min: 0, step: 1 })}
        ${numField('cableSlack', 'Cable slack', '%', { min: 0, step: 1 })}
        ${numField('maxSnap', 'Max home-to-street', 'm', { min: 10, step: 10 })}
        ${numField('linkDist', 'Join road gaps up to', 'm', { min: 0, step: 5 })}
        ${switchField('avoidMajor', 'Prefer residential streets', 'Routes avoid main roads unless they are much shorter.')}
      </div>`),
    sec('budget', 'Optical budget', `${P.txPower} dBm launch, ${P.rxSens} dBm sensitivity`, `
      <div class="fields">
        ${numField('txPower', 'OLT launch power', 'dBm', { step: 0.1 })}
        ${numField('rxSens', 'ONT sensitivity', 'dBm', { step: 0.1 })}
        ${numField('safety', 'Required margin', 'dB', { step: 0.1, min: 0 })}
        ${numField('att', 'Fibre loss', 'dB/km', { step: 0.01, min: 0 })}
        ${numField('spliceLoss', 'Splice loss', 'dB', { step: 0.01, min: 0 })}
        ${numField('connLoss', 'Connector loss', 'dB', { step: 0.05, min: 0 })}
        ${numField('connectors', 'Connector pairs', 'pairs', { step: 1, min: 0 })}
        ${numField('feederKm', 'Feeder OLT → PFP', 'km', { step: 0.1, min: 0 })}
        ${numField('feederSplices', 'Feeder splices', '', { step: 1, min: 0 })}
        ${numField('maxReachKm', 'Max reach', 'km', { step: 1, min: 1 })}
      </div>
      <span class="hint">Splitter losses: 1:4 7.3 · 1:8 10.5 · 1:16 13.7 · 1:32 17.1 · 1:64 20.5 dB. Splices on a path = feeder splices + closures passed + 1 at the terminal.</span>`),
    sec('build', 'Construction and rates', `${P.method === 'mixed' ? `Mixed, ${P.aerialShare}% aerial` : P.method === 'aerial' ? 'Aerial' : 'Underground'} · rates in ${cur || 'no currency'}`, `
      <div class="field"><span class="lbl">Construction</span><div class="seg full" role="group" aria-label="Construction">
        ${['aerial', 'underground', 'mixed'].map(m => `<button data-act="set-method" data-v="${m}" aria-pressed="${P.method === m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div></div>
      <div class="fields">
        ${P.method === 'mixed' ? numField('aerialShare', 'Aerial share', '%', { min: 0, max: 100, step: 5 }) : ''}
        ${P.method !== 'underground' ? numField('poleSpan', 'Pole span', 'm', { min: 10, step: 5 }) : ''}
        <div class="field"><label for="r-currency">Currency symbol</label><input class="input input-sm" id="r-currency" data-r="currency" value="${cur}" maxlength="4"></div>
        ${switchField('includeOnt', 'Include ONTs in the BOM', '')}
      </div>
      <div class="alert note">${icon('info')}<div class="a-t">These are sample rates to show how costing works. Replace them with your own rate card; blank means unpriced.</div></div>
      <div class="fields">
        ${rateField('cabinet.' + (Engine.CABINET_SIZES.find(s => s >= P.pfpMaxHomes) || 288), `PFP cabinet ${Engine.CABINET_SIZES.find(s => s >= P.pfpMaxHomes) || 288}-port`, cur + '/nos')}
        ${rateField('splitter.' + P.pfpSplit, `Splitter 1:${P.pfpSplit}`, cur + '/nos')}
        ${cas ? rateField('splitter.' + P.termPorts, `Splitter 1:${P.termPorts}`, cur + '/nos') : ''}
        ${rateField('terminal.' + P.termPorts, `Terminal ${P.termPorts}-port`, cur + '/nos')}
        ${rateField('closure', 'Splice closure', cur + '/nos')}
        ${sizesUsed.map(s => rateField('cable.' + s, `F2 cable ${s}F`, cur + '/m')).join('')}
        ${rateField('drop', 'Drop cable', cur + '/m')}
        ${rateField('splice', 'Fusion splice', cur + '/ea')}
        ${P.method !== 'underground' ? rateField('aerial', 'Aerial install', cur + '/m') + rateField('pole', 'Pole attachment', cur + '/nos') : ''}
        ${P.method !== 'aerial' ? rateField('underground', 'Trench/HDD + duct', cur + '/m') + rateField('handhole', 'Handhole', cur + '/nos') : ''}
        ${P.includeOnt ? rateField('ont', 'ONT', cur + '/nos') : ''}
      </div>`),
    `<div class="btn-row"><button class="btn btn-outline btn-sm" data-act="reset-rules">${icon('refresh-cw', 'i-sm')}Reset rules</button><button class="btn btn-outline btn-sm" data-act="reset-rates">${icon('refresh-cw', 'i-sm')}Reset rates</button></div>`,
  ].join('');
}

/* ================================================================ panels */
function setTab(t) {
  state.tab = t;
  for (const b of $$('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  for (const p of ['plan', 'rules', 'results']) $('#panel-' + p).hidden = p !== t;
}

function renderPlan() {
  const el = $('#panel-plan');
  const hasArea = !!state.boundary;
  const c = homeCounts();
  const n = state.homes.length;
  const km2 = hasArea ? Engine.ringAreaM2(state.boundary) / 1e6 : 0;
  const per = hasArea ? Engine.ringPerimeterM(state.boundary) : 0;
  const osm = state.osm;
  const roadKm = osm ? osm.roads.reduce((s, r) => { let L2 = 0; for (let i = 1; i < r.coords.length; i++) L2 += Engine.haversine(r.coords[i - 1], r.coords[i]); return s + L2; }, 0) : 0;
  const m = state.mode;
  const step = (k, done) => `<span class="step${done ? ' done' : ''}">${done ? icon('check', 'i-sm') : k}</span>`;
  const intro = !hasArea && !n ? `<section class="card"><div class="card-b" style="padding-top:16px">
      <div class="ttl" style="font-weight:600">Plan an FTTH network in three steps</div>
      <ol class="help-list muted" style="font-size:13px"><li>Draw or import the service area</li><li>Load streets and buildings for it</li><li>Generate the PFP, F2 cables, closures, terminals and drops</li></ol>
      <button class="btn btn-secondary btn-sm" data-act="demo">${icon('flask-conical', 'i-sm')}Open the demo design</button>
    </div></section>` : '';
  const sources = [c.osm ? `${fmt.int(c.osm)} OSM` : '', c.est ? `${fmt.int(c.est)} estimated` : '', c.manual ? `${fmt.int(c.manual)} added` : '', c.kml ? `${fmt.int(c.kml)} KML` : ''].filter(Boolean).join(' · ');
  el.innerHTML = `${intro}
  <section class="card">
    <div class="card-h">${step(1, hasArea)}<div class="grow"><div class="ttl">Service area${state.areaName ? `: <span style="font-weight:500">${esc(state.areaName)}</span>` : ''}</div><div class="sub">${hasArea ? `${km2.toFixed(km2 < 1 ? 2 : 1)} km² · ${fmt.dist(per)} perimeter` : 'Draw the area to serve, or import a KML from Google Earth.'}</div></div></div>
    <div class="card-b">
      ${hasArea ? `<div class="btn-row">
          <button class="btn btn-outline btn-sm${m === 'edit-area' ? ' is-active' : ''}" data-act="edit-area">${icon('move', 'i-sm')}Reshape</button>
          <button class="btn btn-outline btn-sm${m === 'draw-poly' ? ' is-active' : ''}" data-act="draw-poly">${icon('pentagon', 'i-sm')}Redraw</button>
          <button class="btn btn-outline btn-sm" data-act="zoom-area" aria-label="Zoom to area" title="Zoom to area" style="flex:0 0 auto">${icon('scan', 'i-sm')}</button>
        </div>` : `<div class="btn-row">
          <button class="btn${m === 'draw-poly' ? ' is-active' : ''}" data-act="draw-poly">${icon('pentagon')}Draw area</button>
          <button class="btn btn-outline${m === 'draw-rect' ? ' is-active' : ''}" data-act="draw-rect">${icon('square-dashed')}Rectangle</button>
        </div>`}
      <button class="btn btn-outline btn-sm" data-act="import">${icon('upload', 'i-sm')}Import KML / KMZ</button>
    </div>
  </section>
  <section class="card">
    <div class="card-h">${step(2, n > 0)}<div class="grow"><div class="ttl">Homes and streets</div><div class="sub">${osm ? `${fmt.int(osm.roads.length)} street segments (${fmt.dist(roadKm)}), ${fmt.int(osm.buildings.length)} buildings` : state.routes.length ? `${state.routes.length} imported route path${state.routes.length > 1 ? 's' : ''}` : 'Load OpenStreetMap streets and buildings for the area.'}</div></div></div>
    <div class="card-b">
      ${n ? `<div class="meta"><span><b>${fmt.int(n)}</b> homes</span><span><b>${fmt.int(c.units)}</b> units</span>${sources ? `<span>${esc(sources)}</span>` : ''}</div>` : ''}
      <button class="btn ${hasArea && !osm ? '' : 'btn-outline btn-sm'}" data-act="fetch-osm"${hasArea ? '' : ' disabled'}>${icon('globe', hasArea && !osm ? '' : 'i-sm')}${osm ? 'Reload streets and buildings' : 'Load streets and buildings'}</button>
      <div class="fields" style="grid-template-columns:1fr auto;align-items:end">
        <div class="field"><label for="e-spacing">Estimate homes every</label><div class="unit"><input class="input input-sm" id="e-spacing" type="number" min="8" max="200" step="1" data-e="spacing" value="${state.est.spacing}"><span>m</span></div></div>
        <button class="btn btn-outline btn-sm" data-act="estimate"${osm || state.routes.length ? '' : ' disabled'}>${icon('house-plus', 'i-sm')}Estimate</button>
      </div>
      <span class="hint" style="margin-top:-4px">Fills streets where OpenStreetMap has no buildings, on both sides.${c.est ? ` <button class="link" data-act="clear-est">Remove ${fmt.int(c.est)} estimates</button>` : ''}</span>
      <button class="btn btn-outline btn-sm${m === 'homes' ? ' is-active' : ''}" data-act="homes-mode"${hasArea || n ? '' : ' disabled'}>${icon('map-pin', 'i-sm')}Add or remove homes on the map</button>
      <details class="inline"><summary>${icon('sliders-horizontal', 'i-sm')}Building options${icon('chevron-down', 'i-sm chev')}</summary><div class="inline-b">
        ${switchField('includeNonRes', 'Count shops, offices and schools', 'Non-residential buildings count as one connection each.', 'b')}
        ${switchField('mduUnits', 'Apartments as several units', 'Uses building:flats, else 2 units per floor.', 'b')}
        <div class="field"><label for="b-minArea">Skip buildings smaller than</label><div class="unit"><input class="input input-sm" id="b-minArea" type="number" min="0" step="5" data-b="minArea" value="${state.bopts.minArea}"><span>m²</span></div></div>
      </div></details>
    </div>
  </section>
  <section class="card">
    <div class="card-h">${step(3, state.pfpMode === 'auto' ? n > 0 : state.pfps.length > 0)}<div class="grow"><div class="ttl">PFP location</div><div class="sub">${state.pfpMode === 'auto' ? `Placed at the network centre of the homes; another PFP every ${state.params.pfpMaxHomes} homes.` : state.pfps.length ? `${state.pfps.length} placed by hand. Homes go to the nearest one by street distance.` : 'Click a street on the map to place each PFP.'}</div></div></div>
    <div class="card-b">
      <div class="seg full" role="group" aria-label="PFP placement"><button data-act="pfp-auto" aria-pressed="${state.pfpMode === 'auto'}">Auto-place</button><button data-act="pfp-manual" aria-pressed="${state.pfpMode === 'manual'}">Place by hand</button></div>
      ${state.pfpMode === 'manual' ? `<button class="btn btn-outline btn-sm${m === 'pfp' ? ' is-active' : ''}" data-act="place-pfp">${icon('crosshair', 'i-sm')}Place PFP on map</button>
        ${state.pfps.length ? `<div class="meta">${state.pfps.map((p, i) => `<span>PFP ${i + 1} <button class="link" data-act="remove-pfp" data-id="${esc(p.id)}" aria-label="Remove PFP ${i + 1}">remove</button></span>`).join('')}</div>` : ''}` : ''}
    </div>
  </section>
  ${state.routes.length || state.refs.length ? `<div class="hint">${state.routes.length ? `${state.routes.length} imported route path(s) are used for routing.` : ''} ${state.refs.length ? `${state.refs.length} reference feature(s) shown.` : ''} <button class="link" data-act="clear-kml">Remove imported lines and references</button></div>` : ''}`;
}

function renderFoot() {
  const el = $('#foot');
  const n = state.homes.length;
  const D = state.design;
  let status;
  if (state.stale && D) status = `<span style="color:var(--warn-fg)">Plan changed since the last design.</span>`;
  else if (D && D.stats.terminals) status = `${fmt.int(D.stats.units)} homes · ${D.stats.terminals} terminals · ${fmt.money(D.stats.cost, true)}`;
  else if (!state.boundary && !n) status = 'Start by drawing or importing a service area.';
  else if (!n) status = 'Load buildings, estimate homes or add them on the map.';
  else status = `${fmt.int(n)} homes ready · ${state.pfpMode === 'auto' ? 'PFP auto-placed' : `${state.pfps.length} PFP placed`} · ${state.osm || state.routes.length ? 'street routing' : 'no streets: straight lines'}`;
  el.innerHTML = `<button class="btn btn-lg btn-block" data-act="generate"${n ? '' : ' disabled'}>${icon('wand-sparkles')}${D ? 'Regenerate design' : 'Generate design'}</button><div class="hint" style="text-align:center">${status}</div>`;
  const dot = $('.tab[data-tab="results"] .dot');
  if (dot) dot.hidden = !D;
}

function stat(label, value, sub, ic) {
  return `<div class="stat"><div class="stat-l">${ic ? icon(ic, 'i-sm') : ''}${esc(label)}</div><div class="stat-v">${value}</div><div class="stat-s">${sub}</div></div>`;
}

function renderResults() {
  const el = $('#panel-results');
  const D = state.design;
  if (!D) {
    el.innerHTML = `<div class="empty"><div class="ring">${icon('network', 'i-lg')}</div><h3>No design yet</h3><p style="font-size:13px">Generate a design to see the PFP, terminals, cable quantities, optical budget and cost here.</p></div>`;
    return;
  }
  const S = D.stats, P = D.params, bs = S.budget, B = D.bom;
  const parts = [];
  if (state.stale) parts.push(`<div class="banner"><span>${icon('triangle-alert', 'i-sm')} Plan changed since this design.</span><button class="btn btn-sm" data-act="generate">${icon('refresh-cw', 'i-sm')}Regenerate</button></div>`);
  if (D.mode === 'straight') parts.push(`<div class="alert warn">${icon('triangle-alert')}<div class="a-t">No streets were loaded, so cables are drawn as straight lines between homes. Quantities are rough.</div></div>`);
  parts.push(`<div class="stats">
    ${stat('Homes passed', fmt.int(S.units), `${fmt.int(S.buildings)} buildings${S.unserved ? `, ${S.unserved} unserved` : ''}`, 'house')}
    ${stat('Terminals', fmt.int(S.terminals), `${P.termPorts}-port · ${Math.round(S.portUtil * 100)}% ports used`, 'box')}
    ${stat('F2 cable', fmt.dist(S.f2Route), `route · ${fmt.dist(S.f2Cable)} incl. slack`, 'cable')}
    ${stat('Drop cable', fmt.dist(S.dropTotal), `avg ${Math.round(S.dropAvg)} m · max ${Math.round(S.dropMax)} m`, 'git-fork')}
    ${stat(S.pfps > 1 ? 'PFPs' : 'PFP', fmt.int(S.pfps), `${S.closures} splice closures`, 'split')}
    ${stat('Estimated cost', fmt.money(S.cost, true), `${fmt.money(S.costPerHome)} per home${B.unpriced ? ` · ${B.unpriced} unpriced` : ''}`, 'chart-column')}
  </div>`);
  // optical budget
  const total = bs.pass + bs.warn + bs.fail || 1;
  const worst = bs.worst;
  const badge = bs.fail ? `<span class="badge badge-fail">${bs.fail} fail</span>` : bs.warn ? `<span class="badge badge-warn">${bs.warn} low margin</span>` : '<span class="badge badge-pass">All pass</span>';
  let hist = '';
  const rx = [];
  for (const id in D.homes) { const h = D.homes[id]; if (h.budget) rx.push([h.budget.rx, h.units, h.status]); }
  if (rx.length) {
    let lo = Infinity, hi = -Infinity;
    for (const [v] of rx) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    const nb = 16, bins = new Array(nb).fill(0);
    for (const [v, u] of rx) bins[Math.min(nb - 1, Math.floor(((v - lo) / (hi - lo)) * nb))] += u;
    const mx = Math.max(...bins);
    const thrFail = P.rxSens, thrWarn = P.rxSens + P.safety;
    hist = `<div class="hist" role="img" aria-label="Received power histogram from ${lo.toFixed(1)} to ${hi.toFixed(1)} dBm">${bins.map((b, i) => {
      const mid = lo + ((i + 0.5) / nb) * (hi - lo);
      const cls = mid < thrFail ? 'f' : mid < thrWarn ? 'w' : '';
      return `<i class="${cls}" style="height:${b ? Math.max(4, (b / mx) * 100) : 0}%" title="${b} homes"></i>`;
    }).join('')}</div><div class="hist-ax"><span>${fmt.dbm(lo)} dBm</span><span>Received power per home</span><span>${fmt.dbm(hi)} dBm</span></div>`;
  }
  parts.push(`<section class="card"><div class="card-h"><div class="grow"><div class="ttl">Optical budget</div><div class="sub">${worst ? `Worst path ${esc(worst.termId || '')} · ${worst.km.toFixed(2)} km incl. ${P.feederKm} km feeder` : 'No paths'}</div></div>${badge}</div>
    <div class="card-b">
      ${worst ? `<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap"><span class="big">${fmt.dbm(worst.rx)}</span><span class="muted">dBm worst received · ${fmt.db(worst.margin)} dB margin</span></div>` : ''}
      <div class="bar" aria-hidden="true"><i style="width:${(bs.pass / total) * 100}%;background:var(--chart-2)"></i><i style="width:${(bs.warn / total) * 100}%;background:var(--warn)"></i><i style="width:${(bs.fail / total) * 100}%;background:var(--destructive)"></i></div>
      <div class="legend-row"><span><i class="sw" style="background:var(--chart-2)"></i>Pass ${fmt.int(bs.pass)}</span><span><i class="sw" style="background:var(--warn)"></i>Under ${P.safety} dB margin ${fmt.int(bs.warn)}</span><span><i class="sw" style="background:var(--destructive)"></i>Fail ${fmt.int(bs.fail)}</span></div>
      ${hist}
      ${worst ? `<details class="inline"><summary>Loss breakdown, worst path${icon('chevron-down', 'i-sm chev')}</summary><div class="inline-b"><dl class="kv">
        <dt>Fibre ${worst.km.toFixed(2)} km × ${P.att} dB/km</dt><dd>${worst.fiber.toFixed(2)} dB</dd>
        <dt>Splitter 1:${P.pfpSplit} in PFP</dt><dd>${worst.split1.toFixed(2)} dB</dd>
        ${worst.split2 ? `<dt>Splitter 1:${P.termPorts} in terminal</dt><dd>${worst.split2.toFixed(2)} dB</dd>` : ''}
        <dt>${worst.nSplices} splices × ${P.spliceLoss} dB</dt><dd>${worst.splices.toFixed(2)} dB</dd>
        <dt>${worst.nConn} connector pairs × ${P.connLoss} dB</dt><dd>${worst.conns.toFixed(2)} dB</dd>
        <dt class="tot">Total loss</dt><dd class="tot">${worst.loss.toFixed(2)} dB</dd>
        <dt>Launch power</dt><dd>${fmt.dbm(P.txPower)} dBm</dd><dt>Received</dt><dd>${fmt.dbm(worst.rx)} dBm</dd><dt>ONT sensitivity</dt><dd>${fmt.dbm(P.rxSens)} dBm</dd>
        <dt class="tot">Margin</dt><dd class="tot">${fmt.db(worst.margin)} dB</dd></dl>
        <button class="btn btn-outline btn-xs" data-act="zoom-to" data-type="home" data-id="${esc(worst.homeId)}">${icon('locate', 'i-sm')}Show this home</button></div></details>` : ''}
    </div></section>`);
  // issues
  if (D.issues.length) {
    parts.push(`<section class="card"><div class="card-h"><div class="grow"><div class="ttl">Checks</div><div class="sub">${D.issues.filter(i => i.level === 'error').length} errors · ${D.issues.filter(i => i.level === 'warn').length} warnings</div></div></div><div class="card-b">
      ${D.issues.map(i => `<div class="alert ${i.level === 'error' ? 'err' : i.level === 'warn' ? 'warn' : 'note'}">${icon(i.level === 'error' ? 'circle-x' : i.level === 'warn' ? 'triangle-alert' : 'info')}<div class="a-t">${esc(i.text)}${i.refs.length ? `<div class="issue-refs">${i.refs.slice(0, 10).map(r => `<button class="chip" data-act="zoom-to" data-type="${r.type}" data-id="${esc(r.id)}" data-lat="${r.lat}" data-lng="${r.lng}">${esc(r.type === 'home' ? shortHome(r.id) : r.id)}</button>`).join('')}${i.refs.length > 10 ? `<span class="hint">+${i.refs.length - 10} more</span>` : ''}</div>` : ''}</div></div>`).join('')}
    </div></section>`);
  } else {
    parts.push(`<div class="alert note">${icon('circle-check')}<div class="a-t">All checks passed: every home is served within ${P.maxDrop} m and the optical budget.</div></div>`);
  }
  // BOM
  let lastCat = '';
  parts.push(`<section class="card"><div class="card-h"><div class="grow"><div class="ttl">Bill of materials</div><div class="sub">${fmt.money(B.total)} total · ${fmt.money(S.costPerHome)} per home passed</div></div></div>
    <div class="card-b"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Amount</th></tr></thead><tbody>
    ${B.lines.map(l => {
      const g = l.cat !== lastCat ? `<tr class="grp"><td colspan="3">${esc(l.cat)}</td></tr>` : '';
      lastCat = l.cat;
      return `${g}<tr><td>${esc(l.item)}${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}</td><td class="n">${fmt.int(l.qty)} <span class="muted">${esc(l.unit)}</span></td><td class="n">${l.amount == null ? '<span class="muted">unpriced</span>' : fmt.money(l.amount)}</td></tr>`;
    }).join('')}
    <tr class="tot"><td>Total</td><td></td><td class="n">${fmt.money(B.total)}</td></tr></tbody></table></div>
    <div class="hint">Sample rates. Edit them under Rules → Construction and rates; totals update instantly.</div></div></section>`);
  // alternatives
  const A = state.alts;
  parts.push(`<section class="card" id="altsCard"><div class="card-h"><div class="grow"><div class="ttl">Compare options</div><div class="sub">Re-plan the same homes with other terminal sizes and drop limits.</div></div></div><div class="card-b">
    ${A ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Option</th><th class="n">Per home</th><th></th></tr></thead><tbody>
      ${A.map((a, i) => `<tr class="${a.best ? 'is-best' : ''}"><td>${esc(a.label)}${a.current ? ' <span class="badge badge-muted">current</span>' : ''}${a.best ? ' <span class="badge badge-pass">lowest cost</span>' : ''}<div class="sub">${a.terminals} terminals · F2 ${fmt.dist(a.f2Route)} · avg drop ${Math.round(a.dropAvg)} m${a.fail ? ` · ${a.fail} budget fails` : a.warn ? ` · ${a.warn} low margin` : ''}</div></td><td class="n">${fmt.money(a.costPerHome)}</td><td class="n">${a.current ? '' : `<button class="btn btn-outline btn-xs" data-act="apply-alt" data-i="${i}">Use</button>`}</td></tr>`).join('')}
    </tbody></table></div>` : `<button class="btn btn-outline btn-sm" data-act="compare"${state.stale ? ' disabled' : ''}>${icon('git-compare', 'i-sm')}Compare 6 options</button>`}
  </div></section>`);
  // terminal schedule
  parts.push(`<details class="acc"><summary><span><span>Terminal schedule</span><br><span class="sub">${D.terminals.length} terminals · click a row to find it</span></span>${icon('chevron-down', 'chev')}</summary><div class="acc-b"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Terminal</th><th class="n">Used</th><th class="n">F2</th><th class="n">Drop max</th><th class="n">Rx</th></tr></thead><tbody>
    ${D.terminals.map(t => `<tr class="clickable" data-act="zoom-to" data-type="terminal" data-id="${esc(t.id)}"><td><span class="mono">${esc(t.id)}</span><div class="sub">${esc(t.fibers || t.cable || 'PFP stub')}</div></td><td class="n">${t.used}/${t.ports}</td><td class="n">${Math.round(t.f2m)} m</td><td class="n">${Math.round(t.maxDrop)} m</td><td class="n" style="color:${t.status === 'fail' ? 'var(--destructive)' : t.status === 'warn' ? 'var(--warn-fg)' : 'inherit'}">${t.worstRx != null ? fmt.dbm(t.worstRx) : '–'}</td></tr>`).join('')}
  </tbody></table></div></div></details>`);
  // exports
  parts.push(`<section class="card"><div class="card-h"><div class="grow"><div class="ttl">Export</div><div class="sub">KML opens in Google Earth with folders for every layer.</div></div></div><div class="card-b"><div class="exp-grid">
    <button class="btn btn-sm" data-act="export" data-k="kml">${icon('globe', 'i-sm')}KML (Google Earth)</button>
    <button class="btn btn-outline btn-sm" data-act="export" data-k="geojson">${icon('file-json', 'i-sm')}GeoJSON (GIS)</button>
    <button class="btn btn-outline btn-sm" data-act="export" data-k="bom">${icon('sheet', 'i-sm')}BOM (CSV)</button>
    <button class="btn btn-outline btn-sm" data-act="export" data-k="terminals">${icon('table', 'i-sm')}Terminal schedule</button>
    <button class="btn btn-outline btn-sm" data-act="export" data-k="fibers">${icon('list-checks', 'i-sm')}Fibre assignment</button>
    <button class="btn btn-outline btn-sm" data-act="export" data-k="homes">${icon('house', 'i-sm')}Homes and budget</button>
    <button class="btn btn-outline btn-sm" data-act="report">${icon('printer', 'i-sm')}Report (PDF)</button>
    <button class="btn btn-outline btn-sm" data-act="save-project">${icon('save', 'i-sm')}Save project</button>
  </div></div></section>`);
  el.innerHTML = parts.join('');
}

function shortHome(id) {
  const h = state.homes.find(x => x.id === id);
  if (h && h.label && h.label.length < 22) return h.label;
  return id.length > 12 ? id.slice(0, 10) + '…' : id;
}

function renderBaseSeg() {
  const opts = [['hybrid', 'Hybrid'], ['satellite', 'Satellite'], ['streets', 'Streets'], ['google', 'Google']];
  $('#baseSeg').innerHTML = opts.map(([k, l]) => `<button data-act="basemap" data-b="${k}" aria-pressed="${state.basemap === k}">${l}</button>`).join('');
}

function renderLegend() {
  const D = state.design;
  const L2 = state.layers;
  const cnt = (v) => v != null ? `<span class="c">${fmt.int(v)}</span>` : '';
  const item = (k, lg, label, count) => `<label class="layer-item"><input type="checkbox" data-l="${k}"${L2[k] ? ' checked' : ''}><span class="lg">${lg}</span>${label}${cnt(count)}</label>`;
  $('#legend').innerHTML = `
    <button class="btn btn-ghost btn-xs" data-act="legend-toggle" aria-expanded="${state.legendOpen}" style="justify-content:space-between;padding:0 4px;height:24px;font-weight:600">${icon('layers', 'i-sm')}<span style="flex:1;text-align:left">Layers</span>${icon('chevron-down', 'i-sm')}</button>
    ${state.legendOpen ? `
    ${item('pfps', '<i class="lg-pfp"></i>', 'PFP', D ? D.pfps.length : null)}
    ${item('closures', '<i class="lg-sc"></i>', 'Splice closure', D ? D.closures.length : null)}
    ${item('terminals', '<i class="lg-term"></i>', 'Terminal', D ? D.terminals.length : null)}
    ${item('cables', `<span class="lg-ramp"><i style="background:${COL.blue1}"></i><i style="background:${COL.blue3}"></i><i style="background:${COL.blue5}"></i></span>`, 'F2 cable', D ? D.runs.length : null)}
    ${item('drops', '<i class="lg-drop"></i>', 'Drop', D ? D.drops.length : null)}
    ${item('homes', `<i class="lg-home" style="background:${D ? COL.blue2 : '#fff'}"></i>`, 'Homes', state.homes.length)}
    ${D ? `<div class="legend-row" style="padding-left:32px"><span><i class="sw" style="background:${COL.blue2}"></i>pass</span><span><i class="sw" style="background:${COL.amber}"></i>low</span><span><i class="sw" style="background:${COL.red}"></i>fail</span></div>` : ''}
    ${item('roads', '<i class="lg-line" style="background:#a1a1a1;height:2px"></i>', 'Streets used for routing', null)}
    ${state.refs.length ? item('refs', '<i class="lg-home" style="background:#d4d4d4"></i>', 'Reference', state.refs.length) : ''}
    ${item('area', '<i class="lg-line" style="height:0;border-top:2px dashed #737373;background:none"></i>', 'Service area', null)}
    ${item('labels', `<span style="font-size:10px;font-weight:700">ID</span>`, 'Labels (zoom in)', null)}` : ''}`;
}

function toggleLayer(k, on) {
  state.layers[k] = on;
  if (k === 'labels') updateLabels();
  else if (LG[k]) { if (on) LG[k].addTo(map); else map.removeLayer(LG[k]); }
  save();
}

function renderAll() {
  renderArea(); renderRoads(); renderHomes(); renderDesign();
  renderPlan(); renderRules(); renderResults(); renderFoot(); renderLegend(); renderBaseSeg();
}

/* ================================================================ exports */
function exportInfo() {
  const homesById = {};
  for (const h of state.homes) homesById[h.id] = h;
  if (state.ctx) for (const u of state.ctx.unserved) if (!homesById[u.id]) homesById[u.id] = u;
  let roads = null;
  if (state.osm && state.boundary) {
    const b = Engine.bufferBBox(Engine.ringBBox(state.boundary), 60);
    roads = state.osm.roads.filter(r => r.coords.some(([la, lo]) => la >= b.s && la <= b.n && lo >= b.w && lo <= b.e)).slice(0, 5000).map(r => r.coords);
  }
  return {
    title: projectTitle(), boundary: state.boundary, areaKm2: state.boundary ? Engine.ringAreaM2(state.boundary) / 1e6 : 0,
    homesById, routes: state.routes, roads,
  };
}

function doExport(kind) {
  const D = state.design;
  if (!D) return;
  const info = exportInfo();
  const base = slug(info.title) + '-' + new Date().toISOString().slice(0, 10);
  if (kind === 'kml') download(base + '.kml', KML.exportKML(D, info), 'application/vnd.google-earth.kml+xml');
  else if (kind === 'geojson') download(base + '.geojson', KML.exportGeoJSON(D, info), 'application/geo+json');
  else if (kind === 'bom') download(base + '-bom.csv', KML.bomCSV(D), 'text/csv');
  else if (kind === 'terminals') download(base + '-terminals.csv', KML.terminalsCSV(D), 'text/csv');
  else if (kind === 'fibers') download(base + '-fibre-assignment.csv', KML.fibersCSV(D), 'text/csv');
  else if (kind === 'homes') download(base + '-homes.csv', KML.homesCSV(D, info.homesById), 'text/csv');
  toast('Downloaded ' + { kml: 'KML', geojson: 'GeoJSON', bom: 'BOM', terminals: 'terminal schedule', fibers: 'fibre assignment', homes: 'homes and budget' }[kind] + '.');
}

function openReport() {
  const D = state.design;
  if (!D) return;
  const html = KML.reportHTML(D, exportInfo(), fmt);
  const w = window.open('', '_blank');
  if (w && w.document) { w.document.open(); w.document.write(html); w.document.close(); }
  else { download(slug(projectTitle()) + '-report.html', html, 'text/html'); toast('Pop-ups are blocked, so the report was downloaded instead. Open it and print to PDF.', 'info'); }
}

function saveProject() {
  const data = snapshot(true);
  data.savedAt = new Date().toISOString();
  data.app = 'FiberDraft';
  download(slug(projectTitle()) + '.fiberdraft.json', JSON.stringify(data), 'application/json');
  toast('Project saved. Open it later from Import, or drop it on the map.');
}

async function openProject(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (!obj || obj.v !== 1) throw new Error('This is not a FiberDraft project file.');
    setMode('idle');
    applySnapshot(obj);
    renderAll();
    if (state.boundary) map.fitBounds(L.latLngBounds(state.boundary), { padding: [40, 40] });
    toast('Project opened.');
    if (obj.hadDesign && state.homes.length) generate();
  } catch (e) { toast(e.message || 'Could not open that project.', 'err'); }
}

/* ================================================================ search */
let searchResults = [];
async function runSearch(q) {
  const box = $('#qres');
  q = q.trim();
  if (!q) { box.hidden = true; return; }
  const m = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) { map.setView([+m[1], +m[2]], 18); box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="hint" style="padding:8px 10px">Searching…</div>`;
  try {
    let res = [];
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=' + encodeURIComponent(q));
      const j = await r.json();
      res = j.map(x => ({ name: x.name || x.display_name.split(',')[0], full: x.display_name, lat: +x.lat, lng: +x.lon, bb: x.boundingbox ? x.boundingbox.map(Number) : null }));
    } catch (e) {
      const r = await fetch('https://photon.komoot.io/api/?limit=6&q=' + encodeURIComponent(q));
      const j = await r.json();
      res = (j.features || []).map(f => ({ name: f.properties.name || q, full: [f.properties.name, f.properties.city, f.properties.state, f.properties.country].filter(Boolean).join(', '), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], bb: f.properties.extent ? [f.properties.extent[3], f.properties.extent[1], f.properties.extent[0], f.properties.extent[2]] : null }));
    }
    searchResults = res;
    box.innerHTML = res.length ? res.map((x, i) => `<button data-act="goto" data-i="${i}"><div>${esc(x.name)}</div><div class="sub">${esc(x.full)}</div></button>`).join('') : '<div class="hint" style="padding:8px 10px">No places found.</div>';
  } catch (e) {
    box.innerHTML = '<div class="hint" style="padding:8px 10px">Search is unavailable right now. Paste coordinates like 26.7606, 83.3732 instead.</div>';
  }
}

function gotoResult(i) {
  const x = searchResults[i];
  if (!x) return;
  if (x.bb && x.bb.every(isFinite) && Math.abs(x.bb[1] - x.bb[0]) < 1.5) map.flyToBounds([[x.bb[0], x.bb[2]], [x.bb[1], x.bb[3]]], { maxZoom: 17 });
  else map.flyTo([x.lat, x.lng], 16);
  $('#qres').hidden = true;
  $('#q').value = x.name;
}

/* ================================================================ help */
function openHelp() {
  openModal(`
    <div class="m-h"><div class="grow"><h2>How FiberDraft works</h2><div class="sub">Auto-design from PFP to terminal and drop, on real streets.</div></div><button class="icon-btn" data-act="close-modal" aria-label="Close">${icon('x')}</button></div>
    <div class="m-b">
      <ol class="help-list">
        <li><b>Service area.</b> Draw a polygon or rectangle, or import a KML/KMZ from Google Earth or My Maps. Folders in the KML can become the area, homes, PFPs or route paths.</li>
        <li><b>Homes and streets.</b> Streets and buildings come from OpenStreetMap. Where buildings are missing, estimate homes along residential streets or click them in.</li>
        <li><b>Generate.</b> The engine snaps every home to the street network, places the PFP at the network centre (one per ${state.params.pfpMaxHomes} homes), groups homes into terminals within the port and drop-length limits, routes F2 cables along the shortest streets, puts splice closures at every branch, sizes cables with spare fibre and checks each home's optical budget.</li>
        <li><b>Refine.</b> Drag a terminal or PFP and the cables, drops, budget and BOM update. Use Compare options to test terminal sizes and drop limits.</li>
        <li><b>Export.</b> KML for Google Earth, GeoJSON for GIS, CSVs for BOM, terminal schedule and fibre assignment (TIA-598 colours), and a printable report.</li>
      </ol>
      <div class="sep"></div>
      <div class="lbl">Shortcuts while drawing</div>
      <div class="meta"><span><kbd>Enter</kbd> finish</span><span><kbd>Backspace</kbd> undo point</span><span><kbd>Esc</kbd> cancel</span></div>
      <div class="sep"></div>
      <p class="hint">Designs are planning drafts: confirm pole and duct availability, permits and site conditions in the field. Street and building data © OpenStreetMap contributors. Imagery © Esri and its partners. Your work is saved in this browser automatically; use Save project to keep a file.</p>
    </div>
    <div class="m-f"><button class="btn" data-act="close-modal">Got it</button></div>`);
}

function confirmNew() {
  openModal(`
    <div class="m-h"><div class="grow"><h2>Start a new plan?</h2><div class="sub">This clears the area, homes, PFPs, imported features and the design. Your rules and rates stay.</div></div></div>
    <div class="m-f"><button class="btn btn-outline" data-act="close-modal">Cancel</button><button class="btn btn-destructive" data-act="do-new">Clear and start new</button></div>`);
}

function doNew() {
  closeModal();
  setMode('idle');
  Object.assign(state, { boundary: null, areaName: '', osm: null, homes: [], removed: [], unitOverrides: {}, routes: [], refs: [], pfpMode: 'auto', pfps: [], design: null, ctx: null, stale: false, alts: null });
  map.closePopup();
  renderAll(); setTab('plan'); save();
}

/* ================================================================ events */
const actions = {
  tab: (el) => setTab(el.dataset.tab),
  'draw-poly': () => setMode(state.mode === 'draw-poly' ? 'idle' : 'draw-poly'),
  'draw-rect': () => setMode(state.mode === 'draw-rect' ? 'idle' : 'draw-rect'),
  'finish-draw': () => finishPoly(),
  'undo-vertex': () => { draw.pts.pop(); drawGuide(); renderHint(); },
  'cancel-mode': () => setMode('idle'),
  'edit-area': () => (state.mode === 'edit-area' ? setMode('idle') : startEditArea()),
  'zoom-area': () => state.boundary && map.fitBounds(L.latLngBounds(state.boundary), { padding: [40, 40] }),
  import: () => $('#fileKml').click(),
  demo: () => loadDemo(),
  'fetch-osm': () => fetchOSM(),
  estimate: () => estimate(),
  'clear-est': () => { state.homes = state.homes.filter(h => h.kind !== 'est'); markStructural(); renderHomes(); renderPlan(); renderFoot(); renderResults(); save(); },
  'clear-kml': () => { state.routes = []; state.refs = []; markStructural(); renderRoads(); renderPlan(); renderFoot(); renderResults(); renderLegend(); save(); },
  'homes-mode': () => setMode(state.mode === 'homes' ? 'idle' : 'homes'),
  'pfp-auto': () => { state.pfpMode = 'auto'; markStructural(); setMode('idle'); renderDesign(); renderFoot(); renderResults(); save(); },
  'pfp-manual': () => { state.pfpMode = 'manual'; markStructural(); renderPlan(); renderDesign(); renderFoot(); renderResults(); save(); },
  'place-pfp': () => setMode(state.mode === 'pfp' ? 'idle' : 'pfp'),
  'remove-pfp': (el) => { state.pfps = state.pfps.filter(p => p.id !== el.dataset.id); map.closePopup(); markStructural(); renderDesign(); renderPlan(); renderFoot(); renderResults(); save(); },
  'remove-home': (el) => removeHome(el.dataset.id),
  'set-units': (el) => {
    const id = el.dataset.id, v = Math.max(1, Math.min(96, Math.round(+$('#hu').value || 1)));
    const h = state.homes.find(x => x.id === id);
    if (!h) return;
    h.units = v;
    if (h.kind === 'osm') state.unitOverrides[id] = v;
    map.closePopup(); markStructural(); restyleHomes(); renderPlan(); renderFoot(); renderResults(); save();
    toast(`Set ${v} unit${v > 1 ? 's' : ''}. Regenerate to apply.`, 'info');
  },
  generate: () => generate(),
  compare: () => compare(),
  'apply-alt': (el) => applyAlt(+el.dataset.i),
  export: (el) => doExport(el.dataset.k),
  report: () => openReport(),
  'save-project': () => saveProject(),
  'zoom-to': (el) => zoomTo(el.dataset.type, el.dataset.id, +el.dataset.lat, +el.dataset.lng),
  basemap: (el) => setBasemap(el.dataset.b),
  'legend-toggle': () => { state.legendOpen = !state.legendOpen; renderLegend(); save(); },
  'set-arch': (el) => setParam('arch', el.dataset.v),
  'set-method': (el) => setParam('method', el.dataset.v),
  'reset-rules': () => { state.params = Engine.normalizeParams({}); if (state.design) state.stale = true; renderRules(); renderResults(); renderFoot(); save(); toast('Rules reset to defaults.', 'info'); },
  'reset-rates': () => { state.rates = Engine.normalizeRates(null); if (state.design && state.ctx && !state.stale) state.design = Engine.relayout(state.ctx, state.design, state.params, state.rates, {}); renderRules(); renderResults(); renderFoot(); save(); toast('Rates reset to the samples.', 'info'); },
  help: () => openHelp(),
  new: () => confirmNew(),
  'do-new': () => doNew(),
  'close-modal': () => closeModal(),
  'do-import': () => doImport(),
  goto: (el) => gotoResult(+el.dataset.i),
  'google-save': async () => {
    const key = ($('#gk').value || '').trim();
    if (!key) { toast('Paste an API key first.', 'err'); return; }
    try {
      setBusy('Connecting to Google Map Tiles…');
      await enableGoogle(key);
      try { localStorage.setItem(GKEY, key); } catch (e) { /* ignore */ }
      closeModal(); setBasemap('google'); updateGoogleAttribution();
    } catch (e) { toast('Google tiles failed: ' + e.message, 'err', 9000); }
    finally { setBusy(null); }
  },
};

function zoomTo(type, id, lat, lng) {
  let ll = isFinite(lat) && isFinite(lng) && (lat || lng) ? [lat, lng] : null;
  const D = state.design;
  if (type === 'terminal' && D) { const t = D.terminals.find(x => x.id === id); if (t) ll = [t.lat, t.lng]; }
  if (type === 'pfp' && D) { const p = D.pfps.find(x => x.id === id); if (p) ll = [p.lat, p.lng]; }
  if (type === 'home') { const h = state.homes.find(x => x.id === id) || (state.ctx && state.ctx.unserved.find(x => x.id === id)); if (h) ll = [h.lat, h.lng]; }
  if (!ll) return;
  map.setView(ll, Math.max(map.getZoom(), 18));
  setTimeout(() => {
    if (type === 'terminal' && D) { const t = D.terminals.find(x => x.id === id); if (t) popupAt(ll, termPopup(t)); }
    else if (type === 'pfp' && D) { const p = D.pfps.find(x => x.id === id); if (p) popupAt(ll, pfpPopup(p)); }
    else if (type === 'home') { const h = state.homes.find(x => x.id === id); if (h) popupAt(ll, homePopup(h)); }
  }, 300);
  if (window.matchMedia('(max-width: 900px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && !el.disabled && actions[el.dataset.act]) { e.preventDefault(); actions[el.dataset.act](el, e); return; }
    if (!e.target.closest('.search')) $('#qres').hidden = true;
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.p) setParam(t.dataset.p, t.type === 'checkbox' ? t.checked : t.value, t);
    else if (t.dataset.r) setRate(t.dataset.r, t.value);
    else if (t.dataset.b) {
      const k = t.dataset.b;
      state.bopts[k] = t.type === 'checkbox' ? t.checked : Math.max(0, +t.value || 0);
      rebuildOsmHomes(); markStructural(); renderHomes(); renderPlan(); renderFoot(); renderResults(); save();
    } else if (t.dataset.e) {
      state.est[t.dataset.e] = Math.max(8, Math.min(200, +t.value || 20));
      t.value = state.est[t.dataset.e]; save();
    } else if (t.dataset.l) toggleLayer(t.dataset.l, t.checked);
  });
  $('#fileKml').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; importFile(f); });
  const q = $('#q');
  let qt = null;
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(qt); runSearch(q.value); }
    else if (e.key === 'Escape') { $('#qres').hidden = true; q.blur(); }
    else if (e.key === 'ArrowDown') { const b = $('#qres button'); if (b) { e.preventDefault(); b.focus(); } }
  });
  q.addEventListener('input', () => { clearTimeout(qt); if (q.value.trim().length >= 3) qt = setTimeout(() => runSearch(q.value), 650); });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
    if (typing || $('#modal').open) return;
    if (e.key === 'Escape' && state.mode !== 'idle') { setMode('idle'); e.preventDefault(); }
    else if (e.key === 'Enter' && state.mode === 'draw-poly' && draw.pts.length >= 3) { finishPoly(); e.preventDefault(); }
    else if ((e.key === 'Backspace' || e.key === 'Delete') && state.mode === 'draw-poly' && draw.pts.length) { draw.pts.pop(); drawGuide(); renderHint(); e.preventDefault(); }
  });
  const wrap = $('.mapwrap'), dz = $('#dropzone');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; dz.hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dz.hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; dz.hidden = true; const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) importFile(f); });
  $('#modal').addEventListener('close', () => { pendingImport = null; });
  void wrap;
}

/* ================================================================ init */
function init() {
  for (const el of $$('[data-i]')) el.outerHTML = icon(el.dataset.i, el.dataset.c || '');
  if (!window.L) {
    $('#map').innerHTML = `<div class="empty" style="height:100%;justify-content:center"><div class="ring">${icon('triangle-alert', 'i-lg')}</div><h3>The map could not load</h3><p style="font-size:13px">FiberDraft needs an internet connection for map tiles and street data. Check your connection and reload.</p></div>`;
  }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
  if (saved && saved.v === 1) applySnapshot(saved);
  bindEvents();
  if (!window.L) { renderPlan(); renderRules(); renderResults(); renderFoot(); return; }
  const wantGoogle = state.basemap === 'google';
  if (wantGoogle) state.basemap = 'hybrid';
  initMap();
  if (saved && saved.view && saved.view.c) map.setView([saved.view.c.lat, saved.view.c.lng], saved.view.z || 15);
  else if (state.boundary) map.fitBounds(L.latLngBounds(state.boundary), { padding: [40, 40] });
  else map.setView([22.6, 79.0], 5);
  renderAll();
  setTab('plan');
  try {
    const k = localStorage.getItem(GKEY);
    if (k && wantGoogle) enableGoogle(k).then(() => { setBasemap('google', true); updateGoogleAttribution(); }).catch(() => toast('Google satellite could not start, so Hybrid is shown.', 'info'));
  } catch (e) { /* ignore */ }
  if (saved && saved.hadDesign && state.homes.length) generate();
  window.FiberDraft = { state, generate, loadDemo, importFile, map: () => map };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
