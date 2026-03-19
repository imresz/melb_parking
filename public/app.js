const CATEGORY_META = {
  all: { label: 'All road sides', color: '#182126' },
  metered: {
    label: 'Metered parking',
    color: '#0b6ef3',
    description: 'Blue road sides use metered restrictions such as MP1P to MP4P.',
  },
  timed: {
    label: 'Timed parking',
    color: '#239b56',
    description: 'Green road sides use plain timed limits like 1P, 2P, or 4P.',
  },
  loading: {
    label: 'Loading zone',
    color: '#f76707',
    description: 'Orange road sides include at least one loading-zone rule.',
  },
  priority: {
    label: 'Permit / priority',
    color: '#a93cc6',
    description: 'Purple road sides carry permit, priority, hire, or special parking rules.',
  },
  mixed: {
    label: 'Mixed rules',
    color: '#d59b00',
    description: 'Gold road sides combine multiple non-loading rule types on the same kerb.',
  },
  other: {
    label: 'Other',
    color: '#495057',
    description: 'Grey road sides have missing or uncommon sign-plate information.',
  },
};

const state = {
  activeCategory: 'all',
  data: null,
  map: null,
  layerGroup: null,
  layersBySegmentId: new Map(),
  searchMarker: null,
};

const statusLine = document.getElementById('status-line');
const summaryLine = document.getElementById('summary-line');
const legendKey = document.getElementById('legend-key');
const legendContainer = document.getElementById('legend-chips');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const searchStatus = document.getElementById('search-status');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createMap() {
  const map = L.map('map', {
    zoomControl: false,
    preferCanvas: true,
  }).setView([-37.8136, 144.9631], 14);

  L.control
    .zoom({
      position: 'bottomright',
    })
    .addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  return map;
}

function haversineDistanceMeters(from, to) {
  const earthRadiusMeters = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(to.lat - from.lat);
  const longitudeDelta = toRadians(to.lon - from.lon);
  const fromLatitude = toRadians(from.lat);
  const toLatitude = toRadians(to.lat);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(a));
}

function segmentStyle(segment) {
  const color = CATEGORY_META[segment.category]?.color ?? CATEGORY_META.other.color;

  return {
    color,
    weight: 7,
    opacity: 0.92,
    lineCap: 'round',
    lineJoin: 'round',
  };
}

function popupHtml(segment) {
  const zoneList = segment.zoneDetails
    .map(
      (detail) => `
        <li>
          <strong>Zone ${escapeHtml(detail.zoneNumber)}</strong>
          ${escapeHtml(detail.summary)}
        </li>`,
    )
    .join('');

  return `
    <article>
      <h3 class="popup-title">${escapeHtml(segment.streetName)}</h3>
      <p class="popup-subtitle">
        ${escapeHtml(segment.streetFrom)} to ${escapeHtml(segment.streetTo)}
      </p>
      <div class="popup-meta">
        <span class="popup-pill" style="background:${CATEGORY_META[segment.category]?.color ?? CATEGORY_META.other.color}">
          ${escapeHtml(segment.categoryLabel)}
        </span>
        <div><strong>Road segment:</strong> ${escapeHtml(segment.roadSegment)}</div>
        <div><strong>Displayed side:</strong> ${escapeHtml(`Kerbside trace ${segment.traceIndex} of ${segment.traceCount}`)}</div>
        <div><strong>Zone numbers:</strong> ${escapeHtml(segment.zoneNumbers.join(', '))}</div>
        <div><strong>Loading zone present:</strong> ${segment.hasLoadingZone ? 'Yes' : 'No'}</div>
      </div>
      <ul class="popup-list">${zoneList}</ul>
    </article>
  `;
}

function renderLegendKey() {
  const keys = ['metered', 'timed', 'loading', 'priority', 'mixed', 'other'];

  legendKey.innerHTML = keys
    .map((key) => {
      const meta = CATEGORY_META[key];

      return `
        <div class="legend-key-item">
          <span class="legend-key-swatch" style="background:${meta.color}"></span>
          <div>
            <span class="legend-key-title">${meta.label}</span>
            <span class="legend-key-copy">${meta.description}</span>
          </div>
        </div>`;
    })
    .join('');
}

function renderLegend() {
  const counts = state.data.legend.countsByCategory;
  const keys = ['all', 'metered', 'timed', 'loading', 'priority', 'mixed', 'other'];

  legendContainer.innerHTML = keys
    .map((key) => {
      const meta = CATEGORY_META[key];
      const isActive = state.activeCategory === key;

      return `
        <button
          class="legend-chip ${isActive ? 'is-active' : ''}"
          style="${isActive ? `background:${meta.color}` : ''}"
          data-category="${key}"
          type="button"
        >
          <span class="legend-swatch" style="background:${meta.color}"></span>
          <span>
            <span class="legend-chip-label">${meta.label}</span>
            <span class="legend-chip-count">${counts[key] ?? 0}</span>
          </span>
        </button>`;
    })
    .join('');

  for (const button of legendContainer.querySelectorAll('.legend-chip')) {
    button.addEventListener('click', () => {
      state.activeCategory = button.dataset.category;
      renderLegend();
      renderSegments(false);
    });
  }
}

