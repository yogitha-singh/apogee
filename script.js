/* ============ APOGEE v3.1 — MAIN SCRIPT ============ */
/* Live satellite tracker using satellite.js + Leaflet.
   Tiles: Esri Dark Gray Canvas (free, no API key)
   TLE Data: CelesTrak (free, no API key)
   Search: CelesTrak NAME / CATNR endpoints → covers the full catalog */

const state = {
  sats: [],
  ids: new Set(),
  selected: null,
  following: false,
  flyUntil: 0,
  groundTrackOn: false,
  groundTrackLine: null,
  observer: null,
  map: null,
  updateInterval: null,
  loadedGroups: new Set()
};

const TRAIL_LENGTH = 30;
const UPDATE_MS = 1000;
const MAX_MARKERS = 500;
const MAX_PER_GROUP = 150;
const ISS_NORAD = 25544;

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SAT_COLORS = [
  '#4cc9f0', '#8b7cff', '#3ddc97', '#ff5d8f', '#fbbf24',
  '#22d3ee', '#f472b6', '#34d399', '#818cf8', '#fb923c'
];

/* One-click suggestions shown when the search box is focused */
const POPULAR = [
  { name: 'ISS (ZARYA)', sub: 'International Space Station', id: 25544 },
  { name: 'HUBBLE (HST)', sub: 'Space telescope', id: 20580 },
  { name: 'CSS (TIANHE)', sub: 'Tiangong space station', id: 48274 },
  { name: 'TERRA', sub: 'NASA Earth observation', id: 25994 },
  { name: 'LANDSAT 9', sub: 'NASA / USGS imaging', id: 49260 },
  { name: 'SENTINEL-2A', sub: 'ESA Copernicus', id: 40697 },
  { name: 'NOAA 20', sub: 'Weather satellite', id: 43013 },
  { name: 'STARLINK', sub: 'Search the Starlink fleet', query: 'STARLINK' }
];

/* ---------- OPERATOR DETECTION ---------- */
function detectOperator(name) {
  const n = name.toUpperCase();
  if (n.startsWith('STARLINK')) return 'SpaceX';
  if (n.startsWith('ONEWEB')) return 'OneWeb';
  if (n.startsWith('IRIDIUM')) return 'Iridium';
  if (n.startsWith('GLOBALSTAR')) return 'Globalstar';
  if (n.startsWith('GPS') || n.startsWith('NAVSTAR')) return 'USAF';
  if (n.startsWith('GALILEO')) return 'ESA';
  if (n.startsWith('GLONASS') || n.startsWith('COSMOS')) return 'Russia';
  if (n.startsWith('BEIDOU')) return 'China';
  if (n.startsWith('NOAA')) return 'NOAA';
  if (n.startsWith('METEOSAT')) return 'EUMETSAT';
  if (n.startsWith('GOES')) return 'NASA/NOAA';
  if (n.startsWith('ISS') || n.includes('ZARYA')) return 'International';
  if (n.startsWith('HST') || n.startsWith('HUBBLE')) return 'NASA/ESA';
  if (n.startsWith('AQUA') || n.startsWith('TERRA')) return 'NASA';
  if (n.startsWith('SENTINEL')) return 'ESA';
  if (n.startsWith('LANDSAT')) return 'NASA/USGS';
  if (n.startsWith('TIANGONG') || n.startsWith('CSS') || n.startsWith('TIANHE')) return 'China';
  if (n.startsWith('SOYUZ') || n.startsWith('PROGRESS')) return 'Russia';
  if (n.startsWith('DRAGON') || n.startsWith('CREW')) return 'SpaceX';
  if (n.startsWith('CYGNUS')) return 'Northrop';
  if (n.startsWith('AMSAT') || n.startsWith('OSCAR') || n.startsWith('FOX-')) return 'Amateur';
  return 'Unknown';
}

/* ---------- TOAST ---------- */
let toastTimer;
function toast(msg, type = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', type === 'error');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), type === 'error' ? 4000 : 2200);
}

/* ---------- CLOCK ---------- */
function updateClock() {
  const now = new Date();
  const utc = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
  $('utcClock').textContent = utc;
  $('lastUpdate').textContent = utc;
}

