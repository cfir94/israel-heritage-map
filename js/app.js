/* מפת מורשת ישראל — לוגיקת האפליקציה הראשית, על גבי מפה וקטורית עצמאית (MapLibre + PMTiles) */
import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';
import mlcontour from '../vendor/maplibre/maplibre-contour.mjs';

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

// Base-style layers that make the map read as "a generic street map" — the road
// grid, buildings, landcover, road names. When a thematic layer (regions/geology)
// is on, these are hidden so the theme's own colors are what the eye reads, like
// a printed thematic map.
//
// Deliberately NOT in this list: water, waterway and every `place_*` label. The
// coastline, the Kinneret and the Dead Sea are what make the shape legible, and
// place names are how you know where you are — a thematic map without them is a
// pretty picture, not a tool you can navigate by.
const THEMATIC_DECLUTTER_LAYERS = [
  'building', 'landuse_residential', 'landcover_wood', 'landcover_ice_shelf', 'landcover_glacier', 'park',
  'highway_minor', 'highway_path', 'road_area_pier', 'road_pier',
  'highway_major_casing', 'highway_major_inner', 'highway_major_subtle',
  'highway_motorway_casing', 'highway_motorway_inner', 'highway_motorway_subtle',
  'aeroway-taxiway', 'aeroway-runway-casing', 'aeroway-area', 'aeroway-runway',
  'railway_transit', 'railway_transit_dashline', 'railway_service', 'railway_service_dashline', 'railway', 'railway_dashline',
  'tunnel_motorway_casing', 'tunnel_motorway_inner',
  'highway_motorway_bridge_casing', 'highway_motorway_bridge_inner',
  'highway_name_other', 'highway_name_motorway'
];

// Thematic fills are inserted directly above the base background and below
// `water`, so lakes, the sea and every label in the style still draw on top of
// them. Without this the fills land at the top of the stack and bury the very
// city names the map is meant to be read by.
const THEMATIC_INSERT_BEFORE = 'water';

// Hillshade goes *above* the thematic fills but still below boundaries and
// labels, so relief reads through the rock colours the way it does on a printed
// geological map. Putting it under them instead left the country looking flat
// while the hills across the border stayed dramatic.
const HILLSHADE_INSERT_BEFORE = 'boundary_state';

// Nature layer: colour per kind of sighting, so birds/mammals/plants read apart
// at a glance without needing the legend.
const NATURE_KINDS = {
  birds:   { color: '#3E7DA8', label: 'ציפורים ותצפיות נדידה' },
  mammals: { color: '#B06A2C', label: 'יונקים' },
  plants:  { color: '#5E8C3A', label: 'צמחים ופריחה' },
  mixed:   { color: '#7C6AA8', label: 'חי וצומח יחד' }
};

// Official visitor sites, by the body that runs them.
const VISITOR_OPERATORS = {
  inpa: { color: '#2F7D5B', label: 'רשות הטבע והגנים' },
  kkl:  { color: '#3E7DA8', label: 'קק״ל' }
};
// parks.org.il serves its REST API with Access-Control-Allow-Origin: *, so the
// app can re-check a site's prices and hours against the official source at the
// moment you open it. The bundled copy is what makes it work with no signal.
const INPA_API = 'https://www.parks.org.il/wp-json/wp/v2/rp/';

// Place labels sit on saturated fills once a thematic layer is on, so the halo
// has to work harder than it does over plain paper.
const PLACE_LABEL_LAYERS = ['place_other', 'place_suburb', 'place_village', 'place_town', 'place_city', 'place_capital', 'place_city_large'];

const state = {
  periods: [],
  regionsGeoJSON: null,
  religions: [],
  sitesGeoJSON: { type: 'FeatureCollection', features: [] },
  geologyGeoJSON: { basic: null, advanced: null },
  natureGeoJSON: { type: 'FeatureCollection', features: [] },
  visitorGeoJSON: { type: 'FeatureCollection', features: [] },
  species: {},
  speciesAliases: {},
  activeOperators: new Set(['inpa', 'kkl']),
  activeNatureKinds: new Set(Object.keys({ birds:1, mammals:1, plants:1, mixed:1 })),
  geologyLevel: 'basic',
  periodIndex: 0,
  showFirstTemple: false,
  showSecondTemple: false,
  activeReligions: new Set(),
  route: JSON.parse(localStorage.getItem('ihm_route') || '[]')
};

let map, nearbyMarker, demSource, geolocate;

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
  const [periods, regions, religions, sites, geologyBasic, geologyAdvanced, nature, visitor, species] = await Promise.all([
    fetch('js/data/periods.json').then(r => r.json()),
    fetch('js/data/regions.geojson').then(r => r.json()),
    fetch('js/data/religions.json').then(r => r.json()),
    fetch('js/data/sites.geojson').then(r => r.json()).catch(() => empty),
    fetch('js/data/geology_basic.geojson').then(r => r.json()).catch(() => empty),
    fetch('js/data/geology_advanced.geojson').then(r => r.json()).catch(() => empty),
    fetch('js/data/nature.geojson').then(r => r.json()).catch(() => empty),
    fetch('js/data/visitor_sites.geojson').then(r => r.json()).catch(() => empty),
    fetch('js/data/species.json').then(r => r.json()).catch(() => ({ species: {}, aliases: {} }))
  ]);
  state.periods = periods.sort((a, b) => a.order - b.order);
  state.regionsGeoJSON = regions;
  state.religions = religions;
  state.sitesGeoJSON = sites;
  state.geologyGeoJSON.basic = geologyBasic;
  state.geologyGeoJSON.advanced = geologyAdvanced;
  state.natureGeoJSON = nature;
  state.visitorGeoJSON = visitor;
  state.species = species.species || {};
  state.speciesAliases = species.aliases || {};
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

const MAP_ICONS = {
  'ic-judaism':     'icons/svg/religion-judaism.svg',
  'ic-christianity':'icons/svg/religion-christianity.svg',
  'ic-islam':       'icons/svg/religion-islam.svg',
  'ic-inpa':        'icons/svg/op-inpa.svg',
  'ic-kkl':         'icons/svg/op-kkl.svg',
  'ic-birds':       'icons/svg/nature-birds.svg',
  'ic-mammals':     'icons/svg/nature-mammals.svg',
  'ic-plants':      'icons/svg/nature-plants.svg',
  'ic-mixed':       'icons/svg/nature-mixed.svg'
};

