/* FiberDraft — auto-design engine: PFP → F2 cable → splice closure → terminal → drop.
   Pure functions, no DOM. Runs in the browser and in Node (for tests). */
(function (root) {
'use strict';

/* ------------------------------------------------------------------ constants */
const RAD = Math.PI / 180;
const R_EARTH = 6371008.8;

const SPLIT_LOSS = { 2: 3.7, 4: 7.3, 8: 10.5, 16: 13.7, 32: 17.1, 64: 20.5, 128: 24.0 };
const CABINET_SIZES = [96, 144, 288, 432, 576, 864];
const TIA = ['BL', 'OR', 'GR', 'BR', 'SL', 'WH', 'RD', 'BK', 'YL', 'VI', 'RS', 'AQ'];

const ROUTABLE = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'road', 'service', 'track', 'pedestrian']);
const SKIP_SERVICE = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access']);
const ROAD_FACTOR = { trunk: 2.2, trunk_link: 2.2, primary: 1.8, primary_link: 1.8, secondary: 1.4, secondary_link: 1.4,
  tertiary: 1.15, tertiary_link: 1.15, unclassified: 1, residential: 1, living_street: 1, road: 1, service: 1.1,
  track: 1.3, pedestrian: 1.25, kml: 0.85, link: 3, straight: 1 };
const SKIP_BUILDINGS = new Set(['garage', 'garages', 'shed', 'roof', 'carport', 'hut', 'greenhouse', 'barn', 'cowshed',
  'stable', 'sty', 'ruins', 'construction', 'bunker', 'toilets', 'transformer_tower', 'water_tower', 'service', 'kiosk',
  'bridge', 'parking', 'storage_tank', 'silo', 'tent', 'container', 'farm_auxiliary', 'boathouse', 'shelter',
  'gatehouse', 'digester', 'tower', 'grandstand', 'pavilion', 'collapsed', 'demolished', 'abandoned']);
const NON_RES_BUILDINGS = new Set(['commercial', 'retail', 'industrial', 'warehouse', 'office', 'school', 'university',
  'college', 'hospital', 'church', 'mosque', 'temple', 'public', 'civic', 'government', 'train_station', 'transportation',
  'supermarket', 'hotel', 'kindergarten', 'sports_hall', 'stadium', 'fire_station', 'chapel', 'cathedral', 'shrine',
  'synagogue', 'factory', 'manufacture', 'religious', 'sports_centre', 'museum']);
const ESTIMATE_ROADS = new Set(['residential', 'living_street', 'unclassified', 'tertiary', 'road']);

const DEFAULTS = {
  arch: 'centralized',      // 'centralized' (all splitting at the PFP) | 'cascaded' (PFP splitter + terminal splitter)
  pfpSplit: 32,             // splitter ratio at the PFP
  pfpMaxHomes: 288,         // homes per PFP before another PFP is added
  termPorts: 8,             // ports per terminal (cascaded: terminal splitter ratio)
  termSpare: 1,             // ports kept free per terminal
  maxDrop: 150,             // m, longest drop allowed
  dropSlack: 10,            // %
  maxSnap: 250,             // m, furthest a home may sit from a road
  cableSizes: [6, 12, 24, 48, 72, 96, 144, 288],
  fiberSpare: 20,           // % spare fibre in every F2 cable
  cableSlack: 10,           // % extra cable for loops, risers and sag
  cascadeFibers: 1,         // F2 fibres per terminal in cascaded mode
  avoidMajor: true,         // prefer residential streets over main roads
  linkDist: 60,             // m, join road pieces that do not touch
  txPower: 3.0,             // dBm, OLT launch power
  rxSens: -27.0,            // dBm, ONT receiver sensitivity
  safety: 3.0,              // dB margin required for a pass
  att: 0.35,                // dB/km (1310 nm, worst case)
  spliceLoss: 0.1,          // dB per fusion splice
  connLoss: 0.5,            // dB per mated connector pair
  connectors: 4,            // connector pairs end to end
  feederKm: 3.0,            // km, OLT → PFP feeder (F1)
  feederSplices: 4,
  maxReachKm: 20,
  method: 'aerial',         // 'aerial' | 'underground' | 'mixed'
  aerialShare: 70,          // % aerial when mixed
  poleSpan: 40,             // m between poles
  includeOnt: false,
};

const DEFAULT_RATES = {
  currency: '₹',
  cabinet: { 96: 45000, 144: 60000, 288: 85000, 432: 110000, 576: 135000, 864: 180000 },
  splitter: { 2: 300, 4: 450, 8: 650, 16: 1100, 32: 1900, 64: 3600 },
  cable: { 6: 12, 12: 16, 24: 24, 48: 38, 72: 52, 96: 66, 144: 95, 288: 170 },
  terminal: { 4: 1800, 6: 2300, 8: 2800, 12: 3800, 16: 4800 },
  closure: 3500,
  drop: 9,
  splice: 120,
  aerial: 35,
  pole: 250,
  underground: 450,
  handhole: 6000,
  ont: 2200,
};

/* ------------------------------------------------------------------ geo helpers */
function makeProjector(lat0, lng0) {
  const ky = RAD * R_EARTH;
  const kx = Math.cos(lat0 * RAD) * ky;
  return {
    lat0, lng0, kx, ky,
    fwd(lat, lng) { return [(lng - lng0) * kx, (lat - lat0) * ky]; },
    inv(x, y) { return [lat0 + y / ky, lng0 + x / kx]; },
  };
}

function haversine(a, b) {
  const dLat = (b[0] - a[0]) * RAD, dLng = (b[1] - a[1]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

function ringBBox(ring) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [la, lo] of ring) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  return { s, w, n, e };
}

function bufferBBox(b, meters) {
  const dLat = meters / (RAD * R_EARTH);
  const dLng = meters / (RAD * R_EARTH * Math.cos(((b.s + b.n) / 2) * RAD));
  return { s: b.s - dLat, w: b.w - dLng, n: b.n + dLat, e: b.e + dLng };
}

function bboxAreaKm2(b) {
  const h = haversine([b.s, b.w], [b.n, b.w]);
  const w = haversine([(b.s + b.n) / 2, b.w], [(b.s + b.n) / 2, b.e]);
  return (h * w) / 1e6;
}

function ringAreaM2(ring) {
  if (!ring || ring.length < 3) return 0;
  const b = ringBBox(ring);
  const p = makeProjector((b.s + b.n) / 2, (b.w + b.e) / 2);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = p.fwd(ring[i][0], ring[i][1]);
    const [xj, yj] = p.fwd(ring[j][0], ring[j][1]);
    a += xj * yi - xi * yj;
  }
  return Math.abs(a) / 2;
}

function ringPerimeterM(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) s += haversine(ring[i], ring[(i + 1) % ring.length]);
  return s;
}

function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function polyCentroid(coords) {
  const p = makeProjector(coords[0][0], coords[0][1]);
  const pts = coords.map(c => p.fwd(c[0], c[1]));
  const n = pts.length;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-6) {
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    const ll = p.inv(sx / n, sy / n);
    return { lat: ll[0], lng: ll[1], area: 0 };
  }
  a /= 2; cx /= 6 * a; cy /= 6 * a;
  const ll = p.inv(cx, cy);
  return { lat: ll[0], lng: ll[1], area: Math.abs(a) };
}

/* Convex hull of [lat,lng] points, pushed out by `pad` metres. Used when a KML has homes but no boundary. */
function hullAround(points, pad) {
  if (!points.length) return null;
  let sl = 0, sg = 0;
  for (const [la, lo] of points) { sl += la; sg += lo; }
  const p = makeProjector(sl / points.length, sg / points.length);
  const xy = points.map(([la, lo]) => p.fwd(la, lo)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of xy) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = xy.length - 1; i >= 0; i--) { const q = xy[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  let hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) {
    const [cx, cy] = xy[0];
    hull = [];
    for (let k = 0; k < 8; k++) hull.push([cx + Math.cos(k * Math.PI / 4) * pad, cy + Math.sin(k * Math.PI / 4) * pad]);
    return hull.map(([x, y]) => p.inv(x, y));
  }
  let cx = 0, cy = 0;
  for (const [x, y] of hull) { cx += x; cy += y; }
  cx /= hull.length; cy /= hull.length;
  return hull.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    return p.inv(x + ((x - cx) / d) * pad, y + ((y - cy) / d) * pad);
  });
}

/* ------------------------------------------------------------------ OpenStreetMap input */
function overpassQuery(b) {
  const bb = [b.s, b.w, b.n, b.e].map(v => v.toFixed(6)).join(',');
  return '[out:json][timeout:120];(' +
    'way["highway"~"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|road|service|track|pedestrian)$"](' + bb + ');' +
    'way["building"](' + bb + ');' +
    ');out geom;';
}

function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }

function parseOverpass(json) {
  const roads = [], buildings = [];
  for (const el of (json && json.elements) || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    if (el.geometry.some(g => !g || typeof g.lat !== 'number' || typeof g.lon !== 'number')) continue;
    const t = el.tags || {};
    const coords = el.geometry.map(g => [g.lat, g.lon]);
    if (t.highway) {
      if (!ROUTABLE.has(t.highway) || t.area === 'yes') continue;
      if (t.highway === 'service' && SKIP_SERVICE.has(t.service)) continue;
      const ids = Array.isArray(el.nodes) && el.nodes.length === coords.length ? el.nodes : null;
      roads.push({ id: el.id, coords, nodeIds: ids, cls: t.highway, name: t.name || t.ref || '' });
    } else if (t.building && t.building !== 'no' && coords.length >= 3) {
      const c = polyCentroid(coords);
      buildings.push({
        id: el.id, lat: c.lat, lng: c.lng, area: c.area, type: t.building,
        levels: num(t['building:levels']), flats: num(t['building:flats']),
        label: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || t.name || '',
      });
    }
  }
  return { roads, buildings };
}

