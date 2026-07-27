/* מפת מורשת ישראל — לוגיקת האפליקציה הראשית (ללא build step, JS פשוט) */

const ERA_COLORS = {
  prehistoric: '#9b7653',
  bronze: '#c98a3a',
  biblical: '#c0392b',
  classical: '#8e44ad',
  medieval: '#2e6da4',
  modern: '#1e8f5f'
};

const state = {
  periods: [],
  regionsGeoJSON: null,
  religions: [],
  sitesGeoJSON: { type: 'FeatureCollection', features: [] },
  periodIndex: 0,
  showFirstTemple: false,
  showSecondTemple: false,
  activeReligions: new Set(),
  route: JSON.parse(localStorage.getItem('ihm_route') || '[]')
};

let map, regionsLayer, sitesLayer, religionsLayer, nearbyMarker;

async function loadData() {
  const [periods, regions, religions, sites] = await Promise.all([
    fetch('js/data/periods.json').then(r => r.json()),
    fetch('js/data/regions.geojson').then(r => r.json()),
    fetch('js/data/religions.json').then(r => r.json()),
    fetch('js/data/sites.geojson').then(r => r.json()).catch(() => ({ type: 'FeatureCollection', features: [] }))
  ]);
  state.periods = periods.sort((a, b) => a.order - b.order);
  state.regionsGeoJSON = regions;
  state.religions = religions;
  state.sitesGeoJSON = sites;
  state.activeReligions = new Set(religions.map(r => r.id));
}

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([31.6, 35.1], 8);
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  regionsLayer = L.geoJSON(state.regionsGeoJSON, {
    style: f => ({
      color: f.properties.color,
      weight: 1,
      fillColor: f.properties.color,
      fillOpacity: 0.25
    }),
    onEachFeature: (f, layer) => {
      layer.bindTooltip(f.properties.name_he, { sticky: true });
    }
  });

  sitesLayer = L.layerGroup();
  religionsLayer = L.layerGroup();

  buildRegionsLegend();
  buildReligionFilters();
  buildPeriodSlider();
  refreshSitesLayer();
  refreshReligionsLayer();
  renderRoute();
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
  document.getElementById('period-label').textContent = `${p.name_he} (${p.name_en})`;
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
  sitesLayer.clearLayers();
  const templeFilterActive = state.showFirstTemple || state.showSecondTemple;
  const currentPeriod = state.periods[state.periodIndex];
  const era = currentPeriod.era;

  state.sitesGeoJSON.features.forEach(f => {
    const props = f.properties;
    if (!props.periods || !props.periods.length) return;
    const matches = templeFilterActive
      ? siteMatchesTempleFilter(props)
      : props.periods.includes(currentPeriod.id);
    if (!matches) return;

    const [lng, lat] = f.geometry.coordinates;
    const color = ERA_COLORS[era] || '#4fb0a8';
    const marker = L.circleMarker([lat, lng], {
      radius: 7,
      color: '#12202c',
      weight: 1,
      fillColor: color,
      fillOpacity: 0.9
    });
    marker.on('click', () => openInfoPanel(props, 'period'));
    marker.bindTooltip(props.name_he);
    sitesLayer.addLayer(marker);
  });
}

function refreshReligionsLayer() {
  religionsLayer.clearLayers();
  state.sitesGeoJSON.features.forEach(f => {
    const props = f.properties;
    if (!props.religions || !props.religions.length) return;
    const active = props.religions.filter(r => state.activeReligions.has(r));
    if (!active.length) return;

    const [lng, lat] = f.geometry.coordinates;
    const primary = state.religions.find(r => r.id === active[0]);
    const icon = L.divIcon({
      html: `<div style="background:${primary.color};color:#fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid #12202c;">${primary.icon}</div>`,
      className: '',
      iconSize: [22, 22]
    });
    const marker = L.marker([lat, lng], { icon });
    marker.on('click', () => openInfoPanel(props, 'religion'));
    marker.bindTooltip(props.name_he);
    religionsLayer.addLayer(marker);
  });
}

