/* מפת מורשת ישראל — לוגיקת האפליקציה הראשית, על גבי מפה וקטורית עצמאית (MapLibre + PMTiles) */
import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';

const ERA_COLORS = {
  prehistoric: '#A97142',
  bronze: '#C98A3A',
  biblical: '#B23A48',
  classical: '#6E4C9E',
  medieval: '#2A5C8A',
  modern: '#3E7D44'
};

const ERA_ICONS = {
  prehistoric: 'icons/svg/era-prehistoric.svg',
  bronze: 'icons/svg/era-bronze.svg',
  biblical: 'icons/svg/era-biblical.svg',
  classical: 'icons/svg/era-classical.svg',
  medieval: 'icons/svg/era-medieval.svg',
  modern: 'icons/svg/era-modern.svg'
};

// Israel's real extent, used to keep the map focused (no wandering into
// neighboring countries) and to build the era-color match expression.
const ISRAEL_BOUNDS = [[33.9, 28.9], [36.3, 33.8]];

// Base-style layers that make the map read as "a generic street map" (building
// footprints, minor roads, transit, secondary place names). When a thematic
// layer (regions/geology) is on, these are hidden so the theme's own colors —
// not the street grid — are what the eye reads, like a real illustrated map.
const THEMATIC_DECLUTTER_LAYERS = [
  'building', 'landuse_residential', 'landcover_wood', 'landcover_ice_shelf', 'landcover_glacier', 'park',
  'highway_minor', 'highway_path', 'road_area_pier', 'road_pier',
  'aeroway-taxiway', 'aeroway-runway-casing', 'aeroway-area', 'aeroway-runway',
  'railway_transit', 'railway_transit_dashline', 'railway_service', 'railway_service_dashline', 'railway', 'railway_dashline',
  'tunnel_motorway_casing', 'tunnel_motorway_inner',
  'highway_motorway_bridge_casing', 'highway_motorway_bridge_inner',
  'highway_name_other', 'highway_name_motorway',
  'place_suburb', 'place_village', 'place_other'
];

const state = {
  periods: [],
  regionsGeoJSON: null,
  religions: [],
  sitesGeoJSON: { type: 'FeatureCollection', features: [] },
  geologyGeoJSON: { basic: null, advanced: null },
  geologyLevel: 'basic',
  periodIndex: 0,
  showFirstTemple: false,
  showSecondTemple: false,
  activeReligions: new Set(),
  route: JSON.parse(localStorage.getItem('ihm_route') || '[]')
};

let map, nearbyMarker;

function abs(path) {
  return new URL(path, window.location.href).href;
}

// Base directory URL, safe to string-concatenate with URL templates
// (new URL() would percent-encode the literal "{fontstack}"/"{range}" tokens).
function absDir() {
  return new URL('.', window.location.href).href;
}

async function loadData() {
  const empty = { type: 'FeatureCollection', features: [] };
  const [periods, regions, religions, sites, geologyBasic, geologyAdvanced] = await Promise.all([
    fetch('js/data/periods.json').then(r => r.json()),
    fetch('js/data/regions.geojson').then(r => r.json()),
    fetch('js/data/religions.json').then(r => r.json()),
    fetch('js/data/sites.geojson').then(r => r.json()).catch(() => empty),
    fetch('js/data/geology_basic.geojson').then(r => r.json()).catch(() => empty),
    fetch('js/data/geology_advanced.geojson').then(r => r.json()).catch(() => empty)
  ]);
  state.periods = periods.sort((a, b) => a.order - b.order);
  state.regionsGeoJSON = regions;
  state.religions = religions;
  state.sitesGeoJSON = sites;
  state.geologyGeoJSON.basic = geologyBasic;
  state.geologyGeoJSON.advanced = geologyAdvanced;
  state.activeReligions = new Set(religions.map(r => r.id));
}

function eraColorMatchExpression() {
  const expr = ['match', ['at', 0, ['get', 'periods']]];
  state.periods.forEach(p => {
    expr.push(p.id, ERA_COLORS[p.era] || '#12968A');
  });
  expr.push('#12968A');
  return expr;
}

function religionColorMatchExpression() {
  const expr = ['match', ['at', 0, ['get', 'religions']]];
  state.religions.forEach(r => expr.push(r.id, r.color));
  expr.push('#12968A');
  return expr;
}