/* ---------- STARFIELD ---------- */
function initStarfield() {
  const canvas = $('starfield');
  const ctx = canvas.getContext('2d');
  let stars = [];
  let w, h;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    stars = [];
    const count = Math.min(260, Math.floor((w * h) / 9000));
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * w, y: Math.random() * h,
        r: Math.random() * 1.2 + 0.2, alpha: Math.random() * 0.6 + 0.25,
        twinkleSpeed: Math.random() * 0.02 + 0.005, phase: Math.random() * Math.PI * 2
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    stars.forEach((s) => {
      s.phase += s.twinkleSpeed;
      const twinkle = 0.6 + Math.sin(s.phase) * 0.4;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${s.alpha * twinkle})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }

  resize();
  window.addEventListener('resize', resize);
  draw();
}

/* ---------- MAP ---------- */
function initMap() {
  state.map = L.map('map', {
    center: [20, 0],
    zoom: 3,
    zoomControl: false,
    worldCopyJump: true,
    attributionControl: false /* credited in the status bar */
  });

  L.control.zoom({ position: 'bottomright' }).addTo(state.map);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri',
    maxZoom: 16
  }).addTo(state.map);

  state.map.on('moveend', updateMapCenter);
  /* Dragging the map manually stops follow mode */
  state.map.on('dragstart', () => setFollowing(false));
  updateMapCenter();
}

function updateMapCenter() {
  const c = state.map.getCenter().wrap();
  const latStr = `${Math.abs(c.lat).toFixed(2)}° ${c.lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(c.lng).toFixed(2)}° ${c.lng >= 0 ? 'E' : 'W'}`;
  $('mapCenter').textContent = `${latStr}, ${lonStr}`;
}

function flyToSat(sat, zoom = 4) {
  if (!sat || !sat.lastPos) return;
  state.flyUntil = Date.now() + 1400;
  state.map.flyTo([sat.lastPos.lat, sat.lastPos.lon], zoom, { duration: 1.2 });
}

/* ---------- TLE FETCHING ---------- */
async function fetchTLEGroup(group) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${group}`);
  return parseTLEs(await res.text());
}

/* Full-catalog lookup. NAME does a substring match across every
   object CelesTrak tracks; a pure number is treated as a NORAD ID. */
const catalogCache = new Map();
async function fetchCatalog(query) {
  const q = query.trim();
  const key = q.toUpperCase();
  if (catalogCache.has(key)) return catalogCache.get(key);

  const isId = /^\d{1,9}$/.test(q);
  const url = `https://celestrak.org/NORAD/elements/gp.php?${isId ? 'CATNR' : 'NAME'}=${encodeURIComponent(q)}&FORMAT=tle`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CelesTrak returned ${res.status}`);
  const sats = parseTLEs(await res.text());
  catalogCache.set(key, sats);
  return sats;
}

function parseTLEs(text) {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const sats = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i];
    const tle1 = lines[i + 1];
    const tle2 = lines[i + 2];
    if (!name || !tle1 || !tle2) continue;
    if (!tle1.startsWith('1 ') || !tle2.startsWith('2 ')) continue;
    sats.push({ name, tle1, tle2, noradId: parseInt(tle1.substring(2, 7), 10) });
  }
  return sats;
}

/* ---------- SATELLITE BUILDER ---------- */
function buildSatellite(meta, color) {
  try {
    const satrec = satellite.twoline2satrec(meta.tle1, meta.tle2);
    return {
      meta: {
        ...meta,
        color,
        operator: meta.operator || detectOperator(meta.name),
        isISS: meta.noradId === ISS_NORAD
      },
      satrec,
      marker: null,
      trail: [],
      trailLine: null,
      lastPos: null,
      altEl: null
    };
  } catch (e) {
    return null;
  }
}

function addSatelliteToMap(sat) {
  const marker = L.marker([0, 0], {
    icon: L.divIcon({
      className: 'sat-marker',
      html: `<div class="sat-marker-inner ${sat.meta.isISS ? 'iss' : ''}" style="color:${sat.meta.color}"></div>`,
      iconSize: [10, 10],
      iconAnchor: [5, 5]
    }),
    zIndexOffset: sat.meta.isISS ? 1000 : 0
  }).addTo(state.map);

  marker.on('click', () => selectSatellite(sat));
  sat.marker = marker;

  sat.trailLine = L.polyline([], {
    color: sat.meta.color, weight: 1, opacity: 0.4, smoothFactor: 1
  }).addTo(state.map);
}