function buildingsToHomes(buildings, boundary, opts) {
  const o = Object.assign({ includeNonRes: true, mduUnits: true, minArea: 25, unitsPerLevel: 2 }, opts || {});
  const homes = [];
  for (const b of buildings) {
    if (SKIP_BUILDINGS.has(b.type)) continue;
    if (!o.includeNonRes && NON_RES_BUILDINGS.has(b.type)) continue;
    if (b.area > 0 && b.area < o.minArea) continue;
    if (boundary && !pointInRing(b.lat, b.lng, boundary)) continue;
    let units = 1;
    if (o.mduUnits) {
      if (b.flats > 0) units = b.flats;
      else if (b.type === 'apartments' || b.type === 'dormitory') units = Math.max(4, (b.levels || 3) * o.unitsPerLevel);
    }
    units = Math.max(1, Math.min(96, Math.round(units)));
    homes.push({ id: 'osm' + b.id, lat: b.lat, lng: b.lng, units, kind: 'osm', label: b.label, btype: b.type, area: Math.round(b.area) });
  }
  return homes;
}

/* Planning estimate: when OSM has few buildings, place one home every `spacing` m on both sides of residential streets. */
function estimateHomes(roads, boundary, existing, opts) {
  const o = Object.assign({ spacing: 20, setback: 15 }, opts || {});
  if (!boundary || !roads.length) return [];
  const b = ringBBox(boundary);
  const proj = makeProjector((b.s + b.n) / 2, (b.w + b.e) / 2);
  const cell = Math.max(5, o.spacing * 0.6);
  const occ = new Map();
  const key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  const near = (x, y, r) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = occ.get((cx + dx) + ',' + (cy + dy));
      if (a) for (const [px, py] of a) if (Math.hypot(px - x, py - y) < r) return true;
    }
    return false;
  };
  const put = (x, y) => { const k = key(x, y); let a = occ.get(k); if (!a) occ.set(k, a = []); a.push([x, y]); };
  for (const h of existing) { const [x, y] = proj.fwd(h.lat, h.lng); put(x, y); }
  const base = buildBaseGraph(roads, proj, { avoidMajor: false });
  const allEdges = base.EA.map((_, i) => i);
  const eg = buildEdgeGrid(base.X, base.Y, base.EA, base.EB, allEdges, 40);
  const out = [];
  let n = 0;
  for (const r of roads) {
    if (!ESTIMATE_ROADS.has(r.cls)) continue;
    const pts = r.coords.map(c => proj.fwd(c[0], c[1]));
    const segL = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segL.push(L); total += L; }
    if (total < o.spacing) continue;
    for (let s = o.spacing / 2; s <= total - 8; s += o.spacing) {
      if (s < 8) continue;
      let acc = 0, i = 0;
      while (i < segL.length - 1 && acc + segL[i] < s) { acc += segL[i]; i++; }
      const L = segL[i] || 1, t = (s - acc) / L;
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      const nx = -(by - ay) / L, ny = (bx - ax) / L;
      for (const side of [-1, 1]) {
        const x = px + side * nx * o.setback, y = py + side * ny * o.setback;
        const ll = proj.inv(x, y);
        if (!pointInRing(ll[0], ll[1], boundary)) continue;
        if (near(x, y, o.spacing * 0.6)) continue;
        const ne = nearestEdge(eg, base.X, base.Y, base.EA, base.EB, x, y, o.setback * 0.6);
        if (ne) continue;
        put(x, y);
        out.push({ id: 'est' + (++n) + '_' + Math.round(x) + '_' + Math.round(y), lat: ll[0], lng: ll[1], units: 1, kind: 'est', label: r.name ? 'Est. on ' + r.name : 'Estimated' });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ graph */
function buildBaseGraph(roads, proj, P) {
  const key2i = new Map();
  const X = [], Y = [], LAT = [], LNG = [];
  const EA = [], EB = [], EL = [], EF = [], EC = [];
  const add = (key, lat, lng) => {
    let i = key2i.get(key);
    if (i === undefined) {
      i = X.length; key2i.set(key, i);
      const [x, y] = proj.fwd(lat, lng);
      X.push(x); Y.push(y); LAT.push(lat); LNG.push(lng);
    }
    return i;
  };
  for (const r of roads) {
    const f = P.avoidMajor === false ? (r.cls === 'link' ? 2 : 1) : (ROAD_FACTOR[r.cls] || 1.1);
    let prev = -1;
    for (let k = 0; k < r.coords.length; k++) {
      const [lat, lng] = r.coords[k];
      if (!isFinite(lat) || !isFinite(lng)) { prev = -1; continue; }
      const key = r.nodeIds && r.nodeIds[k] != null ? 'o' + r.nodeIds[k] : 'c' + lat.toFixed(7) + ',' + lng.toFixed(7);
      const i = add(key, lat, lng);
      if (prev >= 0 && prev !== i) {
        const L = Math.hypot(X[i] - X[prev], Y[i] - Y[prev]);
        if (L > 0.05) { EA.push(prev); EB.push(i); EL.push(L); EF.push(f); EC.push(r.cls); }
      }
      prev = i;
    }
  }
  return { X, Y, LAT, LNG, EA, EB, EL, EF, EC };
}

/* Union pieces of the road network; join pieces closer than linkDist with short "link" edges. */
function linkComponents(base, linkDist) {
  const { X, Y, EA, EB, EL, EF, EC } = base;
  const n = X.length;
  const par = new Int32Array(n);
  for (let i = 0; i < n; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
  for (let e = 0; e < EA.length; e++) union(EA[e], EB[e]);
  const compLen = new Map();
  for (let e = 0; e < EA.length; e++) { const r = find(EA[e]); compLen.set(r, (compLen.get(r) || 0) + EL[e]); }
  if (!compLen.size) return { inMain: () => false, links: 0, comps: 0 };
  let mainRoot = -1, best = -1;
  for (const [r, L] of compLen) if (L > best) { best = L; mainRoot = r; }
  let links = 0;
  if (compLen.size > 1 && linkDist > 0) {
    const hasEdge = new Uint8Array(n);
    for (let e = 0; e < EA.length; e++) { hasEdge[EA[e]] = 1; hasEdge[EB[e]] = 1; }
    const members = new Map();
    for (let i = 0; i < n; i++) if (hasEdge[i]) { const r = find(i); let a = members.get(r); if (!a) members.set(r, a = []); a.push(i); }
    const cell = linkDist;
    const grid = new Map();
    const addToGrid = (i) => { const k = Math.floor(X[i] / cell) + ',' + Math.floor(Y[i] / cell); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i); };
    for (const i of members.get(mainRoot)) addToGrid(i);
    const pending = [...members.keys()].filter(r => r !== mainRoot).sort((a, b) => compLen.get(b) - compLen.get(a));
    let changed = true, pass = 0;
    while (changed && pass < 5 && pending.length) {
      changed = false; pass++;
      for (let k = pending.length - 1; k >= 0; k--) {
        const r = pending[k];
        let bd = linkDist, bi = -1, bj = -1;
        for (const i of members.get(r)) {
          const cx = Math.floor(X[i] / cell), cy = Math.floor(Y[i] / cell);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const a = grid.get((cx + dx) + ',' + (cy + dy));
            if (!a) continue;
            for (const j of a) { const d = Math.hypot(X[i] - X[j], Y[i] - Y[j]); if (d < bd) { bd = d; bi = i; bj = j; } }
          }
        }
        if (bi >= 0) {
          EA.push(bi); EB.push(bj); EL.push(Math.max(bd, 0.05)); EF.push(ROAD_FACTOR.link); EC.push('link');
          union(bi, bj); links++;
          for (const i of members.get(r)) addToGrid(i);
          pending.splice(k, 1); changed = true;
        }
      }
    }
  }
  return { inMain: (i) => find(i) === find(mainRoot), links, comps: compLen.size };
}

function buildEdgeGrid(X, Y, EA, EB, edges, cell) {
  const grid = new Map();
  for (const e of edges) {
    const a = EA[e], b = EB[e];
    const x0 = Math.floor(Math.min(X[a], X[b]) / cell), x1 = Math.floor(Math.max(X[a], X[b]) / cell);
    const y0 = Math.floor(Math.min(Y[a], Y[b]) / cell), y1 = Math.floor(Math.max(Y[a], Y[b]) / cell);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = cx + ',' + cy;
      let arr = grid.get(k);
      if (!arr) grid.set(k, arr = []);
      arr.push(e);
    }
  }
  return { grid, cell };
}

function nearestEdge(eg, X, Y, EA, EB, px, py, maxDist) {
  const { grid, cell } = eg;
  const cx0 = Math.floor(px / cell), cy0 = Math.floor(py / cell);
  let best = null, bestD = maxDist;
  const seen = new Set();
  const maxR = Math.ceil(maxDist / cell) + 1;
  for (let r = 0; r <= maxR; r++) {
    if (best && r > Math.floor(bestD / cell) + 1) break;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const arr = grid.get((cx0 + dx) + ',' + (cy0 + dy));
        if (!arr) continue;
        for (const e of arr) {
          if (seen.has(e)) continue;
          seen.add(e);
          const a = EA[e], b = EB[e];
          const ax = X[a], ay = Y[a], vx = X[b] - ax, vy = Y[b] - ay;
          const L2 = vx * vx + vy * vy;
          let t = L2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + t * vx, qy = ay + t * vy;
          const d = Math.hypot(px - qx, py - qy);
          if (d < bestD || (best === null && d <= bestD)) { bestD = d; best = { e, t, qx, qy, d }; }
        }
      }
    }
  }
  return best;
}