async function initMap() {
  const styleObj = await fetch('vendor/maplibre/style.json').then(r => r.json());
  styleObj.sources.openmaptiles.url = 'pmtiles://' + abs('data/israel.pmtiles');
  styleObj.glyphs = absDir() + 'vendor/maplibre/fonts/{fontstack}/{range}.pbf';

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  if (maplibregl.getRTLTextPluginStatus() === 'unavailable') {
    maplibregl.setRTLTextPlugin(abs('vendor/maplibre/mapbox-gl-rtl-text.js'), false);
  }

  map = new maplibregl.Map({
    container: 'map',
    style: styleObj,
    center: [35.1, 31.6],
    zoom: 7.3,
    minZoom: 6.5,
    maxZoom: 18,
    maxBounds: ISRAEL_BOUNDS,
    attributionControl: false
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-left');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.on('error', e => console.warn('Map error:', e.error && e.error.message));

  // UI (sidebar, buttons, legends, slider) must work immediately, independent
  // of how long the base map itself takes to finish loading over the network.
  buildRegionsLegend();
  buildReligionFilters();
  buildPeriodSlider();
  buildGeologyLegend();
  renderRoute();
  wireUI();

  await new Promise(resolve => map.on('load', resolve));

  map.addSource('regions', { type: 'geojson', data: state.regionsGeoJSON });
  map.addLayer({
    id: 'regions-fill', type: 'fill', source: 'regions',
    layout: { visibility: 'none' },
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.78 }
  });
  map.addLayer({
    id: 'regions-line', type: 'line', source: 'regions',
    layout: { visibility: 'none' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 2 }
  });

  map.addSource('geology', { type: 'geojson', data: state.geologyGeoJSON.basic });
  map.addLayer({
    id: 'geology-fill', type: 'fill', source: 'geology',
    layout: { visibility: 'none' },
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.85 }
  });
  map.addLayer({
    id: 'geology-line', type: 'line', source: 'geology',
    layout: { visibility: 'none' },
    paint: { 'line-color': '#5A4325', 'line-width': 1.2 }
  });

  map.addSource('sites', { type: 'geojson', data: state.sitesGeoJSON });
  map.addLayer({
    id: 'sites-periods', type: 'circle', source: 'sites',
    filter: ['==', ['literal', false], ['literal', true]],
    paint: {
      'circle-radius': 8,
      'circle-color': eraColorMatchExpression(),
      'circle-stroke-color': '#FFFBF2',
      'circle-stroke-width': 2.5
    }
  });
  map.addLayer({
    id: 'sites-religions', type: 'circle', source: 'sites',
    filter: ['==', ['literal', false], ['literal', true]],
    paint: {
      'circle-radius': 9,
      'circle-color': religionColorMatchExpression(),
      'circle-stroke-color': '#FFFBF2',
      'circle-stroke-width': 2.5
    }
  });

  ['regions-fill', 'geology-fill', 'sites-periods', 'sites-religions'].forEach(id => {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  });

  map.on('click', 'sites-periods', e => openInfoPanel(e.features[0].properties, 'period'));
  map.on('click', 'sites-religions', e => openInfoPanel(e.features[0].properties, 'religion'));
  map.on('click', 'geology-fill', e => {
    const props = e.features[0].properties;
    openInfoPanel({
      id: props.id,
      name_he: props.name_he,
      name_en: props.name_en,
      description_he: `<strong>${props.rock_summary_he || ''}</strong><br>${props.description_he || ''}`,
      sources: parseMaybeJSON(props.sources)
    }, 'geology');
  });

  refreshSitesLayer();
  refreshReligionsLayer();
}

// GeoJSON sources round-trip array/object properties as JSON strings once
// MapLibre serializes them internally in some code paths; normalize defensively.
function parseMaybeJSON(v) {
  if (Array.isArray(v) || (v && typeof v === 'object')) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (e) { return []; }
  }
  return [];
}

function buildRegionsLegend() {
  const el = document.getElementById('regions-legend');
  el.innerHTML = '';
  state.regionsGeoJSON.features
    .slice()
    .sort((a, b) => a.properties.name_he.localeCompare(b.properties.name_he, 'he'))
    .forEach(f => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = `<span class="swatch" style="background:${f.properties.color}"></span>${f.properties.name_he}`;
      el.appendChild(item);
    });
}

function buildPeriodSlider() {
  const slider = document.getElementById('period-slider');
  slider.max = state.periods.length - 1;
  slider.value = state.periodIndex;
  updatePeriodLabel();
  slider.addEventListener('input', () => {
    state.periodIndex = Number(slider.value);
    updatePeriodLabel();
    refreshSitesLayer();
  });
}

