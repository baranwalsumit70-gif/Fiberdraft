/* FiberDraft — KML/KMZ import, KML/GeoJSON/CSV export and the printable design report. */
(function (root) {
'use strict';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

/* ---------------------------------------------------------------- import */
function childText(el, tag) {
  for (const c of el.children) if (c.localName === tag) return (c.textContent || '').trim();
  return '';
}

function folderPath(el) {
  const names = [];
  let p = el.parentElement;
  while (p) {
    if (p.localName === 'Folder') { const n = childText(p, 'name'); if (n) names.unshift(n); }
    p = p.parentElement;
  }
  return names.join(' / ');
}

function parseCoords(txt) {
  return String(txt || '').trim().replace(/,\s+/g, ',').split(/\s+/)
    .map(t => t.split(',').map(Number))
    .filter(a => a.length >= 2 && isFinite(a[0]) && isFinite(a[1]) && Math.abs(a[1]) <= 90 && Math.abs(a[0]) <= 180)
    .map(a => [a[1], a[0]]);
}

function firstCoords(el) {
  const c = el.getElementsByTagNameNS('*', 'coordinates')[0];
  return c ? parseCoords(c.textContent) : [];
}

function collectGeoms(el, out) {
  for (const c of el.children) {
    const n = c.localName;
    if (n === 'Point') { const cs = firstCoords(c); if (cs.length) out.push({ type: 'Point', coords: cs[0] }); }
    else if (n === 'LineString' || n === 'LinearRing') { const cs = firstCoords(c); if (cs.length >= 2) out.push({ type: 'LineString', coords: cs }); }
    else if (n === 'Polygon') {
      const ob = c.getElementsByTagNameNS('*', 'outerBoundaryIs')[0] || c;
      let cs = firstCoords(ob);
      if (cs.length > 3 && cs[0][0] === cs[cs.length - 1][0] && cs[0][1] === cs[cs.length - 1][1]) cs = cs.slice(0, -1);
      if (cs.length >= 3) out.push({ type: 'Polygon', coords: cs });
    }
    else if (n === 'MultiGeometry' || n === 'MultiTrack') collectGeoms(c, out);
    else if (n === 'Track') {
      const cs = [];
      for (const k of c.children) if (k.localName === 'coord') {
        const a = (k.textContent || '').trim().split(/\s+/).map(Number);
        if (a.length >= 2 && isFinite(a[0]) && isFinite(a[1])) cs.push([a[1], a[0]]);
      }
      if (cs.length >= 2) out.push({ type: 'LineString', coords: cs });
    }
  }
}

function parse(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This file is not valid KML (XML could not be read).');
  const feats = [];
  const pms = doc.getElementsByTagNameNS('*', 'Placemark');
  for (const pm of pms) {
    const name = childText(pm, 'name');
    const folder = folderPath(pm);
    const geoms = [];
    collectGeoms(pm, geoms);
    for (const g of geoms) feats.push({ name, folder, type: g.type, coords: g.coords });
  }
  const docName = (() => { const d = doc.getElementsByTagNameNS('*', 'Document')[0]; return d ? childText(d, 'name') : ''; })();
  return { features: feats, name: docName };
}

async function readFile(file) {
  const name = file.name || 'file';
  if (/\.kmz$/i.test(name)) {
    if (!root.JSZip) throw new Error('KMZ support could not load (no internet?). Unzip the KMZ and import the .kml inside.');
    const zip = await root.JSZip.loadAsync(await file.arrayBuffer());
    const entries = Object.keys(zip.files).filter(f => /\.kml$/i.test(f));
    if (!entries.length) throw new Error('No .kml file found inside this KMZ.');
    const main = entries.find(f => /(^|\/)doc\.kml$/i.test(f)) || entries[0];
    return parse(await zip.file(main).async('string'));
  }
  return parse(await file.text());
}

const ROLE_OPTIONS = {
  Polygon: [['area', 'Service area'], ['homes', 'Homes (polygon centres)'], ['ref', 'Show only'], ['ignore', 'Ignore']],
  Point: [['homes', 'Homes'], ['pfp', 'PFP location'], ['ref', 'Show only'], ['ignore', 'Ignore']],
  LineString: [['routes', 'Cable route paths'], ['ref', 'Show only'], ['ignore', 'Ignore']],
};

function guessRole(type, label) {
  const t = label.toLowerCase();
  if (type === 'Polygon') return /build|house|footprint|bldg|struct|roof/.test(t) ? 'homes' : 'area';
  if (type === 'LineString') return /boundary|border|limit|drop/.test(t) ? 'ref' : 'routes';
  if (/\bpfp\b|\bfdh\b|\bfdc\b|cabinet|\blcp\b|\bhub\b|\bolt\b|exchange/.test(t)) return 'pfp';
  if (/pole|tower|manhole|handhole|\bhh\b|vault|pedestal|closure|joint|\bjc\b|existing|chamber|terminal|\bfat\b|\bfdb\b|\bnap\b|\bmst\b/.test(t)) return 'ref';
  return 'homes';
}

/* Group features by geometry type + folder so the import dialog can assign one role per group. */
function groupFeatures(features) {
  const groups = new Map();
  for (const f of features) {
    const key = f.type + '|' + (f.folder || '');
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key, type: f.type, folder: f.folder || '', features: [] });
    g.features.push(f);
  }
  const out = [...groups.values()];
  for (const g of out) {
    const label = g.folder || g.features.slice(0, 12).map(f => f.name).join(' ');
    g.label = g.folder || (g.type === 'Point' ? 'Points' : g.type === 'LineString' ? 'Lines' : 'Polygons');
    g.role = guessRole(g.type, label);
  }
  const order = { Polygon: 0, Point: 1, LineString: 2 };
  out.sort((a, b) => order[a.type] - order[b.type] || b.features.length - a.features.length);
  return out;
}