// SVG has to be rasterised before MapLibre can use it as a symbol image.
function loadMapIcons() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = 44;
  return Promise.all(Object.entries(MAP_ICONS).map(([id, path]) => new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = Math.round(size * dpr);
      const ctx = c.getContext('2d');
      // a soft disc behind the glyph so it stays legible over any layer colour
      ctx.beginPath();
      ctx.arc(c.width / 2, c.height / 2, c.width / 2 - dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFBF2';
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = 'rgba(46,36,24,0.28)';
      ctx.stroke();
      const pad = 9 * dpr;
      ctx.drawImage(img, pad, pad, c.width - pad * 2, c.height - pad * 2);
      const data = ctx.getImageData(0, 0, c.width, c.height);
      if (!map.hasImage(id)) map.addImage(id, data, { pixelRatio: dpr });
      resolve();
    };
    img.onerror = () => resolve();   // a missing icon must not stall map load
    img.src = abs(path);
  })));
}

function operatorColorMatchExpression() {
  const expr = ['match', ['get', 'operator']];
  Object.entries(VISITOR_OPERATORS).forEach(([k, v]) => expr.push(k, v.color));
  expr.push('#8A7A63');
  return expr;
}

function natureColorMatchExpression() {
  const expr = ['match', ['get', 'kind']];
  Object.entries(NATURE_KINDS).forEach(([k, v]) => expr.push(k, v.color));
  expr.push('#12968A');
  return expr;
}