function updatePeriodLabel() {
  const p = state.periods[state.periodIndex];
  const icon = ERA_ICONS[p.era] || '';
  document.getElementById('period-label').innerHTML =
    (icon ? `<img src="${icon}" alt="" />` : '') + `<span>${p.name_he} (${p.name_en})</span>`;
  document.getElementById('period-range').textContent = p.range_he + (p.note_he ? ` — ${p.note_he}` : '');
}

function buildReligionFilters() {
  const wrap = document.getElementById('religion-filters');
  wrap.innerHTML = '';
  state.religions.forEach(r => {
    const chip = document.createElement('div');
    chip.className = 'religion-chip active';
    chip.style.borderColor = r.color;
    chip.innerHTML = `<span>${r.icon}</span><span>${r.name_he}</span>`;
    chip.addEventListener('click', () => {
      if (state.activeReligions.has(r.id)) {
        state.activeReligions.delete(r.id);
        chip.classList.remove('active');
      } else {
        state.activeReligions.add(r.id);
        chip.classList.add('active');
      }
      refreshReligionsLayer();
    });
    wrap.appendChild(chip);
  });
}

function siteMatchesTempleFilter(props) {
  if (state.showFirstTemple && props.temple_era === 'first-temple') return true;
  if (state.showSecondTemple && props.temple_era === 'second-temple') return true;
  return false;
}

function refreshSitesLayer() {
  if (!map.getLayer('sites-periods')) return;
  const templeFilterActive = state.showFirstTemple || state.showSecondTemple;
  const currentPeriod = state.periods[state.periodIndex];

  let filter;
  if (templeFilterActive) {
    const wanted = [];
    if (state.showFirstTemple) wanted.push('first-temple');
    if (state.showSecondTemple) wanted.push('second-temple');
    filter = ['in', ['get', 'temple_era'], ['literal', wanted]];
  } else {
    filter = ['in', currentPeriod.id, ['get', 'periods']];
  }
  map.setFilter('sites-periods', filter);
}

function refreshReligionsLayer() {
  if (!map.getLayer('sites-religions')) return;
  const active = [...state.activeReligions];
  if (!active.length) {
    map.setFilter('sites-religions', ['==', ['literal', false], ['literal', true]]);
    return;
  }
  map.setFilter('sites-religions', ['any', ...active.map(rid => ['in', rid, ['get', 'religions']])]);
}

function refreshGeologyLayer() {
  const data = state.geologyGeoJSON[state.geologyLevel];
  if (!data || !map.getSource('geology')) return;
  map.getSource('geology').setData(data);
  buildGeologyLegend();
}

function buildGeologyLegend() {
  const el = document.getElementById('geology-legend');
  const data = state.geologyGeoJSON[state.geologyLevel];
  el.innerHTML = '';
  if (!data) return;
  data.features
    .slice()
    .sort((a, b) => a.properties.name_he.localeCompare(b.properties.name_he, 'he'))
    .forEach(f => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = `<span class="swatch" style="background:${f.properties.color}"></span>${f.properties.name_he}`;
      el.appendChild(item);
    });
}