/* Snap points onto the main road network, splitting edges so each snap point becomes a graph node. */
function augment(base, comp, pts, maxSnap) {
  const { X, Y, LAT, LNG, EA, EB, EL, EF, EC } = base;
  const mainEdges = [];
  for (let e = 0; e < EA.length; e++) if (comp.inMain(EA[e])) mainEdges.push(e);
  const eg = buildEdgeGrid(X, Y, EA, EB, mainEdges, 50);
  const per = new Map();
  const snaps = new Array(pts.length).fill(null);
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i];
    const ne = nearestEdge(eg, X, Y, EA, EB, px, py, maxSnap);
    if (!ne) continue;
    let arr = per.get(ne.e);
    if (!arr) per.set(ne.e, arr = []);
    arr.push({ t: ne.t, i, qx: ne.qx, qy: ne.qy, d: ne.d });
  }
  const NX = X.slice(), NY = Y.slice(), NLAT = LAT.slice(), NLNG = LNG.slice();
  const eA = [], eB = [], eL = [], eF = [], eC = [];
  const pushEdge = (a, b, f, c) => {
    if (a === b) return;
    eA.push(a); eB.push(b); eL.push(Math.max(Math.hypot(NX[a] - NX[b], NY[a] - NY[b]), 0.01)); eF.push(f); eC.push(c);
  };
  for (const e of mainEdges) {
    const a = EA[e], b = EB[e], f = EF[e], c = EC[e];
    const arr = per.get(e);
    if (!arr) { pushEdge(a, b, f, c); continue; }
    arr.sort((p, q) => p.t - q.t || p.i - q.i);
    const L = EL[e];
    let prev = a, prevPos = 0, last = a;
    for (const s of arr) {
      const pos = s.t * L;
      let node;
      if (pos < 0.5) node = a;
      else if (L - pos < 0.5) node = b;
      else if (last !== a && last !== b && pos - prevPos < 0.5) node = last;
      else {
        node = NX.length;
        NX.push(s.qx); NY.push(s.qy);
        NLAT.push(LAT[a] + (LAT[b] - LAT[a]) * s.t);
        NLNG.push(LNG[a] + (LNG[b] - LNG[a]) * s.t);
        pushEdge(prev, node, f, c);
        prev = node; prevPos = pos;
      }
      last = node;
      snaps[s.i] = { node, d: s.d };
    }
    pushEdge(prev, b, f, c);
  }
  const n = NX.length, m = eA.length;
  const deg = new Int32Array(n);
  for (let k = 0; k < m; k++) { deg[eA[k]]++; deg[eB[k]]++; }
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
  const pos = off.slice(0, n);
  const adj = new Int32Array(2 * m), len = new Float64Array(2 * m), w = new Float64Array(2 * m);
  const inMain = new Uint8Array(n);
  let totalLen = 0;
  for (let k = 0; k < m; k++) {
    const a = eA[k], b = eB[k];
    let p = pos[a]++; adj[p] = b; len[p] = eL[k]; w[p] = eL[k] * eF[k];
    p = pos[b]++; adj[p] = a; len[p] = eL[k]; w[p] = eL[k] * eF[k];
    inMain[a] = 1; inMain[b] = 1;
    totalLen += eL[k];
  }
  return { G: { n, X: NX, Y: NY, LAT: NLAT, LNG: NLNG, off, adj, len, w, inMain, edges: m, totalLen }, snaps };
}

/* Euclidean minimum spanning tree — the fallback "road" network when no streets are loaded. */
function straightNetwork(points, proj) {
  const n = points.length;
  if (n < 2) return [];
  const xy = points.map(p => proj.fwd(p[0], p[1]));
  const inT = new Uint8Array(n), best = new Float64Array(n).fill(Infinity), par = new Int32Array(n).fill(-1);
  best[0] = 0;
  const roads = [];
  for (let it = 0; it < n; it++) {
    let v = -1, bv = Infinity;
    for (let i = 0; i < n; i++) if (!inT[i] && best[i] < bv) { bv = best[i]; v = i; }
    if (v < 0) break;
    inT[v] = 1;
    if (par[v] >= 0) roads.push({ coords: [points[par[v]], points[v]], cls: 'straight', name: '' });
    for (let i = 0; i < n; i++) {
      if (inT[i]) continue;
      const d = Math.hypot(xy[i][0] - xy[v][0], xy[i][1] - xy[v][1]);
      if (d < best[i]) { best[i] = d; par[i] = v; }
    }
  }
  return roads;
}

/* Re-usable Dijkstra with a binary heap. radius bounds the search; targets stops it early. */
class Dijkstra {
  constructor(G) {
    this.G = G;
    this.dist = new Float64Array(G.n).fill(Infinity);
    this.prev = new Int32Array(G.n).fill(-1);
    this.done = new Uint8Array(G.n);
    this.touched = new Int32Array(Math.max(1, G.n));
    this.nt = 0;
    this.hN = new Int32Array(1024);
    this.hK = new Float64Array(1024);
    this.hs = 0;
  }
  reset() {
    for (let i = 0; i < this.nt; i++) { const v = this.touched[i]; this.dist[v] = Infinity; this.prev[v] = -1; this.done[v] = 0; }
    this.nt = 0; this.hs = 0;
  }
  push(v, k) {
    if (this.hs >= this.hN.length) {
      const N = new Int32Array(this.hN.length * 2); N.set(this.hN); this.hN = N;
      const K = new Float64Array(this.hK.length * 2); K.set(this.hK); this.hK = K;
    }
    const hN = this.hN, hK = this.hK;
    let i = this.hs++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hK[p] <= k) break;
      hN[i] = hN[p]; hK[i] = hK[p]; i = p;
    }
    hN[i] = v; hK[i] = k;
  }
  pop() {
    const hN = this.hN, hK = this.hK;
    const v = hN[0]; this.lastK = hK[0];
    const hs = --this.hs;
    if (hs > 0) {
      const ln = hN[hs], lk = hK[hs];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= hs) break;
        if (c + 1 < hs && hK[c + 1] < hK[c]) c++;
        if (hK[c] >= lk) break;
        hN[i] = hN[c]; hK[i] = hK[c]; i = c;
      }
      hN[i] = ln; hK[i] = lk;
    }
    return v;
  }
  run(src, weighted, radius, targets) {
    this.reset();
    const G = this.G, W = weighted ? G.w : G.len, off = G.off, adj = G.adj;
    const dist = this.dist, prev = this.prev, done = this.done;
    const R = radius == null ? Infinity : radius;
    const order = [];
    let remaining = targets ? targets.size : -1;
    dist[src] = 0; this.touched[this.nt++] = src; this.push(src, 0);
    while (this.hs > 0) {
      const v = this.pop(), k = this.lastK;
      if (done[v] || k > dist[v]) continue;
      done[v] = 1; order.push(v);
      if (remaining > 0 && targets.has(v) && --remaining === 0) break;
      for (let e = off[v]; e < off[v + 1]; e++) {
        const u = adj[e], nd = k + W[e];
        if (nd > R || nd >= dist[u]) continue;
        if (dist[u] === Infinity) this.touched[this.nt++] = u;
        dist[u] = nd; prev[u] = v; this.push(u, nd);
      }
    }
    return order;
  }
}

function buildNodeGrid(G, cell) {
  const grid = new Map();
  for (let i = 0; i < G.n; i++) {
    if (!G.inMain[i]) continue;
    const k = Math.floor(G.X[i] / cell) + ',' + Math.floor(G.Y[i] / cell);
    let a = grid.get(k);
    if (!a) grid.set(k, a = []);
    a.push(i);
  }
  return { grid, cell };
}

function nearestNodeXY(ctx, x, y, maxDist) {
  const { grid, cell } = ctx.nodeGrid;
  const G = ctx.G;
  const cx0 = Math.floor(x / cell), cy0 = Math.floor(y / cell);
  let best = -1, bd = maxDist == null ? Infinity : maxDist;
  const maxR = Math.min(60, Math.ceil(bd / cell) + 1);
  for (let r = 0; r <= maxR; r++) {
    if (best >= 0 && r > Math.floor(bd / cell) + 1) break;
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
      const a = grid.get((cx0 + dx) + ',' + (cy0 + dy));
      if (!a) continue;
      for (const i of a) { const d = Math.hypot(G.X[i] - x, G.Y[i] - y); if (d < bd) { bd = d; best = i; } }
    }
  }
  return best;
}

function nearestNode(ctx, lat, lng) {
  const [x, y] = ctx.proj.fwd(lat, lng);
  return nearestNodeXY(ctx, x, y, 2000);
}

function nearestNodesTo(ctx, x, y, k, minDeg) {
  const G = ctx.G;
  const top = [];
  for (let i = 0; i < G.n; i++) {
    if (!G.inMain[i]) continue;
    if (minDeg && G.off[i + 1] - G.off[i] < minDeg) continue;
    const d = Math.hypot(G.X[i] - x, G.Y[i] - y);
    if (top.length < k) { top.push([d, i]); top.sort((a, b) => a[0] - b[0]); }
    else if (d < top[k - 1][0]) { top[k - 1] = [d, i]; top.sort((a, b) => a[0] - b[0]); }
  }
  return top.map(t => t[1]);
}

/* ------------------------------------------------------------------ parameters */
const PORT_OPTIONS = { centralized: [4, 6, 8, 12], cascaded: [4, 8, 16] };