function renderSegments(fitBounds) {
  if (!state.map || !state.data) {
    return;
  }

  if (state.layerGroup) {
    state.layerGroup.remove();
  }

  state.layersBySegmentId = new Map();
  const visibleSegments =
    state.activeCategory === 'all'
      ? state.data.segments
      : state.data.segments.filter((segment) => segment.category === state.activeCategory);

  const layers = [];
  for (const segment of visibleSegments) {
    const coordinates = segment.coordinates;
    const layer =
      coordinates.length === 1
        ? L.circleMarker(coordinates[0], {
            radius: 6,
            fillColor: CATEGORY_META[segment.category]?.color ?? CATEGORY_META.other.color,
            color: '#ffffff',
            weight: 2,
            fillOpacity: 0.95,
          })
        : L.polyline(coordinates, segmentStyle(segment));

    layer.bindPopup(popupHtml(segment), {
      maxWidth: 320,
      autoPanPaddingTopLeft: [20, 120],
      autoPanPaddingBottomRight: [20, 180],
    });
    state.layersBySegmentId.set(segment.segmentId, layer);
    layers.push(layer);
  }

  state.layerGroup = L.featureGroup(layers).addTo(state.map);

  const total = state.data.stats.segmentCount;
  summaryLine.textContent = `${visibleSegments.length} of ${total} road sides visible`;

  if (fitBounds && layers.length > 0) {
    state.map.fitBounds(state.layerGroup.getBounds().pad(0.08));
  }
}

async function geocodeAddress(address) {
  const response = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({ error: 'Address not found' }));
    throw new Error(errorPayload.error ?? `Request failed with status ${response.status}`);
  }

  return response.json();
}

function findNearestSegment(searchResult) {
  let nearest = null;

  for (const segment of state.data.segments) {
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const coordinate of segment.coordinates) {
      const distance = haversineDistanceMeters(
        { lat: searchResult.latitude, lon: searchResult.longitude },
        { lat: coordinate[0], lon: coordinate[1] },
      );

      if (distance < bestDistance) {
        bestDistance = distance;
      }
    }

    if (!nearest || bestDistance < nearest.distanceMeters) {
      nearest = {
        segment,
        distanceMeters: bestDistance,
      };
    }
  }

  return nearest;
}

function showSearchMarker(searchResult) {
  if (state.searchMarker) {
    state.searchMarker.remove();
  }

  state.searchMarker = L.circleMarker([searchResult.latitude, searchResult.longitude], {
    radius: 8,
    color: '#ffffff',
    weight: 2,
    fillColor: '#182126',
    fillOpacity: 0.96,
  })
    .addTo(state.map)
    .bindTooltip('Resolved address', {
      direction: 'top',
      offset: [0, -8],
    });
}

function focusNearestSegment(searchResult, nearest) {
  state.activeCategory = 'all';
  renderLegend();
  renderSegments(false);
  showSearchMarker(searchResult);

  const layer = state.layersBySegmentId.get(nearest.segment.segmentId);
  const searchLatLng = L.latLng(searchResult.latitude, searchResult.longitude);
  const bounds = L.latLngBounds([searchLatLng]);

  if (layer) {
    const layerBounds = typeof layer.getBounds === 'function' ? layer.getBounds() : null;

    if (layerBounds && layerBounds.isValid()) {
      bounds.extend(layerBounds);
    } else if (typeof layer.getLatLng === 'function') {
      bounds.extend(layer.getLatLng());
    }
  }

  state.map.fitBounds(bounds.pad(0.35), {
    maxZoom: 18,
  });

  if (layer) {
    layer.openPopup();
  }

  searchStatus.textContent = `Resolved to ${searchResult.resolvedAddress}. Nearest segment is ${nearest.distanceMeters.toFixed(1)} m away on ${nearest.segment.streetName}.`;
}

async function handleSearchSubmit(event) {
  event.preventDefault();

  const query = searchInput.value.trim();
  if (!query || !state.data) {
    return;
  }

  searchStatus.textContent = 'Searching Melbourne addresses...';

  try {
    const searchResult = await geocodeAddress(query);
    const nearest = findNearestSegment(searchResult);

    if (!nearest) {
      throw new Error('No nearby road segment was found.');
    }

    focusNearestSegment(searchResult, nearest);
  } catch (error) {
    console.error(error);
    searchStatus.textContent = error instanceof Error ? error.message : 'Unable to search that address.';
  }
}

async function initialise() {
  state.map = createMap();

  try {
    const response = await fetch('/data/segment-map-data.json', { cache: 'no-store' });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    state.data = await response.json();
    statusLine.textContent = `Live segment data generated ${new Date(state.data.generatedAt).toLocaleString()}`;
    renderLegendKey();
    renderLegend();
    renderSegments(true);
    searchForm.addEventListener('submit', handleSearchSubmit);
  } catch (error) {
    console.error(error);
    statusLine.textContent = 'Unable to load map data. Run `npm run map:build` and refresh.';
    summaryLine.textContent = '';
  }
}

initialise();