function openInfoPanel(props, context) {
  const panel = document.getElementById('info-panel');
  const content = document.getElementById('info-content');
  if (window.innerWidth < 900) {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('sidebar-backdrop').classList.add('hidden');
  }
  const periods = parseMaybeJSON(props.periods);
  const religions = parseMaybeJSON(props.religions);
  const sources = parseMaybeJSON(props.sources);

  let metaBits = [];
  if (periods.length) {
    metaBits.push(periods.map(pid => {
      const p = state.periods.find(x => x.id === pid);
      return p ? p.name_he : pid;
    }).join(', '));
  }
  if (religions.length) {
    metaBits.push(religions.map(rid => {
      const r = state.religions.find(x => x.id === rid);
      return r ? r.name_he : rid;
    }).join(', '));
  }
  if (props.temple_era === 'first-temple') metaBits.push('תקופת בית ראשון');
  if (props.temple_era === 'second-temple') metaBits.push('תקופת בית שני');

  const sourcesHtml = sources
    .map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.title}</a>`)
    .join('');

  content.innerHTML = `
    <h3>${props.name_he}</h3>
    <div class="meta">${props.name_en || ''}${metaBits.length ? ' • ' + metaBits.join(' • ') : ''}</div>
    <p>${props.description_he || ''}</p>
    ${sourcesHtml ? `<div class="sources"><strong>מקורות:</strong>${sourcesHtml}</div>` : ''}
    <button class="add-route-btn" data-id="${props.id}">➕ הוסף למסלול</button>
  `;
  content.querySelector('.add-route-btn').addEventListener('click', () => addToRoute(props));
  panel.classList.remove('hidden');
}

function addToRoute(props) {
  if (state.route.find(r => r.id === props.id)) return;
  state.route.push({ id: props.id, name_he: props.name_he });
  localStorage.setItem('ihm_route', JSON.stringify(state.route));
  renderRoute();
}

function renderRoute() {
  const list = document.getElementById('route-list');
  list.innerHTML = '';
  state.route.forEach((item, idx) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${idx + 1}. ${item.name_he}</span><button class="remove-route-item" data-id="${item.id}">✕</button>`;
    li.querySelector('.remove-route-item').addEventListener('click', () => {
      state.route = state.route.filter(r => r.id !== item.id);
      localStorage.setItem('ihm_route', JSON.stringify(state.route));
      renderRoute();
    });
    list.appendChild(li);
  });
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearby() {
  if (!navigator.geolocation) {
    alert('הדפדפן לא תומך באיתור מיקום');
    return;
  }
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude, longitude } = pos.coords;
    map.flyTo({ center: [longitude, latitude], zoom: 13 });
    if (nearbyMarker) nearbyMarker.remove();
    nearbyMarker = new maplibregl.Marker({ color: '#EF6F53' }).setLngLat([longitude, latitude]).addTo(map);

    const nearby = state.sitesGeoJSON.features
      .map(f => ({ f, dist: haversine(latitude, longitude, f.geometry.coordinates[1], f.geometry.coordinates[0]) }))
      .filter(x => x.dist <= 5)
      .sort((a, b) => a.dist - b.dist);

    const content = document.getElementById('info-content');
    const panel = document.getElementById('info-panel');
    if (window.innerWidth < 900) {
      document.getElementById('sidebar').classList.add('collapsed');
      document.getElementById('sidebar-backdrop').classList.add('hidden');
    }
    if (!nearby.length) {
      content.innerHTML = '<h3>מה יש כאן?</h3><p>לא נמצאו אתרים מתועדים ברדיוס 5 ק"מ מהמיקום הנוכחי.</p>';
    } else {
      content.innerHTML = `<h3>מה יש כאן? (${nearby.length} אתרים ברדיוס 5 ק"מ)</h3>` +
        nearby.map(x => `<p><strong>${x.f.properties.name_he}</strong> — ${x.dist.toFixed(1)} ק"מ<br><a href="#" class="jump-to-site" data-id="${x.f.properties.id}">הצג פרטים</a></p>`).join('');
      content.querySelectorAll('.jump-to-site').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const site = state.sitesGeoJSON.features.find(f => f.properties.id === a.dataset.id);
          if (site) openInfoPanel(site.properties, 'nearby');
        });
      });
    }
    panel.classList.remove('hidden');
  }, err => {
    alert('לא ניתן היה לאתר את המיקום: ' + err.message);
  });
}

/* ---- Offline: cache the whole self-hosted map (single pmtiles file) ---- */
async function cacheWholeMap() {
  const status = document.getElementById('cache-status');
  if (!navigator.serviceWorker.controller) {
    status.textContent = 'ה-Service Worker עדיין לא פעיל, נסה/י לרענן את הדף ולנסות שוב.';
    return;
  }
  status.textContent = 'מוריד את המפה (כ-95MB, פעם אחת בלבד)...';
  navigator.serviceWorker.addEventListener('message', function handler(e) {
    if (e.data && e.data.type === 'cache-map-progress') {
      status.textContent = `מוריד את המפה... ${e.data.percent}%`;
    }
    if (e.data && e.data.type === 'cache-map-done') {
      status.textContent = e.data.ok
        ? 'הושלם! כל המפה שמורה לשימוש אופליין מלא.'
        : 'משהו השתבש בהורדה: ' + e.data.error;
      navigator.serviceWorker.removeEventListener('message', handler);
    }
  });
  navigator.serviceWorker.controller.postMessage({ type: 'cache-map' });
}

// The base map can still be loading tiles when the user starts clicking, so
// every layer-touching call is guarded against the layer not existing yet.
function setLayerVisibility(id, visible) {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
}

// Whenever a thematic layer (regions/geology) is on, hide the base map's
// street-map clutter so the theme's own colors read as the map itself
// changing — not as blocks painted over an unrelated street map underneath.
function updateBaseMapDeclutter() {
  const regionsOn = document.getElementById('toggle-regions').checked;
  const geologyOn = document.getElementById('toggle-geology').checked;
  const declutter = regionsOn || geologyOn;
  THEMATIC_DECLUTTER_LAYERS.forEach(id => setLayerVisibility(id, !declutter));
}