/* ---------------------------------------------------------------- export helpers */
function kmlColor(hex, alpha) {
  const h = hex.replace('#', '');
  const a = Math.round((alpha == null ? 1 : alpha) * 255).toString(16).padStart(2, '0');
  return (a + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toLowerCase();
}

const coordStr = (cs) => cs.map(([la, lo]) => `${lo.toFixed(7)},${la.toFixed(7)},0`).join(' ');

function dataBlock(obj) {
  const rows = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return '<ExtendedData>' + rows.map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`).join('') + '</ExtendedData>';
}

function descTable(obj) {
  const rows = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return '<![CDATA[<table style="font:12px sans-serif;border-collapse:collapse">' +
    rows.map(([k, v]) => `<tr><td style="color:#737373;padding:2px 10px 2px 0">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`).join('') + '</table>]]>';
}

function placemark(name, style, geom, attrs, lite) {
  return `<Placemark><name>${esc(name)}</name><styleUrl>#${style}</styleUrl>${lite ? '' : `<description>${descTable(attrs)}</description>`}${dataBlock(attrs)}${geom}</Placemark>`;
}

const pointGeom = (lat, lng) => `<Point><coordinates>${lng.toFixed(7)},${lat.toFixed(7)},0</coordinates></Point>`;
const lineGeom = (cs) => `<LineString><tessellate>1</tessellate><coordinates>${coordStr(cs)}</coordinates></LineString>`;
const polyGeom = (ring) => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coordStr(ring.concat([ring[0]]))}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;

const SIZE_COLOR = (size) => size <= 12 ? '#8ec5ff' : size <= 24 ? '#2b7fff' : size <= 72 ? '#155dfc' : size <= 144 ? '#1447e6' : '#193cb8';
const SIZE_WIDTH = (size) => size <= 12 ? 2.5 : size <= 24 ? 3 : size <= 72 ? 3.5 : size <= 144 ? 4.5 : 5.5;
const STATUS_COLOR = { pass: '#2b7fff', warn: '#f59e0b', fail: '#e7000b', unserved: '#a1a1a1' };

function iconStyle(id, href, color, scale, labelScale) {
  return `<Style id="${id}"><IconStyle><color>${kmlColor(color)}</color><scale>${scale}</scale><Icon><href>${href}</href></Icon></IconStyle><LabelStyle><scale>${labelScale}</scale></LabelStyle></Style>`;
}