async function initMap() {
  const styleObj = await fetch('vendor/maplibre/style.json').then(r => r.json());
  styleObj.sources.openmaptiles.url = 'pmtiles://' + abs('data/israel.pmtiles');
  styleObj.glyphs = absDir() + 'vendor/maplibre/fonts/{fontstack}/{range}.pbf';

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  // One shared elevation source feeds both the hillshade and the contour lines.
  demSource = new mlcontour.DemSource({
    url: absDir() + 'data/terrain/{z}/{x}/{y}.png',
    encoding: 'terrarium',
    maxzoom: 11,
    worker: true
  });
  demSource.setupMaplibre(maplibregl);

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
  // Exposed so the map can be inspected from the browser console / automated
  // checks (layer order, which labels actually rendered) without reaching into
  // module scope. Read-only as far as the app is concerned.
  window.__ihmMap = map;

  map.addControl(new maplibregl.NavigationControl(), 'top-left');

  // Live position. trackUserLocation keeps following as you walk, and the
  // heading indicator matters when you are orienting a group on a hilltop.
  geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 10000 },
    trackUserLocation: true,
    showUserLocation: true,
    showAccuracyCircle: true,
    showUserHeading: true
  });
  map.addControl(geolocate, 'top-left');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.on('error', e => console.warn('Map error:', e.error && e.error.message));

  // UI (sidebar, buttons, legends, slider) must work immediately, independent
  // of how long the base map itself takes to finish loading over the network.
  buildRegionsLegend();
  buildReligionFilters();
  buildPeriodSlider();
  buildGeologyLegend();
  buildNatureFilters();
  buildVisitorFilters();
  buildSearchIndex();
  renderRoute();
  wireUI();

  await new Promise(resolve => map.on('load', resolve));

  // Icons make the map readable at a glance: a cross, a crescent, a Star of
  // David, an ibex or a tree says what a coloured dot cannot.
  await loadMapIcons();

  // Terrain relief. Our own elevation tileset (terrarium-encoded, zoom 0-11);
  // MapLibre overzooms past 11, which is fine because hillshade is a soft
  // shading effect rather than something you read detail off.
  map.addSource('terrain', {
    type: 'raster-dem',
    tiles: [absDir() + 'data/terrain/{z}/{x}/{y}.png'],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 11,
    attribution: 'Elevation: Mapzen / Amazon Terrain Tiles'
  });
  map.addLayer({
    id: 'hillshade', type: 'hillshade', source: 'terrain',
    layout: { visibility: 'none' },
    paint: {
      'hillshade-exaggeration': 0.45,
      'hillshade-shadow-color': '#6B5636',
      'hillshade-highlight-color': '#FFF6E4',
      'hillshade-accent-color': '#8A7350'
    }
  }, HILLSHADE_INSERT_BEFORE);

  // Real contour lines, the thing that makes a hiking map a hiking map.
  // maplibre-contour derives them in a worker from the same elevation tiles the
  // hillshade uses, so this costs no extra download and still works offline.
  map.addSource('contours', {
    type: 'vector',
    tiles: [demSource.contourProtocolUrl({
      thresholds: {
        // zoom: [minor interval, major (labelled) interval] in metres
        9:  [100, 500],
        11: [50, 250],
        13: [20, 100],
        14: [10, 50]
      },
      elevationKey: 'ele',
      levelKey: 'level',
      contourLayer: 'contours',
      overzoom: 1
    })],
    maxzoom: 15
  });
  map.addLayer({
    id: 'contour-lines', type: 'line', source: 'contours', 'source-layer': 'contours',
    layout: { visibility: 'none', 'line-join': 'round' },
    paint: {
      'line-color': '#8A6B3F',
      // major contours read heavier than the minor ones between them
      'line-width': ['match', ['get', 'level'], 1, 1.3, 0.6],
      'line-opacity': ['match', ['get', 'level'], 1, 0.65, 0.4]
    }
  }, HILLSHADE_INSERT_BEFORE);
  map.addLayer({
    id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours',
    filter: ['>', ['get', 'level'], 0],
    layout: {
      visibility: 'none',
      'symbol-placement': 'line',
      'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' מ׳'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10.5,
      'text-max-angle': 25
    },
    paint: {
      'text-color': '#6B5230',
      'text-halo-color': '#FFFBF2',
      'text-halo-width': 1.6
    }
  }, HILLSHADE_INSERT_BEFORE);

  map.addSource('regions', { type: 'geojson', data: state.regionsGeoJSON });
  map.addLayer({
    id: 'regions-fill', type: 'fill', source: 'regions',
    layout: { visibility: 'none' },
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.78 }
  }, THEMATIC_INSERT_BEFORE);
  map.addLayer({
    id: 'regions-line', type: 'line', source: 'regions',
    layout: { visibility: 'none' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 2 }
  }, THEMATIC_INSERT_BEFORE);

  map.addSource('geology', { type: 'geojson', data: state.geologyGeoJSON.basic });
  map.addLayer({
    id: 'geology-fill', type: 'fill', source: 'geology',
    layout: { visibility: 'none' },
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.85 }
  }, THEMATIC_INSERT_BEFORE);
  map.addLayer({
    id: 'geology-line', type: 'line', source: 'geology',
    layout: { visibility: 'none' },
    paint: { 'line-color': '#5A4325', 'line-width': 1.2, 'line-opacity': 0.55 }
  }, THEMATIC_INSERT_BEFORE);

  // Route line sits above the thematic fills but below the site markers, so a
  // stop never disappears under its own route.
  const EMPTY_FC = { type: 'FeatureCollection', features: [] };
  map.addSource('route', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#FFFBF2', 'line-width': 9, 'line-opacity': 0.9 }
  }, HILLSHADE_INSERT_BEFORE);
  // line-dasharray is not data-driven in MapLibre, so the dashed "estimated"
  // styling is applied from JS in drawRoute() instead of via an expression.
  map.addLayer({
    id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#EF6F53', 'line-width': 5 }
  }, HILLSHADE_INSERT_BEFORE);

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
    id: 'sites-religions', type: 'symbol', source: 'sites',
    filter: ['==', ['literal', false], ['literal', true]],
    layout: {
      'icon-image': ['match', ['at', 0, ['get', 'religions']],
        'judaism', 'ic-judaism', 'christianity', 'ic-christianity', 'islam', 'ic-islam',
        'ic-judaism'],
      'icon-size': 0.62,
      'icon-allow-overlap': true
    }
  });

  // Official visitor sites. 777 points would be an unreadable smear at country
  // zoom, so they cluster until you zoom into an area.
  map.addSource('visitor', {
    type: 'geojson', data: state.visitorGeoJSON,
    cluster: true, clusterRadius: 46, clusterMaxZoom: 12
  });
  map.addLayer({
    id: 'visitor-clusters', type: 'circle', source: 'visitor',
    filter: ['has', 'point_count'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#2F7D5B',
      'circle-opacity': 0.9,
      'circle-radius': ['step', ['get', 'point_count'], 15, 10, 20, 40, 26],
      'circle-stroke-color': '#FFFBF2',
      'circle-stroke-width': 2.5
    }
  });
  map.addLayer({
    id: 'visitor-cluster-count', type: 'symbol', source: 'visitor',
    filter: ['has', 'point_count'],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12
    },
    paint: { 'text-color': '#FFFBF2' }
  });
  map.addLayer({
    id: 'visitor-points', type: 'symbol', source: 'visitor',
    filter: ['!', ['has', 'point_count']],
    layout: {
      visibility: 'none',
      'icon-image': ['match', ['get', 'operator'], 'inpa', 'ic-inpa', 'kkl', 'ic-kkl', 'ic-inpa'],
      'icon-size': 0.55,
      'icon-allow-overlap': true
    }
  });

  // Nature sightings — vulture lookouts, blooms, wildlife reserves.
  map.addSource('nature', { type: 'geojson', data: state.natureGeoJSON });
  map.addLayer({
    id: 'nature-points', type: 'symbol', source: 'nature',
    layout: {
      visibility: 'none',
      'icon-image': ['match', ['get', 'kind'],
        'birds', 'ic-birds', 'mammals', 'ic-mammals', 'plants', 'ic-plants', 'ic-mixed'],
      'icon-size': 0.62,
      'icon-allow-overlap': true
    }
  });

  // Numbered stops, drawn last so they stay on top of every other layer.
  map.addSource('route-stops', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'route-stops', type: 'circle', source: 'route-stops',
    paint: {
      'circle-radius': 13,
      'circle-color': '#EF6F53',
      'circle-stroke-color': '#FFFBF2',
      'circle-stroke-width': 3
    }
  });
  map.addLayer({
    id: 'route-stop-labels', type: 'symbol', source: 'route-stops',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 13,
      'text-allow-overlap': true
    },
    paint: { 'text-color': '#FFFBF2' }
  });

  ['regions-fill', 'geology-fill', 'sites-periods', 'sites-religions', 'nature-points', 'visitor-points', 'visitor-clusters'].forEach(id => {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  });

  map.on('click', 'sites-periods', e => openInfoPanel(e.features[0].properties, 'period'));
  map.on('click', 'sites-religions', e => openInfoPanel(e.features[0].properties, 'religion'));
  map.on('click', 'visitor-clusters', e => {
    const f = map.queryRenderedFeatures(e.point, { layers: ['visitor-clusters'] })[0];
    if (!f) return;
    map.getSource('visitor').getClusterExpansionZoom(f.properties.cluster_id).then(z => {
      map.easeTo({ center: f.geometry.coordinates, zoom: z });
    }).catch(() => {});
  });

  map.on('click', 'visitor-points', e => openVisitorPanel(e.features[0].properties));

  map.on('click', 'nature-points', e => {
    openNaturePanel(e.features[0].properties);
  });

  map.on('click', 'geology-fill', e => openGeologyPanel(e.features[0].properties));

  refreshSitesLayer();
  refreshReligionsLayer();
  refreshNatureLayer();
  // The saved route was rendered into the sidebar before the map finished
  // loading, so draw it now that the route layers actually exist.
  updateRouteOnMap();
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