/* Registers a satellite once (dedupes by NORAD ID). Returns the sat or null. */
function registerSatellite(meta, color, { front = false } = {}) {
  if (state.ids.has(meta.noradId)) return null;
  const sat = buildSatellite({ ...meta, operator: detectOperator(meta.name) }, color);
  if (!sat) return null;
  state.ids.add(meta.noradId);
  if (front) state.sats.unshift(sat); else state.sats.push(sat);
  addSatelliteToMap(sat);
  return sat;
}

function updateStats() {
  $('satCount').textContent = state.sats.length;
  $('listCount').textContent = state.sats.length;
}

/* ---------- INIT DEFAULT ---------- */
function initDefaultSatellites() {
  if (typeof SATELLITES === 'undefined') {
    console.error('data.js not loaded');
    return;
  }
  SATELLITES.forEach((meta) => {
    const sat = buildSatellite(meta, meta.color);
    if (!sat || state.ids.has(meta.noradId)) return;
    state.ids.add(meta.noradId);
    state.sats.push(sat);
    addSatelliteToMap(sat);
  });
  updateStats();
  renderSatList();
}

/* ---------- LOAD LIVE CONSTELLATION ---------- */
async function loadGroup(group) {
  if (state.loadedGroups.has(group)) return;
  state.loadedGroups.add(group);

  const btn = document.querySelector(`[data-group="${group}"]`);
  const countEl = btn && btn.querySelector('.chip-count');
  if (btn) {
    btn.disabled = true;
    btn.classList.remove('failed');
    countEl.textContent = 'Loading…';
  }

  try {
    const sats = await fetchTLEGroup(group);
    let added = 0;
    let colorIdx = 0;

    for (const meta of sats) {
      if (state.sats.length >= MAX_MARKERS || added >= MAX_PER_GROUP) break;
      const color = SAT_COLORS[colorIdx % SAT_COLORS.length];
      colorIdx++;
      if (registerSatellite(meta, color)) added++;
    }

    updateStats();
    renderSatList();

    if (btn) {
      btn.disabled = false;
      btn.classList.add('loaded');
      countEl.textContent = `✓ ${added}`;
    }
    if (added === 0) toast('Nothing new to add — the map is at its limit or these are already loaded.');
  } catch (e) {
    console.error(e);
    state.loadedGroups.delete(group);
    if (btn) {
      btn.disabled = false;
      btn.classList.add('failed');
      countEl.textContent = 'Retry';
    }
    toast('Couldn’t reach CelesTrak. Check your connection and try again.', 'error');
  }
}

/* ---------- SEARCH (tracked + full catalog) ---------- */
let searchItems = [];
let searchSeq = 0;
let searchTimer = null;
let hlIndex = -1;

function localMatches(q) {
  const s = q.toLowerCase();
  return state.sats
    .filter((x) => x.meta.name.toLowerCase().includes(s) || String(x.meta.noradId) === s)
    .slice(0, 5);
}

function openResults() {
  $('searchResults').hidden = false;
  $('searchInput').setAttribute('aria-expanded', 'true');
}
function closeResults() {
  $('searchResults').hidden = true;
  $('searchInput').setAttribute('aria-expanded', 'false');
  hlIndex = -1;
}