function exportKML(design, info) {
  const P = design.params, S = design.stats;
  const homesById = info.homesById;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
  out.push(`<name>${esc(info.title)}</name>`);
  out.push(`<description>${esc(`FiberDraft design, ${new Date().toISOString().slice(0, 10)}. ${S.units} homes, ${S.pfps} PFP, ${S.terminals} terminals, ${S.closures} splice closures, ${Math.round(S.f2Route)} m F2 route, ${Math.round(S.dropTotal)} m drops. ${P.arch === 'cascaded' ? `Cascaded 1:${P.pfpSplit} x 1:${P.termPorts}` : `Centralized 1:${P.pfpSplit} at PFP`}.`)}</description>`);
  const ic = (s) => 'http://maps.google.com/mapfiles/kml/shapes/' + s;
  out.push(iconStyle('pfp', ic('placemark_square.png'), '#0a0a0a', 1.4, 0.9));
  out.push(iconStyle('terminal', ic('triangle.png'), '#2b7fff', 0.9, 0.7));
  out.push(iconStyle('closure', ic('open-diamond.png'), '#ffffff', 0.9, 0.6));
  for (const [k, c] of Object.entries(STATUS_COLOR)) out.push(iconStyle('home-' + k, ic('shaded_dot.png'), c, 0.55, 0));
  for (const size of [...new Set(design.runs.map(r => r.size))]) out.push(`<Style id="f2-${size}"><LineStyle><color>${kmlColor(SIZE_COLOR(size))}</color><width>${SIZE_WIDTH(size)}</width></LineStyle></Style>`);
  out.push(`<Style id="drop"><LineStyle><color>${kmlColor('#ffffff', 0.85)}</color><width>1</width></LineStyle></Style>`);
  out.push(`<Style id="area"><LineStyle><color>${kmlColor('#ffffff')}</color><width>2.5</width></LineStyle><PolyStyle><color>${kmlColor('#0a0a0a', 0.08)}</color></PolyStyle></Style>`);
  out.push(`<Style id="route"><LineStyle><color>${kmlColor('#a1a1a1')}</color><width>2</width></LineStyle></Style>`);
  if (info.boundary) out.push('<Folder><name>Service area</name>' + placemark(info.title, 'area', polyGeom(info.boundary), { 'Area (km²)': r2(info.areaKm2 || 0) }) + '</Folder>');
  out.push('<Folder><name>PFP</name>' + design.pfps.map(p => placemark(p.id, 'pfp', pointGeom(p.lat, p.lng), {
    Type: 'Primary Flexibility Point', Homes: p.units, Terminals: p.terminals, Cabinet: `${p.cabinet}-port`,
    Splitters: `${p.splitters} x 1:${P.pfpSplit}`, 'F2 cables': p.cables.join(', '), 'Worst Rx (dBm)': isFinite(p.worstRx) ? r2(p.worstRx) : '',
  })).join('') + '</Folder>');
  out.push('<Folder><name>Splice closures</name>' + design.closures.map(c => placemark(c.id, 'closure', pointGeom(c.lat, c.lng), {
    PFP: c.pfpId, 'Cable in': c.inCable, 'Cables out': c.outCables.join(', '), Splices: c.splices,
  })).join('') + '</Folder>');
  out.push('<Folder><name>Terminals</name>' + design.terminals.map(t => placemark(t.id, 'terminal', pointGeom(t.lat, t.lng), {
    PFP: t.pfpId, Ports: t.ports, 'Ports used': t.used, 'Homes served': t.buildings, 'Fed by': t.cable || 'PFP stub',
    Fibres: t.fibers || '', 'F2 distance (m)': Math.round(t.f2m), 'Longest drop (m)': Math.round(t.maxDrop), 'Worst Rx (dBm)': t.worstRx != null ? r2(t.worstRx) : '',
  })).join('') + '</Folder>');
  const sizes = [...new Set(design.runs.map(r => r.size))].sort((a, b) => b - a);
  out.push('<Folder><name>F2 cables</name>' + sizes.map(size => `<Folder><name>${size}F</name>` + design.runs.filter(r => r.size === size).map(r => placemark(`${r.id} ${r.count > 1 ? r.count + 'x' : ''}${r.size}F`, 'f2-' + size, lineGeom(r.coords), {
    Cable: r.id, Size: `${r.count > 1 ? r.count + ' x ' : ''}${r.size}F`, 'Fibres used': r.need, 'Route length (m)': Math.round(r.length),
    'Cable length incl. slack (m)': Math.round(r.cableLen), From: r.from, To: r.to, Terminals: r.terminals.join(', '),
  })).join('') + '</Folder>').join('') + '</Folder>');
  out.push('<Folder><name>Drops</name>' + design.drops.map(d => placemark(`Drop ${d.termId}`, 'drop', lineGeom(d.coords), {
    Terminal: d.termId, Home: (homesById[d.homeId] && homesById[d.homeId].label) || d.homeId, 'Routed length (m)': Math.round(d.length), Units: d.units,
  }, true)).join('') + '</Folder>');
  const homeIds = Object.keys(design.homes);
  out.push('<Folder><name>Homes passed</name>' + homeIds.filter(id => design.homes[id].budget).map(id => {
    const h = design.homes[id], src = homesById[id] || {};
    return placemark(src.label || id, 'home-' + h.status, pointGeom(src.lat, src.lng), {
      Terminal: h.termId, Units: h.units, 'Drop (m)': Math.round(h.drop), 'Rx (dBm)': r2(h.budget.rx), 'Margin (dB)': r2(h.budget.margin),
      Budget: h.status, Source: { osm: 'OpenStreetMap building', est: 'Estimated', manual: 'Added by hand', kml: 'Imported KML' }[src.kind] || '',
    }, true);
  }).join('') + '</Folder>');
  const uns = homeIds.filter(id => design.homes[id].status === 'unserved');
  if (uns.length) out.push('<Folder><name>Not served</name>' + uns.map(id => {
    const src = homesById[id] || {};
    return placemark(src.label || id, 'home-unserved', pointGeom(src.lat, src.lng), { Reason: design.homes[id].reason });
  }).join('') + '</Folder>');
  if (info.routes && info.routes.length) out.push('<Folder><name>Imported route paths</name>' + info.routes.map((r, i) => placemark(r.name || `Route ${i + 1}`, 'route', lineGeom(r.coords), {})).join('') + '</Folder>');
  out.push('</Document></kml>');
  return out.join('\n');
}