function clampNum(v, lo, hi, d) { const n = parseFloat(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }

function normalizeParams(P) {
  const o = Object.assign({}, DEFAULTS, P || {});
  const D = DEFAULTS;
  o.arch = o.arch === 'cascaded' ? 'cascaded' : 'centralized';
  o.pfpSplit = [2, 4, 8, 16, 32, 64].includes(+o.pfpSplit) ? +o.pfpSplit : (o.arch === 'cascaded' ? 8 : 32);
  const ports = PORT_OPTIONS[o.arch];
  o.termPorts = ports.includes(+o.termPorts) ? +o.termPorts : 8;
  o.termSpare = Math.round(clampNum(o.termSpare, 0, o.termPorts - 1, 1));
  o.pfpMaxHomes = Math.round(clampNum(o.pfpMaxHomes, 8, 5000, D.pfpMaxHomes));
  o.maxDrop = clampNum(o.maxDrop, 10, 2000, D.maxDrop);
  o.dropSlack = clampNum(o.dropSlack, 0, 100, D.dropSlack);
  o.maxSnap = clampNum(o.maxSnap, 10, 2000, D.maxSnap);
  let sizes = (Array.isArray(o.cableSizes) ? o.cableSizes : String(o.cableSizes).split(/[^0-9]+/))
    .map(v => parseInt(v, 10)).filter(v => v > 0 && v <= 1728);
  sizes = [...new Set(sizes)].sort((a, b) => a - b);
  o.cableSizes = sizes.length ? sizes : D.cableSizes.slice();
  o.fiberSpare = clampNum(o.fiberSpare, 0, 200, D.fiberSpare);
  o.cableSlack = clampNum(o.cableSlack, 0, 100, D.cableSlack);
  o.cascadeFibers = Math.round(clampNum(o.cascadeFibers, 1, 4, 1));
  o.avoidMajor = o.avoidMajor !== false && o.avoidMajor !== 'false';
  o.linkDist = clampNum(o.linkDist, 0, 300, D.linkDist);
  for (const k of ['txPower', 'rxSens', 'safety', 'att', 'spliceLoss', 'connLoss', 'feederKm', 'maxReachKm']) o[k] = clampNum(o[k], -100, 1000, D[k]);
  o.connectors = Math.round(clampNum(o.connectors, 0, 40, D.connectors));
  o.feederSplices = Math.round(clampNum(o.feederSplices, 0, 100, D.feederSplices));
  o.method = ['aerial', 'underground', 'mixed'].includes(o.method) ? o.method : 'aerial';
  o.aerialShare = clampNum(o.aerialShare, 0, 100, D.aerialShare);
  o.poleSpan = clampNum(o.poleSpan, 10, 200, D.poleSpan);
  o.includeOnt = !!o.includeOnt && o.includeOnt !== 'false';
  return o;
}

function normalizeRates(R) {
  const o = JSON.parse(JSON.stringify(DEFAULT_RATES));
  if (!R) return o;
  for (const k of Object.keys(R)) {
    if (o[k] && typeof o[k] === 'object' && R[k] && typeof R[k] === 'object') Object.assign(o[k], R[k]);
    else if (R[k] !== undefined) o[k] = R[k];
  }
  return o;
}

function splitterLoss(n) {
  if (SPLIT_LOSS[n] != null) return SPLIT_LOSS[n];
  let p = 2; while (p < n) p *= 2;
  return SPLIT_LOSS[p] != null ? SPLIT_LOSS[p] : 10 * Math.log10(n) + 2;
}

function cableFor(need, P) {
  const sizes = P.cableSizes, max = sizes[sizes.length - 1];
  const req = Math.max(1, Math.ceil(need * (1 + P.fiberSpare / 100)));
  const count = Math.max(1, Math.ceil(req / max));
  const per = Math.ceil(req / count);
  return { size: sizes.find(s => s >= per) || max, count, req };
}

function budget(P, f2m, dropm, closures) {
  const cascaded = P.arch === 'cascaded';
  const km = P.feederKm + (f2m + dropm) / 1000;
  const fiber = km * P.att;
  const split1 = splitterLoss(P.pfpSplit);
  const split2 = cascaded ? splitterLoss(P.termPorts) : 0;
  const nSplices = P.feederSplices + closures + 1;
  const splices = nSplices * P.spliceLoss;
  const nConn = P.connectors + (cascaded ? 1 : 0);
  const conns = nConn * P.connLoss;
  const loss = fiber + split1 + split2 + splices + conns;
  const rx = P.txPower - loss;
  const margin = rx - P.rxSens;
  const status = km > P.maxReachKm || margin < 0 ? 'fail' : margin < P.safety ? 'warn' : 'pass';
  return { km, fiber, split1, split2, nSplices, splices, nConn, conns, loss, rx, margin, status };
}

function tiaColor(n) {
  const tube = Math.floor((n - 1) / 12), f = (n - 1) % 12;
  return TIA[tube % 12] + (tube >= 12 ? '*' : '') + '/' + TIA[f];
}

function tiaRange(a, b) { return a === b ? tiaColor(a) : tiaColor(a) + ' – ' + tiaColor(b); }

/* ------------------------------------------------------------------ prepare */
function prepare(input, Pin) {
  const t0 = Date.now();
  const P = normalizeParams(Pin);
  const warnings = [];
  const boundary = input.boundary && input.boundary.length >= 3 ? input.boundary : null;
  const all = (input.homes || []).filter(h => isFinite(h.lat) && isFinite(h.lng));
  let homes = all;
  const outside = [];
  if (boundary) {
    homes = [];
    for (const h of all) (pointInRing(h.lat, h.lng, boundary) ? homes : outside).push(h);
  }
  const pfpsIn = (input.pfps || []).filter(p => isFinite(p.lat) && isFinite(p.lng));
  let lat0 = 0, lng0 = 0;
  if (boundary) { const b = ringBBox(boundary); lat0 = (b.s + b.n) / 2; lng0 = (b.w + b.e) / 2; }
  else if (homes.length) {
    for (const h of homes) { lat0 += h.lat; lng0 += h.lng; }
    lat0 /= homes.length; lng0 /= homes.length;
  }
  const proj = makeProjector(lat0, lng0);
  let roads = (input.roads || []).concat((input.routes || []).map(r => ({ coords: r.coords, cls: 'kml', name: r.name || 'Route' })));
  let mode = 'roads';
  if (!roads.length) {
    mode = 'straight';
    roads = straightNetwork(homes.map(h => [h.lat, h.lng]).concat(pfpsIn.map(p => [p.lat, p.lng])), proj);
    if (homes.length) warnings.push({ level: 'warn', text: 'No streets loaded, so cables run in straight lines between homes. Load roads or import route lines for street-following routes.' });
  }
  const base = buildBaseGraph(roads, proj, P);
  const comp = linkComponents(base, P.linkDist);
  const pts = homes.map(h => proj.fwd(h.lat, h.lng)).concat(pfpsIn.map(p => proj.fwd(p.lat, p.lng)));
  const aug = augment(base, comp, pts, mode === 'straight' ? 1e6 : P.maxSnap);
  const G = aug.G;
  const H = [], unserved = [];
  homes.forEach((h, i) => {
    const s = aug.snaps[i];
    if (!s) { unserved.push({ id: h.id, lat: h.lat, lng: h.lng, units: h.units || 1, reason: `No street within ${P.maxSnap} m` }); return; }
    const [x, y] = pts[i];
    H.push({ id: h.id, lat: h.lat, lng: h.lng, x, y, units: Math.max(1, Math.round(h.units || 1)), kind: h.kind, label: h.label || '', node: s.node, off: s.d });
  });
  const items = [];
  H.forEach((h, hi) => { for (let u = 0; u < h.units; u++) items.push({ hi, node: h.node, off: h.off }); });
  const manualPfps = [];
  pfpsIn.forEach((p, j) => {
    const s = aug.snaps[homes.length + j];
    if (s) manualPfps.push({ id: p.id, lat: p.lat, lng: p.lng, node: s.node, manual: true });
  });
  if (pfpsIn.length > manualPfps.length) warnings.push({ level: 'warn', text: `${pfpsIn.length - manualPfps.length} PFP(s) are more than ${P.maxSnap} m from a street and were ignored.` });
  if (comp.links) warnings.push({ level: 'info', text: `Joined ${comp.links} unconnected road piece(s) with short links.` });
  const ctx = {
    P, proj, G, H, items, unserved, outside, manualPfps, mode, warnings, boundary,
    roadCount: (input.roads || []).length, routeCount: (input.routes || []).length,
    D1: new Dijkstra(G), D2: new Dijkstra(G), nodeGrid: buildNodeGrid(G, 40), prepMs: 0,
  };
  ctx.prepMs = Date.now() - t0;
  return ctx;
}

/* ------------------------------------------------------------------ PFP placement */
function networkMedian(ctx, idxs) {
  const { G, items, D1, D2 } = ctx;
  if (!idxs.length) return -1;
  let sx = 0, sy = 0;
  for (const i of idxs) { sx += G.X[items[i].node]; sy += G.Y[items[i].node]; }
  const cx = sx / idxs.length, cy = sy / idxs.length;
  const wAt = new Map();
  for (const i of idxs) { const v = items[i].node; wAt.set(v, (wAt.get(v) || 0) + 1); }
  const targets = new Set(wAt.keys());
  const evalNode = (c) => {
    D1.run(c, true, Infinity, targets);
    let s = 0;
    for (const [v, w] of wAt) { const d = D1.dist[v]; if (!isFinite(d)) return Infinity; s += w * d; }
    return s;
  };
  const cands = nearestNodesTo(ctx, cx, cy, 12, 0).concat(nearestNodesTo(ctx, cx, cy, 10, 3));
  let best = cands[0] != null ? cands[0] : items[idxs[0]].node, bestS = Infinity;
  const seen = new Set();
  for (const c of cands) { if (seen.has(c)) continue; seen.add(c); const s = evalNode(c); if (s < bestS) { bestS = s; best = c; } }
  for (let round = 0; round < 3; round++) {
    const near = D2.run(best, false, 300).slice();
    const step = Math.max(1, Math.floor(near.length / 18));
    let improved = false;
    for (let k = 0; k < near.length; k += step) {
      const c = near[k];
      if (seen.has(c)) continue;
      seen.add(c);
      const s = evalNode(c);
      if (s < bestS - 1e-6) { bestS = s; best = c; improved = true; }
    }
    if (!improved) break;
  }
  return best;
}

function balancedKMeans(pts, k, cap) {
  const n = pts.length;
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  const centers = [];
  let far = 0, fd = -1;
  for (let i = 0; i < n; i++) { const d = d2(pts[i], [cx, cy]); if (d > fd) { fd = d; far = i; } }
  centers.push(pts[far].slice());
  const minD = new Float64Array(n).fill(Infinity);
  while (centers.length < k) {
    const c = centers[centers.length - 1];
    let bi = 0, bd = -1;
    for (let i = 0; i < n; i++) { const d = d2(pts[i], c); if (d < minD[i]) minD[i] = d; if (minD[i] > bd) { bd = minD[i]; bi = i; } }
    centers.push(pts[bi].slice());
  }
  const capK = Math.min(cap, Math.ceil((n / k) * 1.04));
  const assign = new Int32Array(n);
  for (let it = 0; it < 16; it++) {
    const pairs = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) pairs.push([d2(pts[i], centers[j]), i, j]);
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    assign.fill(-1);
    const load = new Int32Array(k);
    for (const [, i, j] of pairs) { if (assign[i] >= 0 || load[j] >= capK) continue; assign[i] = j; load[j]++; }
    for (let i = 0; i < n; i++) if (assign[i] < 0) { let bj = 0; for (let j = 1; j < k; j++) if (d2(pts[i], centers[j]) < d2(pts[i], centers[bj])) bj = j; assign[i] = bj; }
    const sx = new Float64Array(k), sy = new Float64Array(k), c = new Int32Array(k);
    for (let i = 0; i < n; i++) { const j = assign[i]; sx[j] += pts[i][0]; sy[j] += pts[i][1]; c[j]++; }
    let shift = 0;
    for (let j = 0; j < k; j++) if (c[j]) {
      const nx = sx[j] / c[j], ny = sy[j] / c[j];
      shift += Math.hypot(nx - centers[j][0], ny - centers[j][1]);
      centers[j] = [nx, ny];
    }
    if (shift < 0.5) break;
  }
  const groups = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) groups[assign[i]].push(i);
  return groups;
}