/* ---- UI wiring ---- */
function wireUI() {
  document.getElementById('toggle-regions').addEventListener('change', e => {
    setLayerVisibility('regions-fill', e.target.checked);
    setLayerVisibility('regions-line', e.target.checked);
    document.getElementById('regions-legend').classList.toggle('hidden', !e.target.checked);
    updateBaseMapDeclutter();
  });

  document.getElementById('toggle-geology').addEventListener('change', e => {
    const subtoggle = document.getElementById('geology-subtoggle');
    const legend = document.getElementById('geology-legend');
    setLayerVisibility('geology-fill', e.target.checked);
    setLayerVisibility('geology-line', e.target.checked);
    subtoggle.classList.toggle('hidden', !e.target.checked);
    legend.classList.toggle('hidden', !e.target.checked);
    updateBaseMapDeclutter();
  });

  const geoBasicBtn = document.getElementById('btn-geology-basic');
  const geoAdvancedBtn = document.getElementById('btn-geology-advanced');
  geoBasicBtn.addEventListener('click', () => {
    state.geologyLevel = 'basic';
    geoBasicBtn.classList.add('active');
    geoAdvancedBtn.classList.remove('active');
    refreshGeologyLayer();
  });
  geoAdvancedBtn.addEventListener('click', () => {
    state.geologyLevel = 'advanced';
    geoAdvancedBtn.classList.add('active');
    geoBasicBtn.classList.remove('active');
    refreshGeologyLayer();
  });

  document.getElementById('toggle-periods').addEventListener('change', e => {
    setLayerVisibility('sites-periods', e.target.checked);
  });

  document.getElementById('toggle-religions').addEventListener('change', e => {
    setLayerVisibility('sites-religions', e.target.checked);
  });

  document.getElementById('toggle-first-temple').addEventListener('change', e => {
    state.showFirstTemple = e.target.checked;
    refreshSitesLayer();
  });
  document.getElementById('toggle-second-temple').addEventListener('change', e => {
    state.showSecondTemple = e.target.checked;
    refreshSitesLayer();
  });

  document.getElementById('btn-close-info').addEventListener('click', () => {
    document.getElementById('info-panel').classList.add('hidden');
  });

  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');

  function openSidebar() {
    sidebar.classList.remove('collapsed');
    if (window.innerWidth < 900) backdrop.classList.remove('hidden');
  }
  function closeSidebar() {
    sidebar.classList.add('collapsed');
    backdrop.classList.add('hidden');
  }

  document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
    if (sidebar.classList.contains('collapsed')) openSidebar(); else closeSidebar();
  });
  backdrop.addEventListener('click', closeSidebar);

  document.getElementById('btn-toggle-route').addEventListener('click', () => {
    openSidebar();
    document.getElementById('route-list').scrollIntoView({ behavior: 'smooth' });
  });

  document.getElementById('btn-clear-route').addEventListener('click', () => {
    if (confirm('לנקות את כל המסלול?')) {
      state.route = [];
      localStorage.setItem('ihm_route', '[]');
      renderRoute();
    }
  });

  document.getElementById('btn-nearby').addEventListener('click', findNearby);
  document.getElementById('btn-cache-area').addEventListener('click', cacheWholeMap);

  if (window.innerWidth < 900) {
    closeSidebar();
  }

  window.addEventListener('online', () => document.getElementById('offline-indicator').classList.add('hidden'));
  window.addEventListener('offline', () => document.getElementById('offline-indicator').classList.remove('hidden'));
  if (!navigator.onLine) document.getElementById('offline-indicator').classList.remove('hidden');
}

async function main() {
  await loadData();
  await initMap();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  }
}

function showFatalError(message) {
  document.getElementById('sidebar').classList.add('collapsed');
  document.getElementById('sidebar-backdrop').classList.add('hidden');
  const mapEl = document.getElementById('map');
  mapEl.innerHTML = `<div style="padding:24px;text-align:center;color:#2E2418;">
    <p style="font-weight:700;margin-bottom:8px;">משהו השתבש בטעינת המפה</p>
    <p style="font-size:0.85rem;color:#5C4E3A;">${message}</p>
    <button onclick="location.reload()" style="margin-top:12px;padding:10px 16px;border-radius:999px;border:none;background:#F2A93B;font-weight:700;">רענן את הדף</button>
  </div>`;
}

main().catch(err => {
  console.error(err);
  showFatalError(err.message || String(err));
});
