const CATEGORY_META = {
  all: {
    label: 'All colours',
    color: '#182126',
    description: 'Show every colour category in the current map view.',
  },
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

const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_OPTIONS = [
  { key: 'Mon', label: 'Monday' },
  { key: 'Tue', label: 'Tuesday' },
  { key: 'Wed', label: 'Wednesday' },
  { key: 'Thu', label: 'Thursday' },
  { key: 'Fri', label: 'Friday' },
  { key: 'Sat', label: 'Saturday' },
  { key: 'Sun', label: 'Sunday' },
];

const state = {
  activeView: 'roadSides',
  activeCategory: 'all',
  data: null,
  map: null,
  layerGroup: null,
  layersBySegmentId: new Map(),
  searchMarker: null,
  selectedDay: null,
  selectedTime: null,
};

const statusLine = document.getElementById('status-line');
const summaryLine = document.getElementById('summary-line');
const viewToggle = document.getElementById('view-toggle');
const daySelect = document.getElementById('day-select');
const timeInput = document.getElementById('time-input');
const timeStatus = document.getElementById('time-status');
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
  const color = CATEGORY_META[segment.activeCategory]?.color ?? CATEGORY_META.other.color;

  return {
    color,
    weight: 7,
    opacity: 0.92,
    lineCap: 'round',
    lineJoin: 'round',
  };
}

function popupHtml(segment) {
  const activeFilterMeta = CATEGORY_META[state.activeCategory] ?? CATEGORY_META.all;
  const activeViewLabel = state.activeView === 'roadSides' ? 'Road sides' : 'Merged roads';
  const zoneList = segment.zoneDetails
    .map(
      (detail) => `
        <li>
          <strong>Zone ${escapeHtml(detail.zoneNumber)}</strong>
          ${escapeHtml(detail.activeSummary)}
        </li>`,
    )
    .join('');
  const activeSummary = segment.activeSummary || 'No timed parking restriction is active at the selected day and time.';

  return `
    <article>
      <h3 class="popup-title">${escapeHtml(segment.streetName)}</h3>
      <p class="popup-subtitle">
        ${escapeHtml(segment.streetFrom)} to ${escapeHtml(segment.streetTo)}
      </p>
      <div class="popup-meta">
        <div class="popup-pills">
          <span class="popup-pill" style="background:${CATEGORY_META[segment.activeCategory]?.color ?? CATEGORY_META.other.color}">
            ${escapeHtml(segment.activeCategoryLabel)}
          </span>
          <span class="popup-pill popup-pill-secondary">
            View: ${escapeHtml(activeViewLabel)}
          </span>
          <span class="popup-pill popup-pill-secondary">
            Filter: ${escapeHtml(activeFilterMeta.label)}
          </span>
          <span class="popup-pill popup-pill-secondary">
            Time: ${escapeHtml(formatSelectedMoment())}
          </span>
        </div>
        <div><strong>Road segment:</strong> ${escapeHtml(segment.roadSegment)}</div>
        <div><strong>Displayed view:</strong> ${escapeHtml(
          state.activeView === 'roadSides'
            ? `Kerbside trace ${segment.traceIndex} of ${segment.traceCount}`
            : `Merged road segment with ${segment.traceCount} road sides`,
        )}</div>
        <div><strong>Active rule:</strong> ${escapeHtml(activeSummary)}</div>
        <div><strong>Zone numbers:</strong> ${escapeHtml(segment.zoneNumbers.join(', '))}</div>
        <div><strong>Loading zone active now:</strong> ${segment.hasActiveLoadingZone ? 'Yes' : 'No'}</div>
      </div>
      <ul class="popup-list">${zoneList}</ul>
    </article>
  `;
}

function renderLegendKey() {
  const counts = getVisibleCountsByCategory();
  const keys = ['all', 'metered', 'timed', 'loading', 'priority', 'mixed', 'other'];

  legendKey.innerHTML = keys
    .map((key) => {
      const meta = CATEGORY_META[key];
      const isActive = state.activeCategory === key;

      return `
        <button
          class="legend-key-item ${isActive ? 'is-active' : ''}"
          data-category="${key}"
          type="button"
        >
          <span class="legend-key-swatch" style="background:${meta.color}"></span>
          <div>
            <span class="legend-key-title">${meta.label}</span>
            <span class="legend-key-copy">${meta.description}</span>
            <span class="legend-key-count">${counts[key] ?? 0} visible in this view</span>
          </div>
        </button>`;
    })
    .join('');

  for (const button of legendKey.querySelectorAll('.legend-key-item')) {
    button.addEventListener('click', () => {
      state.activeCategory = button.dataset.category;
      renderLegendKey();
      renderLegend();
      renderSegments(false);
    });
  }
}

function getActiveViewData() {
  return state.data?.views?.[state.activeView];
}