function planPfps(ctx, P) {
  const { items, G, D1 } = ctx;
  const all = items.map((_, i) => i);
  const warnings = [];
  if (ctx.manualPfps.length) {
    const pfps = ctx.manualPfps.map(p => ({ id: p.id, node: p.node, manual: true }));
    if (pfps.length === 1) return { pfps, groups: [all], warnings };
    const nodes = new Set(items.map(it => it.node));
    const dist = pfps.map(p => {
      D1.run(p.node, true, Infinity, nodes);
      return Float64Array.from(items, it => D1.dist[it.node]);
    });
    const pairs = [];
    for (let i = 0; i < items.length; i++) for (let k = 0; k < pfps.length; k++) if (isFinite(dist[k][i])) pairs.push([dist[k][i], i, k]);
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const asg = new Int32Array(items.length).fill(-1), load = new Int32Array(pfps.length);
    for (const [, i, k] of pairs) { if (asg[i] >= 0 || load[k] >= P.pfpMaxHomes) continue; asg[i] = k; load[k]++; }
    let over = 0;
    for (let i = 0; i < items.length; i++) if (asg[i] < 0) {
      let bk = 0;
      for (let k = 1; k < pfps.length; k++) if (dist[k][i] < dist[bk][i]) bk = k;
      asg[i] = bk; over++;
    }
    if (over) warnings.push({ level: 'warn', text: `${over} home(s) exceed the placed PFPs' capacity (${P.pfpMaxHomes} each). Add a PFP or raise the limit.` });
    const groups = pfps.map(() => []);
    for (let i = 0; i < items.length; i++) groups[asg[i]].push(i);
    return { pfps, groups, warnings };
  }
  const k = Math.max(1, Math.ceil(items.length / P.pfpMaxHomes));
  if (k === 1) return { pfps: [{ node: networkMedian(ctx, all), manual: false }], groups: [all], warnings };
  const groups = balancedKMeans(all.map(i => [G.X[items[i].node], G.Y[items[i].node]]), k, P.pfpMaxHomes).filter(g => g.length);
  const pfps = groups.map(g => ({ node: networkMedian(ctx, g), manual: false }));
  return { pfps, groups, warnings };
}

/* ------------------------------------------------------------------ terminal clustering */
function clusterGroup(ctx, idxs, pfpNode, P) {
  const { items, D1, D2 } = ctx;
  const occ = ctx.occ || (ctx.occ = new Map());
  const cap = Math.max(1, P.termPorts - P.termSpare);
  const maxDrop = P.maxDrop;
  const nodes = new Set(idxs.map(i => items[i].node));
  D1.run(pfpNode, false, Infinity, nodes);
  const dP = new Map();
  for (const i of idxs) dP.set(i, (isFinite(D1.dist[items[i].node]) ? D1.dist[items[i].node] : 1e9) + items[i].off);
  const atNode = new Map();
  for (const i of idxs) { const v = items[i].node; let a = atNode.get(v); if (!a) atNode.set(v, a = []); a.push(i); }
  const assigned = new Map();
  const order = idxs.slice().sort((a, b) => (dP.get(b) - dP.get(a)) || (a - b));
  const terms = [];
  const MAXC = 36;
  for (const h of order) {
    if (assigned.has(h)) continue;
    const it = items[h];
    const rStar = Math.max(0, maxDrop - it.off);
    let cands = D1.run(it.node, false, rStar);
    if (cands.length > MAXC) {
      const step = cands.length / MAXC, s = [];
      for (let k = 0; k < MAXC; k++) s.push(cands[Math.floor(k * step)]);
      cands = s;
    }
    let best = null;
    for (const T of cands) {
      const reach = D2.run(T, false, maxDrop);
      const list = [];
      for (const v of reach) {
        const arr = atNode.get(v);
        if (!arr) continue;
        const dv = D2.dist[v];
        for (const j of arr) {
          if (assigned.has(j)) continue;
          const drop = dv + items[j].off;
          if (drop <= maxDrop || j === h) list.push([j, drop]);
        }
      }
      list.sort((p, q) => (p[1] - q[1]) || (p[0] - q[0]));
      const sel = list.slice(0, cap);
      if (!sel.some(e => e[0] === h)) {
        const he = list.find(e => e[0] === h);
        if (!he) continue;
        sel[sel.length - 1] = he;
      }
      let sum = 0;
      for (const e of sel) sum += e[1];
      if (occ.get(T)) sum += 25 * sel.length;
      if (!best || sel.length > best.sel.length || (sel.length === best.sel.length && sum < best.sum - 1e-9)) best = { T, sel, sum };
    }
    if (!best) best = { T: it.node, sel: [[h, it.off]], sum: it.off };
    const ti = terms.length;
    terms.push({ node: best.T, items: best.sel.map(e => e[0]) });
    occ.set(best.T, (occ.get(best.T) || 0) + 1);
    for (const e of best.sel) assigned.set(e[0], ti);
  }
  improveTerminals(ctx, idxs, terms, atNode, P, cap);
  return terms.filter(t => t.items.length);
}

function recenterTerm(ctx, t, maxDrop) {
  const { items, D2 } = ctx;
  if (!t.items.length) return;
  const byNode = new Map();
  for (const i of t.items) {
    const it = items[i];
    const e = byNode.get(it.node);
    if (e) e.w++; else byNode.set(it.node, { w: 1, off: it.off });
  }
  const cnt = new Map(), sum = new Map();
  let groups = 0;
  for (const [node, { w, off }] of byNode) {
    const rad = maxDrop - off;
    if (rad < 0) return;
    groups++;
    const order = D2.run(node, false, rad);
    for (const v of order) {
      cnt.set(v, (cnt.get(v) || 0) + 1);
      sum.set(v, (sum.get(v) || 0) + w * (D2.dist[v] + off));
    }
  }
  const occ = ctx.occ || new Map();
  const taken = (v) => (occ.get(v) || 0) > (v === t.node ? 1 : 0);
  let bestV = t.node;
  let bestS = cnt.get(t.node) === groups ? sum.get(t.node) + (taken(t.node) ? 1e6 : 0) : Infinity;
  for (const [v, c] of cnt) {
    if (c !== groups || taken(v)) continue;
    const s = sum.get(v);
    if (s < bestS - 0.5) { bestS = s; bestV = v; }
  }
  if (bestV !== t.node) {
    occ.set(t.node, Math.max(0, (occ.get(t.node) || 1) - 1));
    occ.set(bestV, (occ.get(bestV) || 0) + 1);
    t.node = bestV;
  }
}