function exportGeoJSON(design, info) {
  const F = [];
  const pt = (lat, lng) => ({ type: 'Point', coordinates: [r6(lng), r6(lat)] });
  const ln = (cs) => ({ type: 'LineString', coordinates: cs.map(([la, lo]) => [r6(lo), r6(la)]) });
  const r6 = (v) => Math.round(v * 1e7) / 1e7;
  if (info.boundary) F.push({ type: 'Feature', properties: { layer: 'service_area', name: info.title }, geometry: { type: 'Polygon', coordinates: [info.boundary.concat([info.boundary[0]]).map(([la, lo]) => [r6(lo), r6(la)])] } });
  for (const p of design.pfps) F.push({ type: 'Feature', properties: { layer: 'pfp', id: p.id, homes: p.units, terminals: p.terminals, cabinet_ports: p.cabinet, splitters: p.splitters, split_ratio: design.params.pfpSplit }, geometry: pt(p.lat, p.lng) });
  for (const c of design.closures) F.push({ type: 'Feature', properties: { layer: 'splice_closure', id: c.id, pfp: c.pfpId, cable_in: c.inCable, cables_out: c.outCables, splices: c.splices }, geometry: pt(c.lat, c.lng) });
  for (const t of design.terminals) F.push({ type: 'Feature', properties: { layer: 'terminal', id: t.id, pfp: t.pfpId, ports: t.ports, used: t.used, homes: t.buildings, cable: t.cable, fibres: t.fibers, f2_m: Math.round(t.f2m), max_drop_m: Math.round(t.maxDrop), worst_rx_dbm: t.worstRx != null ? r2(t.worstRx) : null }, geometry: pt(t.lat, t.lng) });
  for (const r of design.runs) F.push({ type: 'Feature', properties: { layer: 'f2_cable', id: r.id, pfp: r.pfpId, size_f: r.size, count: r.count, fibres_used: r.need, route_m: Math.round(r.length), cable_m: Math.round(r.cableLen), from: r.from, to: r.to }, geometry: ln(r.coords) });
  for (const d of design.drops) F.push({ type: 'Feature', properties: { layer: 'drop', terminal: d.termId, home: d.homeId, units: d.units, routed_m: Math.round(d.length), status: d.status }, geometry: ln(d.coords) });
  for (const id of Object.keys(design.homes)) {
    const h = design.homes[id], src = info.homesById[id];
    if (!src) continue;
    F.push({ type: 'Feature', properties: { layer: 'home', id, label: src.label || '', units: h.units, terminal: h.termId || null, drop_m: h.drop ? Math.round(h.drop) : null, rx_dbm: h.budget ? r2(h.budget.rx) : null, status: h.status, source: src.kind }, geometry: pt(src.lat, src.lng) });
  }
  return JSON.stringify({ type: 'FeatureCollection', name: info.title, features: F });
}