function initialiseTimeControls() {
  const now = new Date();
  state.selectedDay = DAY_KEYS[now.getDay()];
  state.selectedTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  daySelect.innerHTML = DAY_OPTIONS.map(
    (option) => `<option value="${option.key}">${option.label}</option>`,
  ).join('');
  daySelect.value = state.selectedDay;
  timeInput.value = state.selectedTime;

  daySelect.addEventListener('change', () => {
    state.selectedDay = daySelect.value;
    updateTimeStatus();
    renderLegendKey();
    renderLegend();
    renderSegments(false);
  });

  timeInput.addEventListener('input', () => {
    state.selectedTime = timeInput.value || '00:00';
    updateTimeStatus();
    renderLegendKey();
    renderLegend();
    renderSegments(false);
  });
}

function formatSelectedMoment() {
  const dayLabel = DAY_OPTIONS.find((option) => option.key === state.selectedDay)?.label ?? state.selectedDay;
  return `${dayLabel} ${state.selectedTime}`;
}

function updateTimeStatus() {
  timeStatus.textContent = `Showing parking rules active in Melbourne at ${formatSelectedMoment()}.`;
}

function expandDayRange(startDay, endDay) {
  const startIndex = DAY_KEYS.indexOf(startDay);
  const endIndex = DAY_KEYS.indexOf(endDay);

  if (startIndex === -1 || endIndex === -1) {
    return [];
  }

  const days = [];
  let index = startIndex;
  while (true) {
    days.push(DAY_KEYS[index]);
    if (index === endIndex) {
      break;
    }
    index = (index + 1) % DAY_KEYS.length;
  }

  return days;
}

function parseDays(daysText) {
  if (!daysText || daysText === 'Days not listed') {
    return new Set(DAY_KEYS);
  }

  const normalized = String(daysText).replace(/\s+/g, '');
  const parts = normalized.split(',');
  const days = new Set();

  for (const part of parts) {
    if (!part) {
      continue;
    }

    if (part.includes('-')) {
      const [startDay, endDay] = part.split('-');
      for (const day of expandDayRange(startDay, endDay)) {
        days.add(day);
      }
      continue;
    }

    if (DAY_KEYS.includes(part)) {
      days.add(part);
    }
  }

  return days.size > 0 ? days : new Set(DAY_KEYS);
}

