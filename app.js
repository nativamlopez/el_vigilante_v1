// Crear el mapa Leaflet
const map = L.map('map', {
  center: [-18.810972, -59.794592],
  zoom: 8,
  zoomControl: true
});

// Capas base
const baseOSM = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);

const baseSat = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: '&copy; Esri, Maxar' }
);
const basemaps = { osm: baseOSM, sat: baseSat };

// Capas demo
const puntosLayer = L.layerGroup([
  L.marker([-16.5, -68.13]).bindPopup('La Paz'),
  L.marker([-17.8, -63.18]).bindPopup('Santa Cruz'),
  L.marker([-19.0, -65.26]).bindPopup('Sucre')
]);

const rutaLayer = L.polyline(
  [[-17.7, -63.3], [-18.0, -63.1], [-18.2, -63.3]],
  { color: '#26d07c', weight: 4 }
);

// Control del menú
const menuBtn = document.getElementById('menuToggle');
const dropdown = document.getElementById('dropdown');

function toggleMenu(){
  const hidden = dropdown.getAttribute('aria-hidden') !== 'false';
  dropdown.setAttribute('aria-hidden', hidden ? 'false' : 'true');
}
menuBtn.addEventListener('click', toggleMenu);
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-wrap')) dropdown.setAttribute('aria-hidden', 'true');
});

// Eventos
document.querySelectorAll('input[name="basemap"]').forEach(radio => {
  radio.addEventListener('change', e => {
    Object.values(basemaps).forEach(l => map.removeLayer(l));
    basemaps[e.target.value].addTo(map);
  });
});

document.getElementById('chkPuntos').addEventListener('change', e => {
  e.target.checked ? puntosLayer.addTo(map) : map.removeLayer(puntosLayer);
});
document.getElementById('chkRutas').addEventListener('change', e => {
  e.target.checked ? rutaLayer.addTo(map) : map.removeLayer(rutaLayer);
});

document.getElementById('btnCentrar').addEventListener('click', () => map.setView([-18.810972, -59.794592], 8));

/*============================= FIRMS SCRIPT ============================= */
//---------------- Constantes Iniciales -----------------//
// 1) Reemplaza con tu MAP_KEY de FIRMS
const MAP_KEY = '5af33db19b8f702e3a8bfd0db0418a04';

// 2) Define tu BBOX [W, S, E, N] (ejemplo aproximado: zona Chaco tarijeño)
const BBOX_AOI = [-64.9, -22.5, -57.0, -16.0];

// 3) Sensores VIIRS (puedes desactivar alguno en la UI)
const DEFAULT_SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];

// 4) Auto-actualización (milisegundos). 15 minutos = 900000 ms
const AUTO_REFRESH_MS = 15 * 60 * 1000;
//---------------------------Capa Firms (Api Area CSV)--------------------------//
// Contenedor de la capa de puntos
const firmsLayer = L.layerGroup().addTo(map);

// Estado simple
const $status = document.getElementById('status');
function setStatus(msg){ $status.textContent = msg; }

// UI
const $chkFirms = document.getElementById('chkFirms');
const $inpDays  = document.getElementById('inpDays');
const $btnRefresh = document.getElementById('btnRefresh');
const $sensorInputs = Array.from(document.querySelectorAll('.sensor'));

// Helpers
function buildAreaUrl({ mapKey, source, bbox, days }){
  // Validaciones mínimas
  const d = Math.max(1, Math.min(10, Number(days) || 1));
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('BBOX inválido');
  return `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${source}/${bbox.join(',')}/${d}`;
}

async function fetchCSV(url){
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    const txt = await resp.text().catch(()=> '');
    throw new Error(`HTTP ${resp.status} – ${txt.slice(0,120)}`);
  }
  return resp.text();
}

// Parseador CSV sencillo (asume que no hay comas entrecomilladas en los campos)
function parseCSVtoFeatures(csvText){
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];

  const headers = lines.shift().split(',');
  const idx = (name) => headers.indexOf(name);

  const iLat = idx('latitude');
  const iLon = idx('longitude');
  const iDate= idx('acq_date');
  const iTime= idx('acq_time');
  const iConf= idx('confidence');   // VIIRS: low/nominal/high o porcentaje según producto
  const iFRP = idx('frp');          // Fire Radiative Power
  const iSat = idx('satellite');    // S-NPP, NOAA-20/21, etc.
  const iInst= idx('instrument');   // VIIRS

  const feats = [];

  for (const raw of lines) {
    const cols = raw.split(',');
    const lat = parseFloat(cols[iLat]);
    const lon = parseFloat(cols[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // Normalizamos hora (HHMM) → HH:MM
    let hhmm = (cols[iTime] || '').padStart(4,'0');
    const timeFmt = `${hhmm.slice(0,2)}:${hhmm.slice(2,4)}`;

    feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        acq_date: cols[iDate] || '',
        acq_time: timeFmt,
        confidence: cols[iConf] || '',
        frp: cols[iFRP] || '',
        satellite: cols[iSat] || '',
        instrument: cols[iInst] || ''
      }
    });
  }
  return feats;
}