function csv(headers, rows) {
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + [headers.map(q).join(',')].concat(rows.map(r => r.map(q).join(','))).join('\r\n');
}

function bomCSV(design) {
  const b = design.bom;
  const rows = b.lines.map(l => [l.cat, l.item, l.qty, l.unit, l.rate == null ? '' : l.rate, l.amount == null ? '' : Math.round(l.amount), l.note]);
  rows.push(['', 'Total', '', '', '', Math.round(b.total), '']);
  rows.push(['', 'Cost per home passed', '', '', '', Math.round(design.stats.costPerHome), `${design.stats.units} homes`]);
  return csv(['Category', 'Item', 'Qty', 'Unit', `Rate (${b.currency})`, `Amount (${b.currency})`, 'Note'], rows);
}

function terminalsCSV(design) {
  return csv(['Terminal', 'PFP', 'Latitude', 'Longitude', 'Ports', 'Used', 'Free', 'Homes', 'Fed by', 'Fibres', 'F2 distance (m)', 'Closures on path', 'Longest drop (m)', 'Total drop (m)', 'Worst Rx (dBm)', 'Margin (dB)', 'Budget'],
    design.terminals.map(t => [t.id, t.pfpId, t.lat.toFixed(7), t.lng.toFixed(7), t.ports, t.used, t.free, t.buildings, t.cable || 'PFP stub', t.fibers || '', Math.round(t.f2m), t.closuresOnPath, Math.round(t.maxDrop), Math.round(t.dropTotal), t.worstRx != null ? r2(t.worstRx) : '', t.worstMargin != null ? r2(t.worstMargin) : '', t.status]));
}

function fibersCSV(design) {
  const a = csv(['PFP', 'Location', 'Type', 'Cable', 'Fibres', 'Tube/fibre colour (TIA-598)', 'To', 'To fibres/ports'],
    design.fiberRows.map(r => [r.pfp, r.location, r.type, r.cable, r.fibers, r.colours, r.to, r.toFibers]));
  const b = csv(['PFP', 'Terminal', 'Splitter', 'Splitter outputs', 'F2 cable leaving PFP', 'Fibres', 'Colours'],
    design.pfpRows.map(r => [r.pfp, r.terminal, r.splitter, r.outputs, r.cable, r.fibers, r.colours])).slice(1);
  return a + '\r\n\r\nPFP connection schedule\r\n' + b;
}

function homesCSV(design, homesById) {
  return csv(['Home', 'Label', 'Latitude', 'Longitude', 'Units', 'Source', 'Terminal', 'PFP', 'Drop (m)', 'Total km', 'Loss (dB)', 'Rx (dBm)', 'Margin (dB)', 'Budget'],
    Object.keys(design.homes).map(id => {
      const h = design.homes[id], s = homesById[id] || {};
      return [id, s.label || '', s.lat != null ? s.lat.toFixed(7) : '', s.lng != null ? s.lng.toFixed(7) : '', h.units || 1, s.kind || '', h.termId || '', h.pfpId || '',
        h.drop ? Math.round(h.drop) : '', h.budget ? r2(h.budget.km) : '', h.budget ? r2(h.budget.loss) : '', h.budget ? r2(h.budget.rx) : '', h.budget ? r2(h.budget.margin) : '', h.status];
    }));
}