// One chip per operating body. Tapping a chip shows only that body's sites —
// the common case is wanting INPA parks or KKL forests on their own, not both
// at once — and long-pressing is not a thing on a map panel, so a second tap
// adds the other body back. The chips also switch the layer on by themselves,
// because having to find the master toggle first was the reason nobody found
// these filters at all.
function buildVisitorFilters() {
  const el = document.getElementById('visitor-filters');
  if (!el) return;
  el.innerHTML = '';
  const counts = {};
  state.visitorGeoJSON.features.forEach(f => {
    const o = f.properties.operator;
    counts[o] = (counts[o] || 0) + 1;
  });
  Object.entries(VISITOR_OPERATORS).forEach(([op, meta]) => {
    if (!counts[op]) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'operator-chip';
    btn.dataset.op = op;
    btn.setAttribute('aria-pressed', 'true');
    btn.innerHTML = `<span class="dot" style="background:${meta.color}"></span>
      <span class="op-label">${meta.label}</span><span class="op-count">${counts[op]}</span>`;
    btn.addEventListener('click', () => toggleOperator(op));
    el.appendChild(btn);
  });
  syncOperatorChips();
}

function toggleOperator(op) {
  const others = Object.keys(VISITOR_OPERATORS).filter(o => o !== op);
  const onlyThis = state.activeOperators.has(op) && others.every(o => !state.activeOperators.has(o));
  if (onlyThis) {
    // already isolated — tapping again brings everything back
    Object.keys(VISITOR_OPERATORS).forEach(o => state.activeOperators.add(o));
  } else {
    state.activeOperators = new Set([op]);
  }
  const master = document.getElementById('toggle-visitor');
  if (master && !master.checked) {
    master.checked = true;
    master.dispatchEvent(new Event('change', { bubbles: true }));
  }
  refreshVisitorLayer();
  syncOperatorChips();
}

function showAllOperators() {
  state.activeOperators = new Set(Object.keys(VISITOR_OPERATORS));
  const master = document.getElementById('toggle-visitor');
  if (master && !master.checked) {
    master.checked = true;
    master.dispatchEvent(new Event('change', { bubbles: true }));
  }
  refreshVisitorLayer();
  syncOperatorChips();
}

function syncOperatorChips() {
  document.querySelectorAll('#visitor-filters .operator-chip').forEach(btn => {
    const on = state.activeOperators.has(btn.dataset.op);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

function refreshVisitorLayer() {
  if (!map || !map.getSource('visitor')) return;
  const active = [...state.activeOperators];
  const features = state.visitorGeoJSON.features.filter(f => active.includes(f.properties.operator));
  map.getSource('visitor').setData({ type: 'FeatureCollection', features });
}

function buildNatureFilters() {
  const el = document.getElementById('nature-filters');
  if (!el) return;
  el.innerHTML = '';
  const present = new Set(state.natureGeoJSON.features.map(f => f.properties.kind));
  Object.entries(NATURE_KINDS).forEach(([kind, meta]) => {
    if (!present.has(kind)) return;
    const label = document.createElement('label');
    label.className = 'filter-item';
    label.innerHTML = `<input type="checkbox" value="${kind}" checked />
      <span class="swatch" style="background:${meta.color}"></span>${meta.label}`;
    label.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) state.activeNatureKinds.add(kind);
      else state.activeNatureKinds.delete(kind);
      refreshNatureLayer();
    });
    el.appendChild(label);
  });
}