function improveTerminals(ctx, idxs, terms, atNode, P, cap) {
  const { items, D1 } = ctx;
  const maxDrop = P.maxDrop;
  const termOf = new Map();
  terms.forEach((t, ti) => t.items.forEach(i => termOf.set(i, ti)));
  for (let round = 0; round < 3; round++) {
    for (const t of terms) recenterTerm(ctx, t, maxDrop);
    const reachAt = new Map();
    terms.forEach((t, ti) => {
      if (!t.items.length) return;
      const order = D1.run(t.node, false, maxDrop);
      for (const v of order) {
        if (!atNode.has(v)) continue;
        let a = reachAt.get(v);
        if (!a) reachAt.set(v, a = []);
        a.push([ti, D1.dist[v]]);
      }
    });
    const loads = terms.map(t => t.items.length);
    const curDrop = (i) => {
      const ti = termOf.get(i), a = reachAt.get(items[i].node);
      if (a) for (const [tj, d] of a) if (tj === ti) return d + items[i].off;
      return Infinity;
    };
    let moved = 0;
    const list = idxs.map(i => [i, curDrop(i)]).sort((p, q) => (q[1] - p[1]) || (p[0] - q[0]));
    for (const [i, cd] of list) {
      const a = reachAt.get(items[i].node);
      if (!a) continue;
      const ti = termOf.get(i);
      let bt = ti, bd = cd;
      for (const [tj, d] of a) {
        if (tj === ti || loads[tj] >= cap) continue;
        const drop = d + items[i].off;
        if (drop <= maxDrop && drop + 2 < bd) { bt = tj; bd = drop; }
      }
      if (bt !== ti) {
        const src = terms[ti].items;
        src.splice(src.indexOf(i), 1);
        terms[bt].items.push(i);
        loads[ti]--; loads[bt]++;
        termOf.set(i, bt);
        moved++;
      }
    }
    const smallLimit = Math.max(1, Math.floor(cap / 3));
    const small = terms.map((_, ti) => ti)
      .filter(ti => terms[ti].items.length > 0 && terms[ti].items.length <= smallLimit)
      .sort((p, q) => terms[p].items.length - terms[q].items.length || p - q);
    for (const ti of small) {
      const its = terms[ti].items;
      if (!its.length) continue;
      const tmp = loads.slice();
      const planMoves = [];
      let ok = true;
      for (const i of its) {
        const a = reachAt.get(items[i].node);
        let bt = -1, bd = Infinity;
        if (a) for (const [tj, d] of a) {
          if (tj === ti || tmp[tj] >= cap || !terms[tj].items.length) continue;
          const drop = d + items[i].off;
          if (drop <= maxDrop && drop < bd) { bd = drop; bt = tj; }
        }
        if (bt < 0) { ok = false; break; }
        planMoves.push([i, bt]);
        tmp[bt]++;
      }
      if (!ok) continue;
      for (const [i, bt] of planMoves) { terms[bt].items.push(i); termOf.set(i, bt); }
      tmp[ti] = 0;
      for (let k = 0; k < loads.length; k++) loads[k] = tmp[k];
      terms[ti].items = [];
      if (ctx.occ) ctx.occ.set(terms[ti].node, Math.max(0, (ctx.occ.get(terms[ti].node) || 1) - 1));
      moved++;
    }
    if (!moved) break;
  }
  for (const t of terms) if (t.items.length) recenterTerm(ctx, t, maxDrop);
}

/* ------------------------------------------------------------------ layout: F2 tree, closures, runs, drops */
function layoutGroup(ctx, pfpNode, terms, P) {
  const { G, items, H, D1, D2 } = ctx;
  const cascaded = P.arch === 'cascaded';
  const fpt = cascaded ? P.cascadeFibers : P.termPorts;
  const tnodes = new Set(terms.map(t => t.node));
  D1.run(pfpNode, true, Infinity, tnodes);
  const parent = new Map(), children = new Map();
  const reachable = [];
  for (const t of terms) {
    let v = t.node;
    if (v !== pfpNode && D1.prev[v] < 0) { t.unreachable = true; continue; }
    reachable.push(t);
    while (v !== pfpNode && !parent.has(v)) {
      const p = D1.prev[v];
      parent.set(v, p);
      let c = children.get(p);
      if (!c) children.set(p, c = []);
      c.push(v);
      v = p;
    }
  }
  const load = new Map(), termsAt = new Map();
  for (const t of reachable) {
    let a = termsAt.get(t.node);
    if (!a) termsAt.set(t.node, a = []);
    a.push(t);
    let v = t.node;
    load.set(v, (load.get(v) || 0) + fpt);
    while (v !== pfpNode) { v = parent.get(v); load.set(v, (load.get(v) || 0) + fpt); }
  }
  const ang = (v, c) => Math.atan2(G.Y[c] - G.Y[v], G.X[c] - G.X[v]);
  for (const [v, ch] of children) ch.sort((a, b) => (load.get(b) - load.get(a)) || (ang(v, a) - ang(v, b)) || (a - b));
  const isClosure = (v) => v !== pfpNode && (children.get(v) || []).length >= 2;
  const edgeLen = (a, b) => Math.hypot(G.X[a] - G.X[b], G.Y[a] - G.Y[b]);
  const f2d = new Map([[pfpNode, 0]]), cc = new Map([[pfpNode, 0]]);
  const stack = [pfpNode], dfs = [];
  while (stack.length) {
    const v = stack.pop();
    dfs.push(v);
    const ch = children.get(v) || [];
    for (let k = ch.length - 1; k >= 0; k--) {
      const c = ch[k];
      f2d.set(c, f2d.get(v) + edgeLen(v, c));
      cc.set(c, cc.get(v) + (isClosure(v) ? 1 : 0));
      stack.push(c);
    }
  }
  const termOrder = [];
  for (const v of dfs) for (const t of termsAt.get(v) || []) termOrder.push(t);
  const runs = [], closures = [], closureAt = new Map();
  const rootRuns = [];
  const rs = [];
  const rootCh = children.get(pfpNode) || [];
  for (let k = rootCh.length - 1; k >= 0; k--) rs.push({ from: pfpNode, first: rootCh[k], parentRun: null });
  while (rs.length) {
    const { from, first, parentRun } = rs.pop();
    const nodes = [from, first];
    let v = first;
    while ((children.get(v) || []).length === 1) { v = children.get(v)[0]; nodes.push(v); }
    let length = 0;
    for (let k = 1; k < nodes.length; k++) length += edgeLen(nodes[k - 1], nodes[k]);
    const tapped = [];
    for (let k = 1; k < nodes.length; k++) for (const t of termsAt.get(nodes[k]) || []) tapped.push(t);
    const need = load.get(first);
    const cab = cableFor(need, P);
    const run = { nodes, from, to: v, need, size: cab.size, count: cab.count, length, terms: tapped, childRuns: [], parentRun };
    runs.push(run);
    if (parentRun) parentRun.childRuns.push(run); else rootRuns.push(run);
    for (const t of tapped) t.run = run;
    if (isClosure(v)) {
      const c = { node: v, inRun: run, outRuns: [], terms: termsAt.get(v) || [] };
      closures.push(c);
      closureAt.set(v, c);
      run.toClosure = c;
      const ch = children.get(v);
      for (let k = ch.length - 1; k >= 0; k--) rs.push({ from: v, first: ch[k], parentRun: run, closure: c });
    }
  }
  for (const r of runs) if (r.parentRun) { const c = closureAt.get(r.from); if (c) { c.outRuns.push(r); r.fromClosure = c; } }
  const direct = termsAt.get(pfpNode) || [];
  for (const t of reachable) {
    t.f2m = f2d.get(t.node) || 0;
    t.closures = cc.get(t.node) || 0;
    const homeUnits = new Map();
    for (const i of t.items) { const hi = items[i].hi; homeUnits.set(hi, (homeUnits.get(hi) || 0) + 1); }
    const tg = new Set([...homeUnits.keys()].map(hi => H[hi].node));
    D2.run(t.node, false, Infinity, tg);
    t.drops = [];
    for (const [hi, units] of homeUnits) {
      const h = H[hi];
      const net = D2.dist[h.node];
      const straight = Math.hypot(G.X[t.node] - h.x, G.Y[t.node] - h.y);
      const len = isFinite(net) ? Math.max(net + h.off, straight) : straight * 1.3;
      t.drops.push({ hi, units, len });
    }
    t.drops.sort((a, b) => a.len - b.len);
  }
  return { pfpNode, terms: reachable, termOrder, runs, rootRuns, closures, direct, unreachable: terms.filter(t => t.unreachable) };
}

/* ------------------------------------------------------------------ assemble the design */
const pad2 = (n) => String(n).padStart(2, '0');
const ll = (G, v) => [G.LAT[v], G.LNG[v]];