function paintResults({ q = '', local = [], remote = null, loading = false, error = null }) {
  searchItems = [];
  let html = '';

  const row = (item) => {
    const i = searchItems.push(item) - 1;
    return `<button class="result" role="option" type="button" data-i="${i}">
      <span class="sat-dot" style="color:${item.color || 'var(--accent)'}"></span>
      <span class="result-main">
        <span class="result-name">${esc(item.name)}</span>
        <span class="result-sub">${esc(item.sub)}</span>
      </span>
      <span class="result-action ${item.kind === 'local' ? 'muted' : ''}">${item.action}</span>
    </button>`;
  };

  if (!q) {
    html += '<div class="result-heading">Popular — click to add</div>';
    POPULAR.forEach((p) => {
      const tracked = p.id && state.ids.has(p.id);
      html += row({
        kind: p.query ? 'search' : 'popular', name: p.name, sub: p.sub,
        id: p.id, query: p.query, action: p.query ? 'Search' : tracked ? 'Show' : 'Add'
      });
    });
    html += '<div class="search-note">Or type any satellite name or NORAD ID to search the full catalog.</div>';
  } else {
    if (local.length) {
      html += '<div class="result-heading">On the map</div>';
      local.forEach((s) => {
        html += row({
          kind: 'local', sat: s, color: s.meta.color, name: s.meta.name,
          sub: `#${s.meta.noradId} · ${s.meta.operator}`, action: 'Show'
        });
      });
    }

    if (remote) {
      const fresh = remote.filter((m) => !state.ids.has(m.noradId));
      const sU = q.toUpperCase();
      fresh.sort((a, b) => {
        const ra = a.name.toUpperCase().startsWith(sU) ? 0 : 1;
        const rb = b.name.toUpperCase().startsWith(sU) ? 0 : 1;
        return ra - rb || a.name.localeCompare(b.name);
      });
      if (fresh.length) {
        html += '<div class="result-heading">Add from catalog</div>';
        fresh.slice(0, 15).forEach((m) => {
          html += row({
            kind: 'remote', meta: m, name: m.name,
            sub: `#${m.noradId} · ${detectOperator(m.name)}`, action: 'Add'
          });
        });
        if (fresh.length > 15) {
          html += `<div class="search-note">Showing 15 of ${fresh.length}. Keep typing to narrow it down.</div>`;
        }
      } else if (!local.length) {
        html += `<div class="search-note">No satellites match “${esc(q)}”. Try another name or a NORAD ID.</div>`;
      }
    } else if (loading) {
      html += '<div class="search-note"><span class="spinner"></span>Searching the catalog…</div>';
    } else if (error) {
      html += `<div class="search-note">Couldn’t reach CelesTrak (${esc(error)}). Check your connection and try again.</div>`;
    } else if (!local.length) {
      html += '<div class="search-note">Keep typing to search the full catalog.</div>';
    }
  }

  const box = $('searchResults');
  box.innerHTML = html;
  hlIndex = -1;
  openResults();
}

function onSearchInput() {
  const q = $('searchInput').value.trim();
  $('searchClear').hidden = !q;
  clearTimeout(searchTimer);
  const seq = ++searchSeq;

  if (!q) { paintResults({}); return; }

  const local = localMatches(q);
  const isId = /^\d+$/.test(q);

  if (q.length < 2 && !isId) { paintResults({ q, local }); return; }

  paintResults({ q, local, loading: true });
  searchTimer = setTimeout(async () => {
    try {
      const remote = await fetchCatalog(q);
      if (seq !== searchSeq) return;
      paintResults({ q, local, remote });
    } catch (e) {
      if (seq !== searchSeq) return;
      paintResults({ q, local, error: e.message });
    }
  }, 300);
}

async function activateItem(item) {
  closeResults();
  $('searchInput').value = '';
  $('searchClear').hidden = true;
  $('searchInput').blur();

  if (item.kind === 'local') { selectSatellite(item.sat); return; }
  if (item.kind === 'remote') { addAndSelect(item.meta); return; }

  if (item.kind === 'popular') {
    const existing = state.sats.find((s) => s.meta.noradId === item.id);
    if (existing) { selectSatellite(existing); return; }
    toast(`Loading ${item.name}…`);
    try {
      const list = await fetchCatalog(String(item.id));
      if (!list.length) throw new Error('empty');
      addAndSelect(list[0]);
    } catch (e) {
      toast(`Couldn’t load ${item.name}. Try searching for it by name.`, 'error');
    }
    return;
  }

  if (item.kind === 'search') {
    const input = $('searchInput');
    input.value = item.query;
    input.focus();
    onSearchInput();
  }
}