function toMinutes(timeText) {
  if (!timeText) {
    return null;
  }

  const match = String(timeText).match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

function restrictionMatchesMoment(restriction) {
  const activeDays = parseDays(restriction.days);
  if (!activeDays.has(state.selectedDay)) {
    return false;
  }

  if (!restriction.hours || restriction.hours === 'Hours not listed' || restriction.hours === 'All day') {
    return true;
  }

  const [startText, endText] = restriction.hours.split('-');
  const startMinutes = toMinutes(startText);
  const endMinutes = toMinutes(endText);
  const selectedMinutes = toMinutes(state.selectedTime);

  if (startMinutes == null || endMinutes == null || selectedMinutes == null) {
    return false;
  }

  if (startMinutes === endMinutes) {
    return true;
  }

  if (endMinutes > startMinutes) {
    return selectedMinutes >= startMinutes && selectedMinutes < endMinutes;
  }

  return selectedMinutes >= startMinutes || selectedMinutes < endMinutes;
}

function chooseCategoryFromZoneDetails(zoneDetails) {
  const categories = [...new Set(zoneDetails.flatMap((detail) => detail.categories))];

  if (categories.length === 0) {
    return 'other';
  }

  if (categories.includes('loading')) {
    return 'loading';
  }

  if (categories.length === 1) {
    return categories[0];
  }

  return 'mixed';
}

function decorateSegmentForSelectedMoment(segment) {
  const zoneDetails = segment.zoneDetails.map((detail) => {
    const activeRestrictions = detail.restrictions.filter(restrictionMatchesMoment);
    const activeCategories = [...new Set(activeRestrictions.map((restriction) => {
      const normalized = String(restriction.restriction ?? '').trim().toUpperCase();
      return normalized.startsWith('LZ')
        ? 'loading'
        : normalized.startsWith('MP')
          ? 'metered'
          : /^\d+P$/.test(normalized)
            ? 'timed'
            : ['PP', 'QP', 'SP', 'HP'].includes(normalized) || normalized.startsWith('FP') || normalized.startsWith('DP')
              ? 'priority'
              : 'other';
    }))];

    return {
      ...detail,
      activeRestrictions,
      activeSummary:
        activeRestrictions.length > 0
          ? buildActiveSummary(activeRestrictions)
          : 'No active restriction at the selected day and time.',
      categories: activeCategories,
      hasLoadingZone: activeCategories.includes('loading'),
    };
  });
  const activeZoneDetails = zoneDetails.filter((detail) => detail.activeRestrictions.length > 0);
  const activeCategory = chooseCategoryFromZoneDetails(activeZoneDetails);

  return {
    ...segment,
    zoneDetails,
    activeZoneDetails,
    activeCategory,
    activeCategoryLabel:
      activeZoneDetails.length > 0
        ? CATEGORY_META[activeCategory]?.label ?? CATEGORY_META.other.label
        : 'No active restriction',
    activeSummary:
      activeZoneDetails.length > 0
        ? activeZoneDetails.map((detail) => `Zone ${detail.zoneNumber}: ${detail.activeSummary}`).join('; ')
        : '',
    hasActiveLoadingZone: activeZoneDetails.some((detail) => detail.hasLoadingZone),
  };
}

function buildActiveSummary(restrictions) {
  const grouped = new Map();

  for (const restriction of restrictions) {
    const label = restriction.restrictionLabel || 'Unknown restriction';
    if (!grouped.has(label)) {
      grouped.set(label, []);
    }
    grouped.get(label).push(restriction.hours === 'Hours not listed' ? 'All day' : restriction.hours);
  }

  return Array.from(grouped.entries())
    .map(([label, windows]) => `${label}: ${windows.join(', ')}`)
    .join('; ');
}

function getDecoratedActiveFeatures() {
  return getActiveViewData().features.map(decorateSegmentForSelectedMoment);
}

function getVisibleSegments() {
  const features = getDecoratedActiveFeatures();

  return state.activeCategory === 'all'
    ? features
    : features.filter((segment) => segment.activeCategory === state.activeCategory);
}

function getVisibleCountsByCategory() {
  const counts = {
    all: 0,
    metered: 0,
    timed: 0,
    loading: 0,
    priority: 0,
    mixed: 0,
    other: 0,
  };

  for (const segment of getDecoratedActiveFeatures()) {
    counts.all += 1;
    counts[segment.activeCategory] += 1;
  }

  return counts;
}

function renderViewToggle() {
  const options = [
    { key: 'roadSides', label: 'Road sides' },
    { key: 'mergedSegments', label: 'Merged roads' },
  ];

  viewToggle.innerHTML = options
    .map(
      (option) => `
        <button
          class="view-toggle-button ${state.activeView === option.key ? 'is-active' : ''}"
          data-view="${option.key}"
          type="button"
        >
          ${option.label}
        </button>`,
    )
    .join('');

  for (const button of viewToggle.querySelectorAll('.view-toggle-button')) {
    button.addEventListener('click', () => {
      state.activeView = button.dataset.view;
      renderViewToggle();
      renderLegendKey();
      renderLegend();
      renderSegments(false);
    });
  }
}

function renderLegend() {
  const counts = getVisibleCountsByCategory();
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
      renderLegendKey();
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
  const activeViewData = getActiveViewData();
  const visibleSegments = getVisibleSegments();

  const layers = [];
  for (const segment of visibleSegments) {
    const coordinateGroups =
      state.activeView === 'roadSides'
        ? [segment.coordinates]
        : segment.coordinateGroups;
    const layer =
      coordinateGroups.length === 1 && coordinateGroups[0].length === 1
        ? L.circleMarker(coordinateGroups[0][0], {
            radius: 6,
            fillColor: CATEGORY_META[segment.activeCategory]?.color ?? CATEGORY_META.other.color,
            color: '#ffffff',
            weight: 2,
            fillOpacity: 0.95,
          })
        : L.polyline(coordinateGroups, segmentStyle(segment));

    layer.bindPopup(popupHtml(segment), {
      maxWidth: 320,
      autoPanPaddingTopLeft: [20, 120],
      autoPanPaddingBottomRight: [20, 180],
    });
    state.layersBySegmentId.set(segment.segmentId, layer);
    layers.push(layer);
  }

  state.layerGroup = L.featureGroup(layers).addTo(state.map);

  const total = activeViewData.featureCount;
  summaryLine.textContent = `${visibleSegments.length} of ${total} ${state.activeView === 'roadSides' ? 'road sides' : 'merged road segments'} shown for ${formatSelectedMoment()}`;

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

  for (const segment of getVisibleSegments()) {
    let bestDistance = Number.POSITIVE_INFINITY;
    const coordinateGroups =
      state.activeView === 'roadSides'
        ? [segment.coordinates]
        : segment.coordinateGroups;

    for (const group of coordinateGroups) {
      for (const coordinate of group) {
        const distance = haversineDistanceMeters(
          { lat: searchResult.latitude, lon: searchResult.longitude },
          { lat: coordinate[0], lon: coordinate[1] },
        );

        if (distance < bestDistance) {
          bestDistance = distance;
        }
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
  renderViewToggle();
  renderLegendKey();
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
  initialiseTimeControls();
  updateTimeStatus();

  try {
    const response = await fetch('/data/segment-map-data.json', { cache: 'no-store' });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    state.data = await response.json();
    statusLine.textContent = `Live segment data generated ${new Date(state.data.generatedAt).toLocaleString()}`;
    renderLegendKey();
    renderViewToggle();
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