function assemble(ctx, raw, P, R, t0, keepIds) {
  const { G, H, items } = ctx;
  const cascaded = P.arch === 'cascaded';
  const fpt = cascaded ? P.cascadeFibers : P.termPorts;
  const out = {
    pfps: [], terminals: [], closures: [], runs: [], drops: [], homes: {}, fiberRows: [], pfpRows: [],
    issues: [], params: P, rates: R, raw, mode: ctx.mode,
  };
  let splices = 0;
  raw.forEach((g, gi) => {
    const no = gi + 1;
    const L = layoutGroup(ctx, g.pfp.node, g.terms, P);
    const pfpId = g.pfp.id && keepIds ? g.pfp.id : `PFP-${no}`;
    g.pfp.id = pfpId;
    L.termOrder.forEach((t, k) => { if (!keepIds || !t.id) t.id = `T${no}-${pad2(k + 1)}`; });
    L.closures.forEach((c, k) => { c.id = `SC${no}-${pad2(k + 1)}`; });
    L.runs.forEach((r, k) => { r.id = `F2-${no}-${pad2(k + 1)}`; });
    const units = L.terms.reduce((s, t) => s + t.items.length, 0);
    const buildings = L.terms.reduce((s, t) => s + t.drops.length, 0);
    const f2Ports = L.rootRuns.reduce((s, r) => s + r.size * r.count, 0) + L.direct.length * fpt;
    const cabinet = CABINET_SIZES.find(s => s >= Math.max(f2Ports, cascaded ? 0 : units)) || CABINET_SIZES[CABINET_SIZES.length - 1];
    const splitters = cascaded ? Math.ceil(L.terms.length / P.pfpSplit) : Math.ceil(units / P.pfpSplit);
    const pfpRec = {
      id: pfpId, node: g.pfp.node, lat: G.LAT[g.pfp.node], lng: G.LNG[g.pfp.node], manual: !!g.pfp.manual,
      units, buildings, terminals: L.terms.length, closures: L.closures.length, cabinet, f2Ports, splitters,
      cables: L.rootRuns.map(r => r.id), over: units > P.pfpMaxHomes, worstRx: Infinity,
    };
    out.pfps.push(pfpRec);
    for (const r of L.runs) {
      const rec = {
        id: r.id, pfpId, size: r.size, count: r.count, need: r.need, length: r.length,
        cableLen: r.length * r.count * (1 + P.cableSlack / 100),
        coords: r.nodes.map(v => ll(G, v)),
        from: r.parentRun ? (r.fromClosure ? r.fromClosure.id : '') : pfpId,
        to: r.toClosure ? r.toClosure.id : (r.terms.length ? r.terms[r.terms.length - 1].id : ''),
        terminals: r.terms.map(t => t.id),
      };
      r.rec = rec;
      out.runs.push(rec);
    }
    for (const c of L.closures) {
      const sp = c.outRuns.reduce((s, r) => s + r.need, 0) + c.terms.length * fpt;
      splices += sp;
      out.closures.push({
        id: c.id, pfpId, node: c.node, lat: G.LAT[c.node], lng: G.LNG[c.node],
        inCable: c.inRun.id, outCables: c.outRuns.map(r => r.id), terminals: c.terms.map(t => t.id), splices: sp,
      });
    }
    splices += L.rootRuns.reduce((s, r) => s + r.size * r.count, 0);
    for (const t of L.termOrder) {
      splices += fpt;
      let worst = null;
      const homes = [];
      for (const d of t.drops) {
        const h = H[d.hi];
        const b = budget(P, t.f2m, d.len, t.closures);
        out.homes[h.id] = { termId: t.id, pfpId, units: d.units, drop: d.len, budget: b, status: b.status, kind: h.kind, label: h.label };
        out.drops.push({ homeId: h.id, termId: t.id, units: d.units, length: d.len, status: b.status, coords: [ll(G, t.node), [h.lat, h.lng]] });
        homes.push(h.id);
        if (!worst || b.rx < worst.rx) worst = b;
      }
      const used = t.items.length;
      const rec = {
        id: t.id, pfpId, node: t.node, lat: G.LAT[t.node], lng: G.LNG[t.node], ports: P.termPorts, used,
        free: Math.max(0, P.termPorts - used), homes, buildings: t.drops.length, f2m: t.f2m, closuresOnPath: t.closures,
        maxDrop: t.drops.length ? t.drops[t.drops.length - 1].len : 0,
        dropTotal: t.drops.reduce((s, d) => s + d.len * d.units, 0),
        worstRx: worst ? worst.rx : null, worstMargin: worst ? worst.margin : null, status: worst ? worst.status : 'pass',
        cable: t.run ? t.run.id : null, direct: !t.run,
      };
      if (worst && worst.rx < pfpRec.worstRx) pfpRec.worstRx = worst.rx;
      t.rec = rec;
      out.terminals.push(rec);
    }
    // fibre assignment (splice matrix) and PFP connection schedule
    const rows = out.fiberRows;
    let outIdx = 0;
    const portLabel = (a, b) => {
      const s1 = Math.floor(a / P.pfpSplit) + 1, p1 = (a % P.pfpSplit) + 1;
      const s2 = Math.floor(b / P.pfpSplit) + 1, p2 = (b % P.pfpSplit) + 1;
      return s1 === s2 ? `S${s1}: ${p1}–${p2}` : `S${s1}:${p1} – S${s2}:${p2}`;
    };
    const pfpConn = (t, rootCable, a, b) => {
      const outs = cascaded ? 1 : fpt;
      const x = outIdx, y = outIdx + outs - 1;
      outIdx += outs;
      out.pfpRows.push({ pfp: pfpId, terminal: t.id, splitter: `1:${P.pfpSplit}`, outputs: x === y ? `S${Math.floor(x / P.pfpSplit) + 1}: ${(x % P.pfpSplit) + 1}` : portLabel(x, y), cable: rootCable, fibers: a === b ? String(a) : `${a}–${b}`, colours: tiaRange(a, cascaded ? a : b) });
    };
    for (const t of L.direct) {
      rows.push({ pfp: pfpId, location: pfpId, type: 'Direct', cable: '—', fibers: `${fpt} stub`, colours: '', to: t.id, toFibers: cascaded ? 'splitter in' : `ports 1–${fpt}` });
      pfpConn(t, `${t.id} stub`, 1, fpt);
    }
    const alloc = (run, rootId, base) => {
      let f = 1;
      for (const t of run.terms) {
        const a = f, b = f + fpt - 1;
        rows.push({ pfp: pfpId, location: t.id, type: 'Terminal tap', cable: run.id, fibers: a === b ? String(a) : `${a}–${b}`, colours: tiaRange(a, b), to: t.id, toFibers: cascaded ? (fpt > 1 ? `splitter in + ${fpt - 1} spare` : 'splitter in') : `ports 1–${fpt}` });
        t.rec.fibers = `${run.id} f${a === b ? a : a + '–' + b}`;
        pfpConn(t, rootId, base + a - 1, base + b - 1);
        f += fpt;
      }
      for (const cr of run.childRuns) {
        const a = f, b = f + cr.need - 1;
        rows.push({ pfp: pfpId, location: run.toClosure ? run.toClosure.id : '', type: 'Splice', cable: run.id, fibers: a === b ? String(a) : `${a}–${b}`, colours: tiaRange(a, b), to: cr.id, toFibers: cr.need === 1 ? '1' : `1–${cr.need}` });
        f += cr.need;
        alloc(cr, rootId, base + a - 1);
      }
      const total = run.size * run.count;
      if (f <= total) rows.push({ pfp: pfpId, location: run.toClosure ? run.toClosure.id : run.id, type: 'Spare', cable: run.id, fibers: f === total ? String(f) : `${f}–${total}`, colours: tiaRange(f, total), to: 'stored', toFibers: '' });
    };
    for (const r of L.rootRuns) alloc(r, r.id, 1);
    g.layout = L;
  });
  // homes not served (no road) and outside the area
  for (const u of ctx.unserved) out.homes[u.id] = { status: 'unserved', reason: u.reason, units: u.units };
  // stats
  const S = {};
  S.pfps = out.pfps.length;
  S.terminals = out.terminals.length;
  S.closures = out.closures.length;
  S.cables = out.runs.length;
  S.units = out.terminals.reduce((s, t) => s + t.used, 0);
  S.buildings = out.terminals.reduce((s, t) => s + t.buildings, 0);
  S.f2Route = out.runs.reduce((s, r) => s + r.length, 0);
  S.f2Cable = out.runs.reduce((s, r) => s + r.cableLen, 0);
  S.dropTotal = out.drops.reduce((s, d) => s + d.length * d.units, 0);
  S.dropAvg = S.units ? S.dropTotal / S.units : 0;
  S.dropMax = out.drops.reduce((m, d) => Math.max(m, d.length), 0);
  S.ports = S.terminals * P.termPorts;
  S.portUtil = S.ports ? S.units / S.ports : 0;
  S.splices = splices;
  S.unserved = ctx.unserved.reduce((s, u) => s + (u.units || 1), 0);
  S.outside = ctx.outside.length;
  const bs = { pass: 0, warn: 0, fail: 0, worst: null, best: null, sum: 0, n: 0 };
  for (const id in out.homes) {
    const h = out.homes[id];
    if (!h.budget) continue;
    bs[h.status] += h.units;
    bs.sum += h.budget.rx * h.units; bs.n += h.units;
    if (!bs.worst || h.budget.rx < bs.worst.rx) bs.worst = Object.assign({ homeId: id, termId: h.termId }, h.budget);
    if (!bs.best || h.budget.rx > bs.best.rx) bs.best = Object.assign({ homeId: id }, h.budget);
  }
  bs.avg = bs.n ? bs.sum / bs.n : null;
  S.budget = bs;
  out.stats = S;
  out.bom = computeBOM(out, P, R);
  S.cost = out.bom.total;
  S.costPerHome = S.units ? out.bom.total / S.units : 0;
  out.issues = collectIssues(ctx, out, P);
  S.ms = Date.now() - t0 + ctx.prepMs;
  return out;
}