// Dedupe por (lon,lat,fecha,hora)
function dedupeFeatures(feats){
  const seen = new Set();
  const out = [];
  for (const f of feats) {
    const p = f.properties;
    const g = f.geometry && f.geometry.coordinates;
    if (!g) continue;
    const key = `${g[0].toFixed(5)}|${g[1].toFixed(5)}|${p.acq_date}|${p.acq_time}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

// Estilo por confianza (puedes ajustarlo)
function styleByConfidence(conf){
  const v = String(conf).toLowerCase();
  if (v.includes('h') || Number(v) >= 80) return { color:'#ff0000', fillColor:'#ff0000' };
  if (v.includes('n') || Number(v) >= 40) return { color:'#ff8c00', fillColor:'#ff8c00' };
  if (v.includes('l') || Number(v) >= 1) return { color:'#ffd000', fillColor:'#ffd000' };
  return { color:'#0d00ffff', fillColor:'#2f00ffff' };
}

// Renderiza en firmsLayer
function renderFirms(feats){
  firmsLayer.clearLayers();

  const geojson = {
    type: 'FeatureCollection',
    features: feats
  };

  const layer = L.geoJSON(geojson, {
    pointToLayer: (feature, latlng) => {
      const { confidence, frp } = feature.properties;
      const base = styleByConfidence(confidence);
      // Radios por FRP (simple)
      let r = 4;
      const frpNum = Number(frp);
      if (Number.isFinite(frpNum)) {
        if (frpNum > 50) r = 8;
        else if (frpNum > 20) r = 6;
      }
      return L.circleMarker(latlng, {
        radius: r,
        color: base.color,
        fillColor: base.fillColor,
        weight: 1,
        fillOpacity: 0.8
      });
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      layer.bindPopup(
        `<b>Foco VIIRS</b><br>
        Fecha: ${p.acq_date} ${p.acq_time}<br>
        Confianza: ${p.confidence}<br>
        FRP: ${p.frp}<br>
        Satélite: ${p.satellite}`
      );
    }
  });

  layer.addTo(firmsLayer);
  setStatus(`Mostrando ${feats.length} focos (VIIRS).`);
}

// Carga desde múltiples fuentes y pinta
async function loadFirmsAndRender(){
  try {
    setStatus('Descargando datos de FIRMS…');

    // Fuentes seleccionadas en UI
    const sources = $sensorInputs
      .filter(inp => inp.checked)
      .map(inp => inp.value);

    if (sources.length === 0) {
      firmsLayer.clearLayers();
      setStatus('Sin sensores seleccionados.');
      return;
    }

    const days = Math.max(1, Math.min(10, Number($inpDays.value) || 3));

    // Descarga en paralelo
    const urls = sources.map(src => buildAreaUrl({
      mapKey: MAP_KEY, source: src, bbox: BBOX_AOI, days
    }));

    const csvs = await Promise.all(urls.map(fetchCSV));

    // Parseo y fusión
    let allFeats = [];
    for (const csv of csvs) {
      const feats = parseCSVtoFeatures(csv);
      allFeats = allFeats.concat(feats);
    }

    const unique = dedupeFeatures(allFeats);

    renderFirms(unique);

    // Si el checkbox está apagado, no mostramos (pero ya se actualizó la data)
    if (!$chkFirms.checked && map.hasLayer(firmsLayer)) {
      map.removeLayer(firmsLayer);
    }
    if ($chkFirms.checked && !map.hasLayer(firmsLayer)) {
      firmsLayer.addTo(map);
    }

  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
}


/* ================================
  EVENTOS UI + AUTO REFRESH
================================== */

$chkFirms.addEventListener('change', () => {
  if ($chkFirms.checked) {
    firmsLayer.addTo(map);
  } else {
    map.removeLayer(firmsLayer);
  }
});

$btnRefresh.addEventListener('click', () => {
  loadFirmsAndRender();
});

$inpDays.addEventListener('change', () => {
  // Clamp 1..10
  const v = Math.max(1, Math.min(10, Number($inpDays.value) || 3));
  $inpDays.value = v;
  loadFirmsAndRender();
});

$sensorInputs.forEach(inp => {
  inp.addEventListener('change', () => loadFirmsAndRender());
});

// AUTO: refresca cada 15 min (ajustable)
setInterval(() => {
  if ($chkFirms.checked) {
    loadFirmsAndRender();
  }
}, AUTO_REFRESH_MS);


/* ================================
  INICIO: carga por defecto
================================== */

// Al cargar la página: mostrar focos por defecto
(async function init(){
  setStatus('Inicializando…');
  // Capa ya está agregada por defecto (firmsLayer.addTo(map))
  await loadFirmsAndRender();
})();

// ================================
// 1) CARGAR GEOJSON POR DEFECTO
// ================================

// Ruta relativa al archivo GeoJSON
const urlGeoJSON = 'areas_prot.geojson';

// Estilo del GeoJSON (ajusta colores)
const estiloGeoJSON = {
  color: '#000000ff',     // color del borde
  weight: 2,            // grosor del borde
  fillColor: '#000000ff', // color de relleno (para polígonos)
  fillOpacity: 0.0
};

// Cargar el GeoJSON y agregarlo al mapa
fetch(urlGeoJSON)
  .then(response => response.json())  // Convertir a objeto JSON
  .then(data => {
    // Crear la capa
    const capaGeoJSON = L.geoJSON(data, {
      style: estiloGeoJSON,
      onEachFeature: function (feature, layer) {
        // Mostrar información en popup
        let contenido = '';
        for (let prop in feature.properties) {
          contenido += `<b>${prop}</b>: ${feature.properties[prop]}<br>`;
        }
        layer.bindPopup(contenido);
      }
    });

    // Agregar al mapa
    capaGeoJSON.addTo(map);

    // Ajustar el mapa a la extensión del GeoJSON
    map.fitBounds(capaGeoJSON.getBounds());
  })
  .catch(error => console.error('Error al cargar el GeoJSON:', error));