function refreshNatureLayer() {
  if (!map || !map.getLayer('nature-points')) return;
  const active = [...state.activeNatureKinds];
  map.setFilter('nature-points', active.length
    ? ['in', ['get', 'kind'], ['literal', active]]
    : ['==', ['literal', false], ['literal', true]]);
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

  // The map now covers the whole country, and it should be clear why that is
  // safe to teach from but not safe to quote as survey data.
  const note = document.createElement('p');
  note.className = 'legend-note';
  note.textContent = 'תחומי היחידות סכמטיים — הכללה להוראה, לא מיפוי מדויק בשטח. הרכב הסלע והגיל של כל יחידה מגובים במקורות (לחיצה על אזור במפה).';
  el.appendChild(note);
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
    ${rockPhotoHtml(parseMaybeJSON(props.rock_photo))}
    ${props.extra_html || ''}
    <p>${props.description_he || ''}</p>
    ${sourcesHtml ? `<div class="sources"><strong>מקורות:</strong>${sourcesHtml}</div>` : ''}
    <button class="add-route-btn" data-id="${props.id}">➕ הוסף למסלול</button>
  `;
  content.querySelector('.add-route-btn').addEventListener('click', () => addToRoute(props));
  panel.classList.remove('hidden');
}

/* ---- Search -------------------------------------------------------------
   Everything is already in memory and the app must work with no signal, so
   search runs entirely locally over all the layers at once. */

const SEARCH_KINDS = {
  site:    { label: 'אתרים היסטוריים', color: '#B23A48' },
  visitor: { label: 'שמורות וגנים',    color: '#2F7D5B' },
  nature:  { label: 'חי וצומח',        color: '#5E8C3A' },
  geology: { label: 'יחידות גיאולוגיות', color: '#C98A3A' },
  region:  { label: 'אזורים',          color: '#12968A' }
};

// Hebrew typed in a hurry rarely matches stored text character for character:
// niqqud, geresh/gershayim variants, maqaf and quotes all differ. Fold them all
// away so "מסגד אל גזאר" still finds "מסגד אל-ג'זאר".
function normalizeHe(str) {
  return (str || '')
    .toString()
    .replace(/[֑-ׇ]/g, '')          // niqqud & cantillation
    .replace(/[׳״'"`’”“]/g, '')                // geresh, gershayim, quotes
    .replace(/[-–—_־]/g, ' ')             // hyphens and maqaf
    .replace(/[()[\],.:;!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

let searchIndex = [];

function buildSearchIndex() {
  const add = (kind, name_he, name_en, extra, payload) => {
    if (!name_he) return;
    searchIndex.push({
      kind, name_he, name_en: name_en || '', extra: extra || '',
      hay: normalizeHe([name_he, name_en, extra].filter(Boolean).join(' ')),
      hayName: normalizeHe(name_he + ' ' + (name_en || '')),
      payload
    });
  };

  state.sitesGeoJSON.features.forEach(f => {
    const p = f.properties;
    const periodNames = (p.periods || []).map(id => {
      const per = state.periods.find(x => x.id === id);
      return per ? per.name_he : id;
    }).join(' ');
    add('site', p.name_he, p.name_en, periodNames,
        { coords: f.geometry.coordinates, props: p, sub: periodNames });
  });

  state.visitorGeoJSON.features.forEach(f => {
    const p = f.properties;
    const op = VISITOR_OPERATORS[p.operator];
    add('visitor', p.name_he, '', op ? op.label : '',
        { coords: f.geometry.coordinates, props: p, sub: op ? op.label : '' });
  });

  state.natureGeoJSON.features.forEach(f => {
    const p = f.properties;
    const species = (p.species_he || []).join(' ');
    add('nature', p.name_he, p.name_en, species,
        { coords: f.geometry.coordinates, props: p, sub: species.slice(0, 60) });
  });

  ['basic', 'advanced'].forEach(level => {
    const fc = state.geologyGeoJSON[level];
    if (!fc) return;
    fc.features.forEach(f => {
      const p = f.properties;
      if (level === 'advanced' && searchIndex.some(e => e.kind === 'geology' && e.name_he === p.name_he)) return;
      add('geology', p.name_he, p.name_en, p.rock_summary_he,
          { center: polygonCenter(f.geometry), props: p, level, sub: p.rock_summary_he || '' });
    });
  });

  if (state.regionsGeoJSON) {
    state.regionsGeoJSON.features.forEach(f => {
      const p = f.properties;
      add('region', p.name_he, p.name_en, '',
          { center: polygonCenter(f.geometry), props: p, sub: 'אזור גיאוגרפי' });
    });
  }
}

// Rough centroid, good enough to fly to a polygon.
function polygonCenter(geom) {
  let sx = 0, sy = 0, n = 0;
  const walk = c => {
    if (typeof c[0] === 'number') { sx += c[0]; sy += c[1]; n++; }
    else c.forEach(walk);
  };
  walk(geom.coordinates);
  return n ? [sx / n, sy / n] : null;
}

function runSearch(query) {
  const q = normalizeHe(query);
  if (q.length < 2) return [];
  const tokens = q.split(' ').filter(Boolean);
  const scored = [];
  for (const entry of searchIndex) {
    let score = 0;
    if (entry.hayName === q) score = 100;
    else if (entry.hayName.startsWith(q)) score = 85;
    else if (entry.hayName.includes(q)) score = 70;
    else if (entry.hay.includes(q)) score = 50;
    else if (tokens.length > 1 && tokens.every(t => entry.hay.includes(t))) score = 35;
    if (!score) continue;
    // shorter names are usually the thing you meant
    score -= Math.min(10, entry.name_he.length / 12);
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 40).map(s => s.entry);
}

function renderSearchResults(results, query) {
  const box = document.getElementById('search-results');
  box.innerHTML = '';
  if (!query || query.trim().length < 2) {
    box.innerHTML = `<p class="search-hint">הקלד לפחות שתי אותיות. החיפוש עובר על כל השכבות — אתרים היסטוריים, שמורות וגנים, חי וצומח, גיאולוגיה ואזורים — ועובד גם בלי אינטרנט.</p>`;
    return;
  }
  if (!results.length) {
    box.innerHTML = `<p class="search-hint">לא נמצאו תוצאות עבור «${query}».</p>`;
    return;
  }
  const byKind = {};
  results.forEach(r => (byKind[r.kind] = byKind[r.kind] || []).push(r));
  Object.keys(SEARCH_KINDS).forEach(kind => {
    const items = byKind[kind];
    if (!items) return;
    const meta = SEARCH_KINDS[kind];
    const group = document.createElement('div');
    group.className = 'search-group';
    group.innerHTML = `<h4><span class="dot" style="background:${meta.color}"></span>${meta.label} <span class="count">${items.length}</span></h4>`;
    items.forEach(entry => {
      const btn = document.createElement('button');
      btn.className = 'search-result';
      btn.type = 'button';
      btn.setAttribute('role', 'option');
      btn.innerHTML = `<span class="r-name">${entry.name_he}</span>` +
        (entry.payload.sub ? `<span class="r-sub">${entry.payload.sub}</span>` : '');
      btn.addEventListener('click', () => selectSearchResult(entry));
      group.appendChild(btn);
    });
    box.appendChild(group);
  });
}

// Flying to a marker on a layer that is switched off would land on empty map,
// so picking a result turns its layer on first.
function ensureLayerVisibleFor(kind) {
  const check = id => {
    const el = document.getElementById(id);
    if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  if (kind === 'visitor') check('toggle-visitor');
  if (kind === 'nature') check('toggle-nature');
  if (kind === 'geology') check('toggle-geology');
  if (kind === 'region') check('toggle-regions');
  if (kind === 'site') check('toggle-periods');
}

function selectSearchResult(entry) {
  closeSearch();
  ensureLayerVisibleFor(entry.kind);
  const target = entry.payload.coords || entry.payload.center;
  if (target) {
    map.flyTo({ center: target, zoom: entry.kind === 'geology' || entry.kind === 'region' ? 9.5 : 14, duration: 1200 });
  }
  const p = entry.payload.props;
  if (entry.kind === 'visitor') openVisitorPanel(p);
  else if (entry.kind === 'nature') openNaturePanel(p);
  else if (entry.kind === 'geology') openGeologyPanel(p);
  else if (entry.kind === 'site') openInfoPanel(p, 'period');
  else if (entry.kind === 'region') {
    openInfoPanel({ id: p.id, name_he: p.name_he, name_en: p.name_en,
                    description_he: p.description_he || '', sources: p.sources || [] }, 'region');
  }
  // A historical site is only drawn on its own period, so jump the timeline
  // there — otherwise you fly to a marker that is filtered out. If the period
  // already selected shows this site, leave it alone rather than yanking the
  // timeline out from under whoever is mid-tour.
  if (entry.kind === 'site' && (p.periods || []).length) {
    const current = state.periods[state.periodIndex];
    if (current && p.periods.includes(current.id)) return;
    const idx = state.periods.findIndex(x => x.id === p.periods[0]);
    if (idx >= 0) {
      state.periodIndex = idx;
      const slider = document.getElementById('period-slider');
      if (slider) slider.value = String(idx);
      updatePeriodLabel();
      refreshSitesLayer();
    }
  }
}

function openSearch() {
  document.getElementById('search-overlay').classList.remove('hidden');
  document.getElementById('sidebar').classList.add('collapsed');
  document.getElementById('sidebar-backdrop').classList.add('hidden');
  const input = document.getElementById('search-input');
  input.value = '';
  renderSearchResults([], '');
  setTimeout(() => input.focus(), 30);
}

function closeSearch() {
  document.getElementById('search-overlay').classList.add('hidden');
}

function lookupSpecies(name) {
  const key = state.speciesAliases[name] || name;
  return state.species[key] || null;
}

const SPECIES_KIND_ICON = {
  birds: 'icons/svg/nature-birds.svg',
  mammals: 'icons/svg/nature-mammals.svg',
  plants: 'icons/svg/nature-plants.svg',
  mixed: 'icons/svg/nature-mixed.svg'
};

// A species the dictionary knows becomes a button; one it doesn't stays plain
// text, so a missing entry degrades quietly instead of offering a dead tap.
function speciesChipsHtml(names) {
  if (!names.length) return '';
  return `<div class="species-list">${names.map(n => {
    const sp = lookupSpecies(n);
    if (!sp) return `<span class="species-chip">${n}</span>`;
    const icon = SPECIES_KIND_ICON[sp.kind] || SPECIES_KIND_ICON.mixed;
    return `<button type="button" class="species-chip known" data-species="${n}">
      <img src="${icon}" alt="" />${n}</button>`;
  }).join('')}</div>`;
}

function openSpeciesCard(name, backTo) {
  const sp = lookupSpecies(name);
  if (!sp) return;
  const content = document.getElementById('info-content');
  const photo = sp.photo;
  const credit = photo ? [photo.author, photo.license].filter(Boolean).join(' · ') : '';
  const sources = (sp.sources || [])
    .map(x => `<a href="${x.url}" target="_blank" rel="noopener">${x.title}</a>`).join('');
  content.innerHTML = `
    <button type="button" class="species-back">→ חזרה</button>
    <h3><img class="kind-icon" src="${SPECIES_KIND_ICON[sp.kind] || SPECIES_KIND_ICON.mixed}" alt="" />${sp.name_he}</h3>
    <div class="meta">${sp.name_sci || ''}</div>
    ${photo ? `<figure class="rock-photo">
        <img src="${photo.file}" alt="${sp.name_he}" loading="lazy" />
        <figcaption><span class="credit">${photo.page ? `<a href="${photo.page}" target="_blank" rel="noopener">${credit}</a>` : credit}</span></figcaption>
      </figure>` : ''}
    <p>${sp.description_he}</p>
    ${sp.guide_he ? `<div class="guide-note"><strong>מה להראות בהדרכה</strong><p>${sp.guide_he}</p></div>` : ''}
    ${sources ? `<div class="sources"><strong>מקורות:</strong>${sources}</div>` : ''}`;
  const back = content.querySelector('.species-back');
  if (back) back.addEventListener('click', () => backTo && backTo());
  document.getElementById('info-panel').classList.remove('hidden');
  content.scrollTop = 0;
}

function wireSpeciesChips(reopen) {
  document.querySelectorAll('#info-content .species-chip.known').forEach(btn => {
    btn.addEventListener('click', () => openSpeciesCard(btn.dataset.species, reopen));
  });
}

function openNaturePanel(p) {
  const species = parseMaybeJSON(p.species_he);
  const speciesHtml = speciesChipsHtml(species);
  openInfoPanel({
    id: p.id,
    name_he: p.name_he,
    name_en: p.name_en,
    extra_html: `${speciesHtml}${p.season_he ? `<div class="season">מתי לראות: ${p.season_he}</div>` : ''}`,
    description_he: p.description_he || '',
    sources: parseMaybeJSON(p.sources)
  }, 'nature');
  wireSpeciesChips(() => openNaturePanel(p));
}

function openGeologyPanel(props) {
  openInfoPanel({
    id: props.id,
    name_he: props.name_he,
    name_en: props.name_en,
    description_he: `<strong>${props.rock_summary_he || ''}</strong><br>${props.description_he || ''}`,
    rock_photo: props.rock_photo,
    sources: parseMaybeJSON(props.sources)
  }, 'geology');
}

/* ---- Official visitor sites (INPA / KKL) --------------------------------
   Prices and opening hours are the one kind of fact in this app that goes
   stale on its own, and a guide quoting last year's price to a paying group
   is a real problem. So the bundled copy is always labelled with the date it
   was captured, the official page is one tap away, and when there is a
   connection the panel re-checks the live source and says so. */

function priceTableHtml(prices) {
  if (!prices || !prices.length) return '';
  return prices.map(tab => `
    <div class="price-block">
      <strong>${tab.title}</strong>
      <table class="price-table">
        ${tab.rows.map(r => `<tr><td>${r.type}</td><td class="p">${r.price}</td></tr>
          ${r.note ? `<tr class="note-row"><td colspan="2">${r.note}</td></tr>` : ''}`).join('')}
      </table>
    </div>`).join('');
}

function hoursHtml(hours, special) {
  let out = '';
  if (hours && hours.length) {
    out += `<table class="hours-table">${hours.map(h =>
      `<tr><td>${h.label}</td><td class="p">${h.open || '—'}${h.close ? '–' + h.close : ''}</td></tr>`).join('')}</table>`;
  }
  if (special) out += `<p class="hours-special">${special.replace(/\n/g, '<br>')}</p>`;
  return out;
}

function renderVisitorBody(props, freshness) {
  const prices = parseMaybeJSON(props.prices);
  const hours = parseMaybeJSON(props.hours);
  const attrs = parseMaybeJSON(props.attrs);
  const op = VISITOR_OPERATORS[props.operator] || { label: '' };
  const attrHtml = attrs && !Array.isArray(attrs) && Object.keys(attrs).length
    ? `<div class="species-list">${Object.entries(attrs).map(([k, v]) => `<span class="species-chip">${k}: ${v}</span>`).join('')}</div>`
    : '';
  return `
    <div class="operator-tag" style="background:${op.color || '#8A7A63'}">${op.label}</div>
    ${attrHtml}
    ${hours.length || props.hours_special ? `<h4>שעות פתיחה</h4>${hoursHtml(hours, props.hours_special)}` : ''}
    ${prices.length ? `<h4>מחירים</h4>${priceTableHtml(prices)}` : ''}
    <div class="freshness ${freshness.state}">${freshness.text}</div>
    ${props.phone ? `<p class="visitor-phone">${props.phone.replace(/\n/g, '<br>')}</p>` : ''}
    ${props.highlights ? `<h4>נגישות ומידע</h4><p>${props.highlights.replace(/\n/g, '<br>')}</p>` : ''}
    ${props.info ? `<p>${props.info}</p>` : ''}
    ${props.link ? `<div class="sources"><a href="${props.link}" target="_blank" rel="noopener">העמוד הרשמי — מחירים ושעות מעודכנים</a></div>` : ''}`;
}

async function openVisitorPanel(props) {
  const panel = document.getElementById('info-panel');
  const content = document.getElementById('info-content');
  if (window.innerWidth < 900) {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('sidebar-backdrop').classList.add('hidden');
  }
  const stale = { state: 'stale', text: `המחירים והשעות כאן נשמרו בתאריך ${props.fetched_on} — יש לאמת מול העמוד הרשמי לפני שמוסרים ללקוח.` };
  const render = (p, fresh) => {
    content.innerHTML = `<h3>${p.name_he}</h3>${renderVisitorBody(p, fresh)}`;
  };
  const canCheck = navigator.onLine && props.operator === 'inpa' && props.source_id;
  render(props, canCheck ? { state: 'checking', text: 'בודק מול האתר הרשמי…' } : stale);
  panel.classList.remove('hidden');
  if (!canCheck) return;

  // Field reality: signal is often present but useless. Without a deadline the
  // panel would sit on "checking…" indefinitely instead of falling back to the
  // saved copy, which is the one thing that must never happen out on a tour.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(INPA_API + props.source_id, { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const live = await res.json();
    const merged = Object.assign({}, props, normalizeInpaLive(live, props));
    render(merged, { state: 'fresh', text: 'המחירים והשעות אומתו מול האתר הרשמי הרגע.' });
  } catch (err) {
    console.warn('Live INPA check failed, showing the saved copy:', err.name === 'AbortError' ? 'timeout' : err.message);
    render(props, stale);
  } finally {
    clearTimeout(timer);
  }
}

// Reduce a live parks.org.il record down to the same shape the bundled copy uses.
function normalizeInpaLive(live, fallback) {
  const strip = v => {
    if (v === null || v === undefined || v === false) return '';
    if (typeof v === 'object' && v.rendered !== undefined) v = v.rendered;
    return String(v).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const out = {};
  const oh = live.Park_information_on_time;
  if (oh && typeof oh === 'object') {
    const pairs = [
      ['Summer_Opening_Hours_s', 'Summer_Closing_Hours_s', 'קיץ א׳-ה׳'],
      ['Opening_Hours_Summer_Time_Friday', 'Closing_Hours_Summer_Time_Friday', 'קיץ שישי/ערב חג'],
      ['Winter_Opening_Hours_s', 'Winter_Closing_Hours_s', 'חורף א׳-ה׳'],
      ['Opening_Hours_Winter_Time_Friday', 'Closing_Hours_Winter_Time_Friday', 'חורף שישי/ערב חג']
    ];
    const hours = pairs.map(([o, c, label]) => ({ label, open: strip(oh[o]), close: strip(oh[c]) }))
                       .filter(h => h.open || h.close);
    if (hours.length) out.hours = hours;
    out.hours_special = strip(oh.Special_Opening_hours_s);
  }
  if (Array.isArray(live.price_list)) {
    const prices = live.price_list.map(tab => ({
      title: strip(tab.rp_sales_tab_title) || 'מחירון',
      rows: (tab.table || []).map(r => ({ type: strip(r.type), price: strip(r.price), note: strip(r.note) }))
                             .filter(r => r.type)
    })).filter(t => t.rows.length);
    if (prices.length) out.prices = prices;
  }
  return Object.keys(out).length ? out : fallback;
}

// Photo of the rock itself. The caption names what the picture actually shows,
// because one photo can illustrate several units that share a rock type — the
// reader should never assume it was taken inside the unit they tapped.
function rockPhotoHtml(photo) {
  if (!photo || !photo.file) return '';
  const credit = [photo.author, photo.license].filter(Boolean).join(' · ');
  const creditHtml = photo.source_url
    ? `<a href="${photo.source_url}" target="_blank" rel="noopener">${credit}</a>`
    : credit;
  return `
    <figure class="rock-photo">
      <img src="${photo.file}" alt="${photo.title || 'סלע אופייני'}" loading="lazy" />
      <figcaption>${photo.title || ''}<span class="credit">${creditHtml}</span></figcaption>
    </figure>`;
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
  updateRouteOnMap();
}

/* ---- Route drawing & driving time ---------------------------------------
   Real road routing needs a routing service, which needs a connection. When
   there is one we ask OSRM and cache the answer; when there isn't we fall back
   to straight lines between stops with an openly-labelled time estimate, so the
   route builder still works in the field with no signal. */

const ROUTE_CACHE_PREFIX = 'ihm_route_geom_';
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
// Straight-line km underestimate real road distance; this is the usual fudge
// factor for mixed Israeli roads, paired with a conservative average speed.
const ROAD_WINDING_FACTOR = 1.3;
const ESTIMATED_AVG_KMH = 65;

function routeStopCoords() {
  const byId = new Map(state.sitesGeoJSON.features.map(f => [f.properties.id, f.geometry.coordinates]));
  return state.route.map(r => ({ id: r.id, name_he: r.name_he, coord: byId.get(r.id) }))
                    .filter(s => Array.isArray(s.coord));
}

function straightLineRoute(stops) {
  let km = 0;
  for (let i = 1; i < stops.length; i++) {
    km += haversine(stops[i - 1].coord[1], stops[i - 1].coord[0], stops[i].coord[1], stops[i].coord[0]);
  }
  km *= ROAD_WINDING_FACTOR;
  return {
    estimated: true,
    distanceKm: km,
    durationMin: (km / ESTIMATED_AVG_KMH) * 60,
    geometry: { type: 'LineString', coordinates: stops.map(s => s.coord) }
  };
}

async function fetchOsrmRoute(stops) {
  const path = stops.map(s => `${s.coord[0]},${s.coord[1]}`).join(';');
  const cacheKey = ROUTE_CACHE_PREFIX + path;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through and refetch */ }
  }
  const res = await fetch(`${OSRM_URL}${path}?overview=full&geometries=geojson`);
  if (!res.ok) throw new Error('routing service returned ' + res.status);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('no route found');
  const r = data.routes[0];
  const result = {
    estimated: false,
    distanceKm: r.distance / 1000,
    durationMin: r.duration / 60,
    geometry: r.geometry
  };
  try { localStorage.setItem(cacheKey, JSON.stringify(result)); } catch (e) { /* quota, not fatal */ }
  return result;
}

function drawRoute(result, stops) {
  if (!map || !map.getSource('route')) return;
  map.getSource('route').setData({
    type: 'FeatureCollection',
    features: result ? [{ type: 'Feature', properties: {}, geometry: result.geometry }] : []
  });
  map.getSource('route-stops').setData({
    type: 'FeatureCollection',
    features: stops.map((s, i) => ({
      type: 'Feature',
      properties: { label: String(i + 1), name_he: s.name_he },
      geometry: { type: 'Point', coordinates: s.coord }
    }))
  });
  if (map.getLayer('route-line')) {
    map.setPaintProperty('route-line', 'line-dasharray', result && result.estimated ? [1.6, 1.2] : [1, 0]);
  }
}

function formatDuration(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} שע' ${m} דק'` : `${m} דק'`;
}