function computeBOM(out, P, R) {
  const lines = [];
  const add = (cat, item, qty, unit, rate, note) => {
    if (!(qty > 0)) return;
    const r = rate == null || rate === '' || isNaN(+rate) ? null : +rate;
    lines.push({ cat, item, qty, unit, rate: r, amount: r == null ? null : qty * r, note: note || '' });
  };
  const cascaded = P.arch === 'cascaded';
  const cab = new Map();
  for (const p of out.pfps) cab.set(p.cabinet, (cab.get(p.cabinet) || 0) + 1);
  for (const [size, q] of [...cab].sort((a, b) => a[0] - b[0])) add('Equipment', `PFP cabinet, ${size}-port`, q, 'nos', R.cabinet[size]);
  add('Equipment', `PLC splitter 1:${P.pfpSplit} (in PFP)`, out.pfps.reduce((s, p) => s + p.splitters, 0), 'nos', R.splitter[P.pfpSplit],
    cascaded ? '1 output per terminal' : `1 output per home, ${P.pfpSplit} homes each`);
  if (cascaded) add('Equipment', `PLC splitter 1:${P.termPorts} (in terminal)`, out.terminals.length, 'nos', R.splitter[P.termPorts]);
  add('Equipment', `Terminal, ${P.termPorts}-port`, out.terminals.length, 'nos', R.terminal[P.termPorts]);
  add('Equipment', 'Splice closure', out.closures.length, 'nos', R.closure);
  const bySize = new Map();
  for (const r of out.runs) bySize.set(r.size, (bySize.get(r.size) || 0) + r.length * r.count);
  for (const [size, m] of [...bySize].sort((a, b) => a[0] - b[0])) {
    add('Cable', `F2 cable, ${size}F`, Math.ceil((m * (1 + P.cableSlack / 100)) / 10) * 10, 'm', R.cable[size], `${Math.round(m)} m route + ${P.cableSlack}% slack`);
  }
  const units = out.stats.units;
  add('Cable', 'Drop cable', Math.ceil((out.stats.dropTotal * (1 + P.dropSlack / 100)) / 10) * 10, 'm', R.drop, `${units} drops + ${P.dropSlack}% slack`);
  add('Labour', 'Fusion splicing', out.stats.splices, 'splices', R.splice, 'PFP stubs, closures, terminal tails');
  const route = out.stats.f2Route;
  const share = P.method === 'aerial' ? 1 : P.method === 'underground' ? 0 : P.aerialShare / 100;
  add('Civil', 'Aerial: strand and lash', Math.round(route * share), 'm', R.aerial);
  add('Civil', 'Pole attachments', Math.ceil((route * share) / P.poleSpan), 'nos', R.pole, `1 per ${P.poleSpan} m`);
  add('Civil', 'Underground: trench/HDD + duct', Math.round(route * (1 - share)), 'm', R.underground);
  add('Civil', 'Handholes / pedestals', Math.round((out.closures.length + out.terminals.length) * (1 - share)), 'nos', R.handhole, 'at closures and terminals');
  if (P.includeOnt) add('Customer', 'ONT', units, 'nos', R.ont);
  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const unpriced = lines.filter(l => l.amount == null).length;
  return { lines, total, unpriced, currency: R.currency };
}

function collectIssues(ctx, out, P) {
  const issues = [];
  const add = (level, text, refs) => issues.push({ level, text, refs: refs || [] });
  for (const w of ctx.warnings) add(w.level, w.text);
  if (ctx.unserved.length) add('error', `${ctx.unserved.length} building(s) have no street within ${P.maxSnap} m and are not served.`, ctx.unserved.slice(0, 200).map(u => ({ type: 'home', id: u.id, lat: u.lat, lng: u.lng })));
  const fails = [], warns = [], longs = [];
  for (const d of out.drops) {
    const ref = { type: 'home', id: d.homeId, lat: d.coords[1][0], lng: d.coords[1][1] };
    if (d.status === 'fail') fails.push(ref);
    else if (d.status === 'warn') warns.push(ref);
    if (d.length > P.maxDrop + 0.5) longs.push(ref);
  }
  if (fails.length) add('error', `${fails.length} home(s) fail the optical budget (Rx below ${P.rxSens} dBm or reach over ${P.maxReachKm} km).`, fails.slice(0, 200));
  if (warns.length) add('warn', `${warns.length} home(s) have less than ${P.safety} dB safety margin.`, warns.slice(0, 200));
  if (longs.length) add('warn', `${longs.length} drop(s) are longer than the ${P.maxDrop} m limit. Move the terminal closer, or the building is far from any street.`, longs.slice(0, 200));
  for (const p of out.pfps) if (p.over) add('warn', `${p.id} serves ${p.units} homes, over the ${P.pfpMaxHomes}-home limit.`, [{ type: 'pfp', id: p.id, lat: p.lat, lng: p.lng }]);
  const lonely = out.terminals.filter(t => t.used <= 1 && out.terminals.length > 1);
  if (lonely.length) add('info', `${lonely.length} terminal(s) serve a single home, usually an isolated building.`, lonely.slice(0, 200).map(t => ({ type: 'terminal', id: t.id, lat: t.lat, lng: t.lng })));
  const multi = out.runs.filter(r => r.count > 1);
  if (multi.length) add('info', `${multi.length} cable section(s) need parallel cables (over ${P.cableSizes[P.cableSizes.length - 1]}F).`);
  if (ctx.outside.length) add('info', `${ctx.outside.length} home(s) lie outside the service area and were skipped.`);
  return issues;
}

/* ------------------------------------------------------------------ public API */
function plan(ctx, Pin, Rin) {
  const t0 = Date.now();
  const P = normalizeParams(Pin), R = normalizeRates(Rin);
  if (!ctx.items.length) {
    const out = { pfps: [], terminals: [], closures: [], runs: [], drops: [], homes: {}, fiberRows: [], pfpRows: [], raw: [], params: P, rates: R, mode: ctx.mode };
    out.stats = { pfps: 0, terminals: 0, closures: 0, cables: 0, units: 0, buildings: 0, f2Route: 0, f2Cable: 0, dropTotal: 0, dropAvg: 0, dropMax: 0, ports: 0, portUtil: 0, splices: 0, unserved: ctx.unserved.length, outside: ctx.outside.length, budget: { pass: 0, warn: 0, fail: 0, worst: null, best: null, avg: null }, cost: 0, costPerHome: 0, ms: 0 };
    out.bom = { lines: [], total: 0, unpriced: 0, currency: R.currency };
    out.issues = collectIssues(ctx, out, P);
    out.issues.unshift({ level: 'error', text: 'No homes to design for. Load buildings, estimate homes or add them on the map.', refs: [] });
    for (const u of ctx.unserved) out.homes[u.id] = { status: 'unserved', reason: u.reason, units: u.units };
    return out;
  }
  ctx.occ = new Map();
  const pp = planPfps(ctx, P);
  const raw = [];
  pp.pfps.forEach((p, k) => {
    if (!pp.groups[k] || !pp.groups[k].length || p.node < 0) return;
    raw.push({ pfp: p, terms: clusterGroup(ctx, pp.groups[k], p.node, P) });
  });
  for (const w of pp.warnings) ctx.warnings.push(w);
  const out = assemble(ctx, raw, P, R, t0, false);
  ctx.warnings = ctx.warnings.filter(w => !pp.warnings.includes(w));
  return out;
}

/* Re-run layout with the same home-to-terminal grouping after a terminal or PFP was dragged. */
function relayout(ctx, prev, Pin, Rin, moves) {
  const t0 = Date.now();
  const P = normalizeParams(Pin), R = normalizeRates(Rin);
  const raw = prev.raw.map(g => ({
    pfp: { id: g.pfp.id, node: moves[g.pfp.id] != null ? moves[g.pfp.id] : g.pfp.node, manual: g.pfp.manual || moves[g.pfp.id] != null },
    terms: g.terms.map(t => ({ id: t.id, node: moves[t.id] != null ? moves[t.id] : t.node, items: t.items.slice() })),
  }));
  return assemble(ctx, raw, P, R, t0, true);
}

function alternatives(ctx, Pin, Rin) {
  const P = normalizeParams(Pin);
  const opts = PORT_OPTIONS[P.arch];
  const variants = opts.map(p => ({ label: `${p}-port terminals`, P: Object.assign({}, P, { termPorts: p, termSpare: Math.min(P.termSpare, p - 1) }) }));
  const md = (f) => Math.max(10, Math.round((P.maxDrop * f) / 10) * 10);
  variants.push({ label: `Max drop ${md(0.67)} m`, P: Object.assign({}, P, { maxDrop: md(0.67) }) });
  variants.push({ label: `Max drop ${md(1.33)} m`, P: Object.assign({}, P, { maxDrop: md(1.33) }) });
  const rows = variants.map(v => {
    const d = plan(ctx, v.P, Rin);
    const s = d.stats;
    return {
      label: v.label, params: { termPorts: v.P.termPorts, termSpare: v.P.termSpare, maxDrop: v.P.maxDrop },
      current: v.P.termPorts === P.termPorts && v.P.maxDrop === P.maxDrop,
      terminals: s.terminals, closures: s.closures, f2Route: s.f2Route, dropTotal: s.dropTotal, dropAvg: s.dropAvg,
      cost: s.cost, costPerHome: s.costPerHome, fail: s.budget.fail, warn: s.budget.warn,
      worstRx: s.budget.worst ? s.budget.worst.rx : null, portUtil: s.portUtil,
    };
  });
  const ok = rows.filter(r => r.fail === 0);
  const pool = ok.length ? ok : rows;
  let best = pool[0];
  for (const r of pool) if (r.costPerHome < best.costPerHome) best = r;
  if (best) best.best = true;
  return rows;
}

const Engine = {
  DEFAULTS, DEFAULT_RATES, PORT_OPTIONS, CABINET_SIZES, SPLIT_LOSS,
  makeProjector, haversine, ringBBox, bufferBBox, bboxAreaKm2, ringAreaM2, ringPerimeterM, pointInRing, polyCentroid, hullAround,
  overpassQuery, parseOverpass, buildingsToHomes, estimateHomes,
  normalizeParams, normalizeRates, splitterLoss, cableFor, budget, tiaColor, tiaRange,
  prepare, plan, relayout, alternatives, nearestNode,
};
if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