/* ---------------------------------------------------------------- report */
function schematicSVG(design, info, W, Hh) {
  const pts = [];
  if (info.boundary) pts.push(...info.boundary);
  for (const r of design.runs) pts.push(...r.coords);
  for (const d of design.drops) pts.push(d.coords[1]);
  for (const p of design.pfps) pts.push([p.lat, p.lng]);
  if (!pts.length) return '';
  let s = 90, n = -90, w = 180, e = -180;
  for (const [la, lo] of pts) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  const k = Math.cos(((s + n) / 2) * Math.PI / 180);
  const spanX = (e - w) * k || 1e-6, spanY = (n - s) || 1e-6;
  const pad = 16;
  const sc = Math.min((W - 2 * pad) / spanX, (Hh - 2 * pad) / spanY);
  const ox = (W - spanX * sc) / 2, oy = (Hh - spanY * sc) / 2;
  const X = (lo) => (ox + (lo - w) * k * sc).toFixed(1), Y = (la) => (oy + (n - la) * sc).toFixed(1);
  const path = (cs) => cs.map(([la, lo], i) => (i ? 'L' : 'M') + X(lo) + ' ' + Y(la)).join('');
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hh}" width="100%" role="img" aria-label="Network schematic">`];
  parts.push(`<rect width="${W}" height="${Hh}" fill="#fafafa"/>`);
  if (info.roads) parts.push(`<path d="${info.roads.map(path).join('')}" fill="none" stroke="#e5e5e5" stroke-width="1.2"/>`);
  if (info.boundary) parts.push(`<path d="${path(info.boundary)}Z" fill="none" stroke="#0a0a0a" stroke-width="1" stroke-dasharray="4 3"/>`);
  parts.push(`<path d="${design.drops.map(d => path(d.coords)).join('')}" fill="none" stroke="#8ec5ff" stroke-width="0.6"/>`);
  for (const r of design.runs) parts.push(`<path d="${path(r.coords)}" fill="none" stroke="${SIZE_COLOR(r.size)}" stroke-width="${(SIZE_WIDTH(r.size) * 0.6).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  for (const d of design.drops) { const [la, lo] = d.coords[1]; parts.push(`<circle cx="${X(lo)}" cy="${Y(la)}" r="1.6" fill="${STATUS_COLOR[d.status]}"/>`); }
  for (const c of design.closures) parts.push(`<rect x="${(+X(c.lng) - 3).toFixed(1)}" y="${(+Y(c.lat) - 3).toFixed(1)}" width="6" height="6" transform="rotate(45 ${X(c.lng)} ${Y(c.lat)})" fill="#fff" stroke="#0a0a0a" stroke-width="1.2"/>`);
  for (const t of design.terminals) parts.push(`<circle cx="${X(t.lng)}" cy="${Y(t.lat)}" r="3.2" fill="#0a0a0a" stroke="#fff" stroke-width="1"/><text x="${(+X(t.lng) + 4).toFixed(1)}" y="${(+Y(t.lat) - 4).toFixed(1)}" font-size="6.5" font-family="sans-serif" fill="#404040">${esc(t.id)}</text>`);
  for (const p of design.pfps) parts.push(`<rect x="${(+X(p.lng) - 6).toFixed(1)}" y="${(+Y(p.lat) - 6).toFixed(1)}" width="12" height="12" rx="2" fill="#0a0a0a" stroke="#fff" stroke-width="1.5"/><text x="${(+X(p.lng) + 9).toFixed(1)}" y="${(+Y(p.lat) + 4).toFixed(1)}" font-size="10" font-weight="700" font-family="sans-serif" fill="#0a0a0a">${esc(p.id)}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

function reportHTML(design, info, fmt) {
  const P = design.params, S = design.stats, B = design.bom, bs = S.budget;
  const money = (v) => fmt.money(v);
  const row = (cells, cls) => `<tr${cls ? ` class="${cls}"` : ''}>${cells.map((c, i) => `<td${typeof c === 'number' || /^[-−]?[\d.,]+( ?[%a-zA-Z²]*)?$/.test(String(c)) && i ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`;
  const worst = bs.worst;
  const kv = (pairs) => '<table class="kv">' + pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('') + '</table>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(info.title)}: design report</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap">
<style>
:root{--fg:#0a0a0a;--mut:#737373;--bd:#e5e5e5}
*{box-sizing:border-box}body{margin:0;font:13px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:#fff}
main{max-width:960px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:24px;letter-spacing:-.025em;margin:0 0 4px}h2{font-size:16px;letter-spacing:-.01em;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--bd)}
.mut{color:var(--mut)}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stat{border:1px solid var(--bd);border-radius:10px;padding:10px 12px}
.stat b{display:block;font-size:18px;font-variant-numeric:tabular-nums}.stat span{color:var(--mut);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:5px 8px;border-bottom:1px solid var(--bd);text-align:left;vertical-align:top}
th{font-weight:500;color:var(--mut)}td.n{text-align:right;font-variant-numeric:tabular-nums}tr.tot td{font-weight:600;border-top:1px solid var(--fg)}
.kv th{width:42%}.two{display:grid;grid-template-columns:1fr 1fr;gap:24px}.svg{border:1px solid var(--bd);border-radius:10px;overflow:hidden}
.bar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--bd);margin:6px 0}.bar i{display:block}
.tools{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--bd);padding:10px 24px;display:flex;gap:8px;justify-content:flex-end}
button{font:inherit;font-weight:500;border:1px solid var(--bd);background:#fff;border-radius:8px;height:32px;padding:0 12px;cursor:pointer}button.p{background:#0a0a0a;color:#fff;border-color:#0a0a0a}
@media (max-width:700px){.grid{grid-template-columns:repeat(2,1fr)}.two{grid-template-columns:1fr}}
@media print{.tools{display:none}main{padding:0}h2{break-after:avoid}table{page-break-inside:auto}tr{break-inside:avoid}}
</style></head><body>
<div class="tools"><button onclick="window.close()">Close</button><button class="p" onclick="window.print()">Print or save as PDF</button></div>
<main>
<h1>${esc(info.title)}</h1>
<div class="mut">FiberDraft design report · ${new Date().toLocaleString()} · ${P.arch === 'cascaded' ? `Cascaded split 1:${P.pfpSplit} at PFP × 1:${P.termPorts} in terminal` : `Centralized split 1:${P.pfpSplit} at PFP`}${design.mode === 'straight' ? ' · straight-line routing (no streets loaded)' : ''}</div>
<h2>Summary</h2>
<div class="grid">
<div class="stat"><span>Homes passed</span><b>${fmt.int(S.units)}</b><span>${fmt.int(S.buildings)} buildings</span></div>
<div class="stat"><span>Terminals</span><b>${fmt.int(S.terminals)}</b><span>${P.termPorts}-port, ${Math.round(S.portUtil * 100)}% ports used</span></div>
<div class="stat"><span>F2 route</span><b>${fmt.dist(S.f2Route)}</b><span>${fmt.dist(S.f2Cable)} cable incl. slack</span></div>
<div class="stat"><span>Estimated cost</span><b>${money(S.cost)}</b><span>${money(S.costPerHome)} per home</span></div>
<div class="stat"><span>PFPs</span><b>${S.pfps}</b><span>${S.closures} splice closures</span></div>
<div class="stat"><span>Drop cable</span><b>${fmt.dist(S.dropTotal)}</b><span>avg ${Math.round(S.dropAvg)} m, max ${Math.round(S.dropMax)} m</span></div>
<div class="stat"><span>Worst Rx</span><b>${worst ? worst.rx.toFixed(1) + ' dBm' : '–'}</b><span>${worst ? worst.margin.toFixed(1) + ' dB margin' : ''}</span></div>
<div class="stat"><span>Budget</span><b>${bs.fail ? bs.fail + ' fail' : bs.warn ? bs.warn + ' low margin' : 'All pass'}</b><span>${bs.pass} pass · ${bs.warn} warn · ${bs.fail} fail</span></div>
</div>
<h2>Network schematic</h2>
<div class="svg">${schematicSVG(design, info, 920, 560)}</div>
<p class="mut">Black squares are PFPs, black dots terminals, diamonds splice closures. F2 cables are shaded by size (darker = more fibres); light lines are drops.</p>
<div class="two">
<div><h2>Design rules</h2>${kv([
  ['Split architecture', P.arch === 'cascaded' ? `Cascaded 1:${P.pfpSplit} × 1:${P.termPorts}` : `Centralized 1:${P.pfpSplit}`],
  ['Homes per PFP (max)', P.pfpMaxHomes], ['Terminal ports / spare', `${P.termPorts} / ${P.termSpare}`], ['Max drop length', `${P.maxDrop} m`],
  ['F2 cable sizes', P.cableSizes.map(s => s + 'F').join(', ')], ['Spare fibre', `${P.fiberSpare}%`], ['Cable slack', `${P.cableSlack}%`],
  ['Construction', P.method === 'mixed' ? `Mixed, ${P.aerialShare}% aerial` : P.method === 'aerial' ? 'Aerial' : 'Underground'],
])}</div>
<div><h2>Optical budget</h2>${kv([
  ['OLT launch power', `${P.txPower} dBm`], ['ONT sensitivity', `${P.rxSens} dBm`], ['Required margin', `${P.safety} dB`],
  ['Fibre loss', `${P.att} dB/km`], ['Splice / connector loss', `${P.spliceLoss} / ${P.connLoss} dB`], ['Feeder (OLT → PFP)', `${P.feederKm} km, ${P.feederSplices} splices`],
  ['Worst path', worst ? `${(info.homesById[worst.homeId] && info.homesById[worst.homeId].label) || 'Home'} via ${worst.termId}: ${worst.km.toFixed(2)} km, ${worst.loss.toFixed(1)} dB loss` : '–'],
  ['Worst Rx / margin', worst ? `${worst.rx.toFixed(2)} dBm / ${worst.margin.toFixed(2)} dB` : '–'],
])}</div>
</div>
<h2>Bill of materials</h2>
<table><thead><tr><th>Category</th><th>Item</th><th class="n">Qty</th><th>Unit</th><th class="n">Rate</th><th class="n">Amount</th><th>Note</th></tr></thead><tbody>
${B.lines.map(l => `<tr><td>${esc(l.cat)}</td><td>${esc(l.item)}</td><td class="n">${fmt.int(l.qty)}</td><td>${esc(l.unit)}</td><td class="n">${l.rate == null ? '–' : esc(fmt.num(l.rate))}</td><td class="n">${l.amount == null ? 'unpriced' : esc(money(l.amount))}</td><td class="mut">${esc(l.note)}</td></tr>`).join('')}
<tr class="tot"><td></td><td>Total</td><td></td><td></td><td></td><td class="n">${esc(money(B.total))}</td><td class="mut">${esc(money(S.costPerHome))} per home</td></tr>
</tbody></table>
<p class="mut">Rates are the planner's rate card at the time of export. Quantities include the slack percentages above.</p>
<h2>Terminal schedule</h2>
<table><thead><tr><th>Terminal</th><th>PFP</th><th class="n">Used / ports</th><th class="n">Homes</th><th>Fed by</th><th class="n">F2 m</th><th class="n">Max drop m</th><th class="n">Worst Rx</th></tr></thead><tbody>
${design.terminals.map(t => `<tr><td>${esc(t.id)}</td><td>${esc(t.pfpId)}</td><td class="n">${t.used} / ${t.ports}</td><td class="n">${t.buildings}</td><td>${esc(t.fibers || t.cable || 'PFP stub')}</td><td class="n">${Math.round(t.f2m)}</td><td class="n">${Math.round(t.maxDrop)}</td><td class="n">${t.worstRx != null ? t.worstRx.toFixed(1) : '–'}</td></tr>`).join('')}
</tbody></table>
<h2>F2 cables</h2>
<table><thead><tr><th>Cable</th><th>PFP</th><th class="n">Size</th><th class="n">Fibres used</th><th class="n">Route m</th><th>From → to</th></tr></thead><tbody>
${design.runs.map(r => `<tr><td>${esc(r.id)}</td><td>${esc(r.pfpId)}</td><td class="n">${r.count > 1 ? r.count + '×' : ''}${r.size}F</td><td class="n">${r.need}</td><td class="n">${Math.round(r.length)}</td><td>${esc(r.from)} → ${esc(r.to)}</td></tr>`).join('')}
</tbody></table>
${design.issues.length ? `<h2>Issues</h2><ul>${design.issues.map(i => `<li><b>${esc(i.level === 'error' ? 'Error' : i.level === 'warn' ? 'Warning' : 'Note')}:</b> ${esc(i.text)}</li>`).join('')}</ul>` : ''}
<p class="mut" style="margin-top:32px">Street and building data © OpenStreetMap contributors (ODbL). Designs are planning drafts: verify routes, pole/duct availability and permits in the field.</p>
</main></body></html>`;
}

const KML = { parse, readFile, groupFeatures, ROLE_OPTIONS, exportKML, exportGeoJSON, csv, bomCSV, terminalsCSV, fibersCSV, homesCSV, reportHTML, schematicSVG, esc };
if (typeof module !== 'undefined' && module.exports) module.exports = KML;
else root.KML = KML;
})(typeof window !== 'undefined' ? window : globalThis);