function renderRouteSummary(result, stopCount) {
  const el = document.getElementById('route-summary');
  if (!el) return;
  if (!result || stopCount < 2) { el.textContent = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const head = `${Math.round(result.distanceKm)} ק"מ · ${formatDuration(result.durationMin)} נסיעה`;
  el.innerHTML = result.estimated
    ? `<strong>${head}</strong><span class="route-note">הערכה בלבד — קו אווירי, בלי חיבור לאינטרנט אין חישוב לפי כבישים בפועל.</span>`
    : `<strong>${head}</strong><span class="route-note">לפי כבישים בפועל (OSRM). לא כולל זמני עצירה בכל אתר.</span>`;
}

let routeRequestToken = 0;
async function updateRouteOnMap() {
  const stops = routeStopCoords();
  const token = ++routeRequestToken;
  if (stops.length < 2) {
    drawRoute(null, stops);
    renderRouteSummary(null, stops.length);
    return;
  }
  // Show the straight-line version immediately so the map never sits empty
  // while the routing request is in flight.
  const fallback = straightLineRoute(stops);
  drawRoute(fallback, stops);
  renderRouteSummary(fallback, stops.length);

  if (!navigator.onLine) return;
  try {
    const real = await fetchOsrmRoute(stops);
    if (token !== routeRequestToken) return;   // a newer edit already superseded this
    drawRoute(real, stops);
    renderRouteSummary(real, stops.length);
  } catch (err) {
    console.warn('Routing unavailable, keeping straight-line estimate:', err.message);
  }
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
  status.textContent = 'מוריד את המפה ונתוני הגובה (כ-116MB, פעם אחת בלבד)...';
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
// Place names stay put throughout, and get a heavier halo so they stay legible
// once they are sitting on saturated rock colors instead of pale paper.
function updateBaseMapDeclutter() {
  const regionsOn = document.getElementById('toggle-regions').checked;
  const geologyOn = document.getElementById('toggle-geology').checked;
  const thematic = regionsOn || geologyOn;
  THEMATIC_DECLUTTER_LAYERS.forEach(id => setLayerVisibility(id, !thematic));
  PLACE_LABEL_LAYERS.forEach(id => {
    if (!map.getLayer(id)) return;
    map.setPaintProperty(id, 'text-halo-width', thematic ? 2.4 : 1.4);
    map.setPaintProperty(id, 'text-halo-blur', thematic ? 0.4 : 1);
  });
}

/* ---- UI wiring ---- */
function wireUI() {
  document.getElementById('toggle-regions').addEventListener('change', e => {
    setLayerVisibility('regions-fill', e.target.checked);
    setLayerVisibility('regions-line', e.target.checked);
    document.getElementById('regions-legend').classList.toggle('hidden', !e.target.checked);
    updateBaseMapDeclutter();
  });

  const searchInput = document.getElementById('search-input');
  let searchTimer;
  document.getElementById('btn-search').addEventListener('click', openSearch);
  document.getElementById('btn-close-search').addEventListener('click', closeSearch);
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value;
    searchTimer = setTimeout(() => renderSearchResults(runSearch(q), q), 120);
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSearch();
    if (e.key === 'Enter') {
      const first = document.querySelector('#search-results .search-result');
      if (first) first.click();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSearch();
  });

  document.getElementById('toggle-visitor').addEventListener('change', e => {
    ['visitor-clusters', 'visitor-cluster-count', 'visitor-points']
      .forEach(id => setLayerVisibility(id, e.target.checked));
    document.getElementById('visitor-note').classList.toggle('hidden', !e.target.checked);
    document.getElementById('visitor-filters').classList.toggle('dimmed', !e.target.checked);
    document.querySelector('.operator-actions').classList.toggle('dimmed', !e.target.checked);
  });
  document.getElementById('btn-visitor-all').addEventListener('click', showAllOperators);

  document.getElementById('toggle-nature').addEventListener('change', e => {
    setLayerVisibility('nature-points', e.target.checked);
    document.getElementById('nature-filters').classList.toggle('hidden', !e.target.checked);
  });

  document.getElementById('toggle-contours').addEventListener('change', e => {
    setLayerVisibility('contour-lines', e.target.checked);
    setLayerVisibility('contour-labels', e.target.checked);
  });

  const topoStrong = document.getElementById('toggle-topo-strong');
  document.getElementById('toggle-topo').addEventListener('change', e => {
    setLayerVisibility('hillshade', e.target.checked);
    document.getElementById('topo-strong-row').classList.toggle('hidden', !e.target.checked);
  });
  topoStrong.addEventListener('change', e => {
    if (!map.getLayer('hillshade')) return;
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', e.target.checked ? 0.85 : 0.45);
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