function addAndSelect(meta) {
  const existing = state.sats.find((s) => s.meta.noradId === meta.noradId);
  if (existing) { selectSatellite(existing); return; }

  const color = SAT_COLORS[state.sats.length % SAT_COLORS.length];
  const sat = registerSatellite(meta, color, { front: true });
  if (!sat) { toast(`Couldn’t add ${meta.name}. Its orbit data looks invalid.`, 'error'); return; }

  updateStats();
  renderSatList();
  /* compute first position right away so we can fly to it */
  const pos = propagate(sat);
  if (pos) { sat.lastPos = pos; sat.marker.setLatLng([pos.lat, pos.lon]); }
  selectSatellite(sat);
  toast(`${meta.name} added`);
}

function moveHighlight(dir) {
  const rows = $('searchResults').querySelectorAll('.result');
  if (!rows.length) return;
  hlIndex = (hlIndex + dir + rows.length) % rows.length;
  rows.forEach((r, i) => r.classList.toggle('hl', i === hlIndex));
  rows[hlIndex].scrollIntoView({ block: 'nearest' });
}

/* ---------- RENDER LIST ---------- */
function renderSatList() {
  const list = $('satList');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();

  state.sats.forEach((sat) => {
    const item = document.createElement('div');
    item.className = 'sat-item' + (state.selected === sat ? ' active' : '');
    item.dataset.norad = sat.meta.noradId;
    item.innerHTML = `
      <span class="sat-dot" style="color:${sat.meta.color}"></span>
      <div class="sat-info">
        <div class="sat-name">${esc(sat.meta.name)}</div>
        <div class="sat-meta">${esc(sat.meta.operator)} · #${sat.meta.noradId}</div>
      </div>
      <div class="sat-alt">${sat.lastPos ? sat.lastPos.alt.toFixed(0) + ' km' : '—'}</div>
    `;
    item.addEventListener('click', () => selectSatellite(sat));
    sat.altEl = item.querySelector('.sat-alt');
    frag.appendChild(item);
  });

  list.appendChild(frag);
}

/* ---------- PROPAGATION ---------- */
function propagate(sat, date = new Date()) {
  const pv = satellite.propagate(sat.satrec, date);
  if (!pv || !pv.position) return null;

  const gmst = satellite.gstime(date);
  const gd = satellite.eciToGeodetic(pv.position, gmst);

  return {
    lat: satellite.degreesLat(gd.latitude),
    lon: satellite.degreesLong(gd.longitude),
    alt: gd.height,
    vel: Math.sqrt(pv.velocity.x ** 2 + pv.velocity.y ** 2 + pv.velocity.z ** 2),
    period: (2 * Math.PI) / sat.satrec.no,
    inclination: sat.satrec.inclo * (180 / Math.PI)
  };
}

/* ---------- UPDATE LOOP ---------- */
function updateAll() {
  const now = new Date();

  state.sats.forEach((sat) => {
    const pos = propagate(sat, now);
    if (!pos) return;

    sat.lastPos = pos;
    const latlng = [pos.lat, pos.lon];
    sat.marker.setLatLng(latlng);

    if (state.sats.length <= 50 || sat.meta.isISS || state.selected === sat) {
      sat.trail.push(latlng);
      if (sat.trail.length > TRAIL_LENGTH) sat.trail.shift();
      sat.trailLine.setLatLngs(sat.trail);
    }

    if (sat.altEl) sat.altEl.textContent = `${pos.alt.toFixed(0)} km`;
  });

  if (state.selected) {
    updateDetailPanel(state.selected);
    if (state.following && state.selected.lastPos && Date.now() > state.flyUntil) {
      state.map.setView([state.selected.lastPos.lat, state.selected.lastPos.lon], state.map.getZoom(), { animate: false });
    }
  }
  if (state.groundTrackOn) updateGroundTrack(now);

  updateClock();
}

/* ---------- SELECT ---------- */
function selectSatellite(sat) {
  state.selected = sat;

  let activeEl = null;
  document.querySelectorAll('.sat-item').forEach((el) => {
    const on = Number(el.dataset.norad) === sat.meta.noradId;
    el.classList.toggle('active', on);
    if (on) activeEl = el;
  });
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });

  $('detailPanel').hidden = false;
  $('detailName').textContent = sat.meta.name;
  $('detailOperator').textContent = sat.meta.operator;
  $('detailNorad').textContent = `#${sat.meta.noradId}`;
  $('detailDot').style.background = sat.meta.color;

  updateDetailPanel(sat);
  flyToSat(sat);
  if (state.groundTrackOn) updateGroundTrack(new Date());
}