function openInfoPanel(props, context) {
  const panel = document.getElementById('info-panel');
  const content = document.getElementById('info-content');
  if (window.innerWidth < 900) {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('sidebar-backdrop').classList.add('hidden');
  }
  let metaBits = [];
  if (props.periods && props.periods.length) {
    metaBits.push(props.periods.map(pid => {
      const p = state.periods.find(x => x.id === pid);
      return p ? p.name_he : pid;
    }).join(', '));
  }
  if (props.religions && props.religions.length) {
    metaBits.push(props.religions.map(rid => {
      const r = state.religions.find(x => x.id === rid);
      return r ? r.name_he : rid;
    }).join(', '));
  }
  if (props.temple_era === 'first-temple') metaBits.push('תקופת בית ראשון');
  if (props.temple_era === 'second-temple') metaBits.push('תקופת בית שני');

  const sourcesHtml = (props.sources || [])
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
    map.setView([latitude, longitude], 13);
    if (nearbyMarker) map.removeLayer(nearbyMarker);
    nearbyMarker = L.marker([latitude, longitude]).addTo(map).bindPopup('המיקום שלך').openPopup();

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

/* ---- Offline tile caching ---- */
function lngLatToTile(lng, lat, z) {
  const x = Math.floor((lng + 180) / 360 * Math.pow(2, z));
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
  return { x, y };
}

async function cacheCurrentArea() {
  const status = document.getElementById('cache-status');
  const bounds = map.getBounds();
  const zBase = map.getZoom();
  const zooms = [zBase, Math.min(zBase + 1, 17), Math.min(zBase + 2, 18)];
  const subdomains = ['a', 'b', 'c'];
  const urls = [];

  zooms.forEach(z => {
    const min = lngLatToTile(bounds.getWest(), bounds.getNorth(), z);
    const max = lngLatToTile(bounds.getEast(), bounds.getSouth(), z);
    for (let x = min.x; x <= max.x; x++) {
      for (let y = min.y; y <= max.y; y++) {
        const s = subdomains[(x + y) % subdomains.length];
        urls.push(`https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`);
      }
    }
  });

  if (urls.length > 500) {
    status.textContent = `האזור גדול מדי (${urls.length} אריחים). התקרב/י יותר ונסה/י שוב (מגבלה למניעת עומס על שרת המפות).`;
    return;
  }

  status.textContent = `שומר ${urls.length} אריחים לשימוש אופליין...`;
  let done = 0;
  for (const url of urls) {
    try {
      await fetch(url, { mode: 'cors' });
    } catch (e) { /* ignore individual tile failures */ }
    done++;
    status.textContent = `שומר אריחים: ${done}/${urls.length}`;
  }
  status.textContent = `הושלם! ${urls.length} אריחים נשמרים לשימוש אופליין באזור הנוכחי.`;
}

/* ---- UI wiring ---- */
function wireUI() {
  document.getElementById('toggle-regions').addEventListener('change', e => {
    if (e.target.checked) { regionsLayer.addTo(map); document.getElementById('regions-legend').classList.remove('hidden'); }
    else { map.removeLayer(regionsLayer); document.getElementById('regions-legend').classList.add('hidden'); }
  });

  document.getElementById('toggle-periods').addEventListener('change', e => {
    if (e.target.checked) sitesLayer.addTo(map); else map.removeLayer(sitesLayer);
  });
  sitesLayer.addTo(map);

  document.getElementById('toggle-religions').addEventListener('change', e => {
    if (e.target.checked) religionsLayer.addTo(map); else map.removeLayer(religionsLayer);
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
  document.getElementById('btn-cache-area').addEventListener('click', cacheCurrentArea);

  if (window.innerWidth < 900) {
    closeSidebar();
  }

  window.addEventListener('online', () => document.getElementById('offline-indicator').classList.add('hidden'));
  window.addEventListener('offline', () => document.getElementById('offline-indicator').classList.remove('hidden'));
  if (!navigator.onLine) document.getElementById('offline-indicator').classList.remove('hidden');
}

async function main() {
  await loadData();
  initMap();
  wireUI();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  }
}

main();