function clearSelection() {
  $('detailPanel').hidden = true;
  state.selected = null;
  setFollowing(false);
  document.querySelectorAll('.sat-item').forEach((el) => el.classList.remove('active'));
}

function setFollowing(on) {
  state.following = on;
  const btn = $('trackBtn');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  $('trackLabel').textContent = on ? 'Following' : 'Follow';
}

function updateDetailPanel(sat) {
  const pos = sat.lastPos;
  if (!pos) return;

  $('dAlt').textContent = pos.alt.toFixed(1);
  $('dVel').textContent = pos.vel.toFixed(2);
  $('dLat').textContent = `${Math.abs(pos.lat).toFixed(2)}° ${pos.lat >= 0 ? 'N' : 'S'}`;
  $('dLon').textContent = `${Math.abs(pos.lon).toFixed(2)}° ${pos.lon >= 0 ? 'E' : 'W'}`;
  $('dPeriod').textContent = pos.period.toFixed(1);
  $('dInc').textContent = pos.inclination.toFixed(2);
}

/* ---------- GROUND TRACK (follows the selected satellite, else the ISS) ---------- */
function groundTrackTarget() {
  return state.selected || state.sats.find((s) => s.meta.isISS) || state.sats[0];
}

function updateGroundTrack(now) {
  const target = groundTrackTarget();
  if (!target) return;

  /* Split at the antimeridian so lines don't streak across the whole map */
  const segments = [];
  let seg = [];
  let prevLon = null;
  for (let i = 0; i <= 90; i++) {
    const t = new Date(now.getTime() + i * 60000);
    const pos = propagate(target, t);
    if (!pos) continue;
    if (prevLon !== null && Math.abs(pos.lon - prevLon) > 180) { segments.push(seg); seg = []; }
    seg.push([pos.lat, pos.lon]);
    prevLon = pos.lon;
  }
  segments.push(seg);

  if (!state.groundTrackLine) {
    state.groundTrackLine = L.polyline(segments, {
      color: target.meta.color, weight: 1.5, opacity: 0.6, dashArray: '6, 8'
    }).addTo(state.map);
  } else {
    state.groundTrackLine.setLatLngs(segments);
    state.groundTrackLine.setStyle({ color: target.meta.color });
  }
}

/* ---------- PASS PREDICTION ---------- */
function predictNextPass(observer) {
  const iss = state.sats.find((s) => s.meta.isISS);
  if (!iss) return null;

  const observerGd = {
    latitude: observer.lat * Math.PI / 180,
    longitude: observer.lon * Math.PI / 180,
    height: 0.1
  };

  const now = new Date();
  let inPass = false, passStart = null, maxEl = 0, passPeak = null;

  for (let i = 0; i < 24 * 60; i++) {
    const t = new Date(now.getTime() + i * 60000);
    const pv = satellite.propagate(iss.satrec, t);
    if (!pv || !pv.position) continue;

    const gmst = satellite.gstime(t);
    const posEcf = satellite.eciToEcf(pv.position, gmst);
    const look = satellite.ecfToLookAngles(observerGd, posEcf);
    const elDeg = look.elevation * 180 / Math.PI;

    if (elDeg > 10 && !inPass) {
      inPass = true; passStart = t; maxEl = elDeg; passPeak = t;
    } else if (inPass && elDeg > maxEl) {
      maxEl = elDeg; passPeak = t;
    } else if (inPass && elDeg < 10) {
      return {
        start: passStart, peak: passPeak, end: t,
        maxElevation: maxEl,
        duration: Math.round((t - passStart) / 60000)
      };
    }
  }
  return null;
}

function renderPass(pass) {
  const body = $('passBody');
  if (!pass) {
    body.innerHTML = '<p class="widget-hint">No pass in the next 24 hours. Check back later.</p>';
    return;
  }

  const updateCountdown = () => {
    const diff = pass.start.getTime() - Date.now();
    if (diff < 0) {
      body.innerHTML = '<p class="widget-hint">The ISS is passing over you now. Look up!</p>';
      clearInterval(window._passInterval);
      return;
    }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);

    body.innerHTML = `
      <div class="pass-countdown">${pad(h)}:${pad(m)}:${pad(s)}</div>
      <div class="pass-detail"><span>Max elevation</span><span>${pass.maxElevation.toFixed(0)}°</span></div>
      <div class="pass-detail"><span>Duration</span><span>${pass.duration} min</span></div>
      <div class="pass-detail"><span>Starts (UTC)</span><span>${pad(pass.start.getUTCHours())}:${pad(pass.start.getUTCMinutes())}</span></div>
    `;
  };

  updateCountdown();
  if (window._passInterval) clearInterval(window._passInterval);
  window._passInterval = setInterval(updateCountdown, 1000);
}

/* ---------- EVENTS ---------- */
function bindEvents() {
  $('closeDetail').addEventListener('click', clearSelection);

  $('trackBtn').addEventListener('click', () => {
    if (!state.selected) return;
    const on = !state.following;
    setFollowing(on);
    if (on) flyToSat(state.selected);
  });

  $('celestrakBtn').addEventListener('click', () => {
    if (state.selected) window.open(`https://www.n2yo.com/satellite/?s=${state.selected.meta.noradId}`, '_blank', 'noopener');
  });

  $('groundToggle').addEventListener('click', () => {
    state.groundTrackOn = !state.groundTrackOn;
    $('groundToggle').classList.toggle('active', state.groundTrackOn);
    $('groundToggle').setAttribute('aria-pressed', String(state.groundTrackOn));

    if (!state.groundTrackOn && state.groundTrackLine) {
      state.map.removeLayer(state.groundTrackLine);
      state.groundTrackLine = null;
    } else if (state.groundTrackOn) {
      updateGroundTrack(new Date());
    }
  });

  $('locBtn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      $('passBody').innerHTML = '<p class="widget-hint">Your browser doesn’t support location.</p>';
      return;
    }
    $('passBody').innerHTML = '<p class="widget-hint"><span class="spinner"></span>Finding your location…</p>';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.observer = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        renderPass(predictNextPass(state.observer));
        state.map.flyTo([state.observer.lat, state.observer.lon], 5, { duration: 1.5 });
      },
      () => {
        $('passBody').innerHTML = '<p class="widget-hint">Location access was denied. Allow it in your browser to see passes.</p>';
      }
    );
  });

  $('sidebarToggle').addEventListener('click', () => {
    const collapsed = $('sidebar').classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-collapsed', collapsed);
  });

  /* Search */
  const input = $('searchInput');
  input.addEventListener('input', onSearchInput);
  input.addEventListener('focus', onSearchInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const idx = hlIndex >= 0 ? hlIndex : 0;
      if (searchItems[idx]) activateItem(searchItems[idx]);
    }
  });
  $('searchClear').addEventListener('click', () => {
    input.value = '';
    $('searchClear').hidden = true;
    input.focus();
    onSearchInput();
  });
  $('searchResults').addEventListener('mousedown', (e) => e.preventDefault()); /* keep input focus */
  $('searchResults').addEventListener('click', (e) => {
    const btn = e.target.closest('.result');
    if (btn) activateItem(searchItems[Number(btn.dataset.i)]);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) closeResults();
  });

  document.querySelectorAll('[data-group]').forEach((btn) => {
    btn.addEventListener('click', () => loadGroup(btn.dataset.group));
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (!$('searchResults').hidden) { closeResults(); input.blur(); return; }
      clearSelection();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); input.focus(); }
    if (e.key === 'i' || e.key === 'I') {
      const iss = state.sats.find((s) => s.meta.isISS);
      if (iss) selectSatellite(iss);
    }
    if (e.key === 'g' || e.key === 'G') $('groundToggle').click();
  });
}

/* ---------- BOOT ---------- */
function boot() {
  initStarfield();
  initMap();
  initDefaultSatellites();
  bindEvents();

  updateAll();
  state.updateInterval = setInterval(updateAll, UPDATE_MS);

  setTimeout(() => {
    const iss = state.sats.find((s) => s.meta.isISS);
    if (iss) selectSatellite(iss);
  }, 800);
}

window.addEventListener('load', boot);
