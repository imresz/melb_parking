const SENSOR_EXPORT_URL =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/on-street-parking-bay-sensors/exports/json';
const SIGN_PLATES_URL =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/sign-plates-located-in-each-parking-zone/records';
const BAY_RESTRICTIONS_URL =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/on-street-car-park-bay-restrictions/records';
const BAY_LOCATIONS_URL =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/on-street-parking-bays/records';
const SEGMENT_ZONES_URL =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/parking-zones-linked-to-street-segments/records';
const GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
const DEFAULT_LIMIT = 20;

function parseArgs(argv) {
  const args = {
    bayId: null,
    address: null,
    limit: DEFAULT_LIMIT,
  };

  for (const rawArg of argv) {
    if (rawArg.startsWith('--bay=')) {
      args.bayId = rawArg.slice('--bay='.length).trim();
      continue;
    }

    if (rawArg.startsWith('--address=')) {
      args.address = rawArg.slice('--address='.length).trim();
      continue;
    }

    if (rawArg.startsWith('--limit=')) {
      const parsedLimit = Number.parseInt(rawArg.slice('--limit='.length), 10);

      if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        args.limit = parsedLimit;
      }
    }
  }

  return args;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status} for ${url}`);
  }

  return response.json();
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatClock(value) {
  if (!value) {
    return 'All day';
  }

  const match = value.match(/(\d{2}:\d{2})(?::\d{2})?$/) ?? value.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : value;
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 'No limit listed';
  }

  if (minutes % 60 === 0) {
    return `${minutes / 60} hr`;
  }

  return `${minutes} min`;
}

function expandRestrictionCode(code) {
  if (!code) {
    return 'Unknown restriction';
  }

  const normalized = String(code).trim().toUpperCase();
  const meteredMatch = normalized.match(/^MP(\d+)(P?)$/);
  if (meteredMatch) {
    return `Metered parking ${meteredMatch[1]}${meteredMatch[2] || 'P'}`;
  }

  const parkingMatch = normalized.match(/^(\d+)(P)$/);
  if (parkingMatch) {
    return `${parkingMatch[1]}${parkingMatch[2]} parking`;
  }

  const loadingZoneMatch = normalized.match(/^LZ(\d+)$/);
  if (loadingZoneMatch) {
    return `Loading zone ${loadingZoneMatch[1]} min`;
  }

  const tokenMap = {
    LZ: 'Loading zone',
    TAXI: 'Taxi zone',
    BUS: 'Bus zone',
    CLR: 'Clearway',
    NO: 'No parking',
    DIS: 'Disability parking',
    RES: 'Resident parking',
    MTR: 'Metered parking',
  };

  for (const [token, label] of Object.entries(tokenMap)) {
    if (normalized === token || normalized.startsWith(`${token} `)) {
      return label;
    }
  }

  return normalized;
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

function normaliseSensorRow(row) {
  return {
    bayId: String(row.kerbsideid),
    status: row.status_description ?? 'n/a',
    zoneNumber: row.zone_number ?? null,
    latitude: row.location?.lat ?? null,
    longitude: row.location?.lon ?? null,
    lastUpdated: row.lastupdated ?? 'n/a',
    statusTimestamp: row.status_timestamp ?? 'n/a',
  };
}

async function fetchSensorRows() {
  const rows = await fetchJson(SENSOR_EXPORT_URL, {
    headers: {
      Accept: 'application/json',
    },
  });

  return rows
    .filter((row) => row.kerbsideid != null && row.location?.lat != null && row.location?.lon != null)
    .map(normaliseSensorRow);
}

async function fetchZoneSigns(zoneNumber) {
  if (zoneNumber == null) {
    return [];
  }

  const params = new URLSearchParams({
    where: `parkingzone=${zoneNumber}`,
    limit: '20',
  });
  const payload = await fetchJson(`${SIGN_PLATES_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
    },
  });

  const seen = new Set();
  return (payload.results ?? [])
    .map((row) => ({
      zoneNumber: row.parkingzone,
      restriction: row.restriction_display ?? 'Unknown',
      restrictionLabel: expandRestrictionCode(row.restriction_display),
      days: row.restriction_days ?? 'Days not listed',
      hours:
        row.time_restrictions_start && row.time_restrictions_finish
          ? `${formatClock(row.time_restrictions_start)}-${formatClock(row.time_restrictions_finish)}`
          : 'Hours not listed',
    }))
    .filter((row) => {
      const key = `${row.zoneNumber}|${row.restriction}|${row.days}|${row.hours}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

async function fetchZoneNumbersForRoadSegment(roadSegmentId) {
  if (roadSegmentId == null) {
    return [];
  }

  const params = new URLSearchParams({
    where: `segment_id=${roadSegmentId}`,
    limit: '20',
  });
  const payload = await fetchJson(`${SEGMENT_ZONES_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
    },
  });

  return [...new Set((payload.results ?? []).map((row) => row.parkingzone).filter((value) => value != null))];
}

async function fetchBayLocationDetails(kerbsideId) {
  const params = new URLSearchParams({
    where: `kerbsideid='${String(kerbsideId).replace(/'/g, "''")}'`,
    limit: '1',
  });
  const payload = await fetchJson(`${BAY_LOCATIONS_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
    },
  });

  return payload.results?.[0] ?? null;
}

function buildLegacyRestriction(row, slot) {
  const description = row[`description${slot}`];
  const typeDescription = row[`typedesc${slot}`];
  const durationMinutes = row[`duration${slot}`];
  const startTime = row[`starttime${slot}`];
  const endTime = row[`endtime${slot}`];
  const fromDay = row[`fromday${slot}`];
  const toDay = row[`today${slot}`];

  if (
    description == null &&
    typeDescription == null &&
    durationMinutes == null &&
    startTime == null &&
    endTime == null &&
    fromDay == null &&
    toDay == null
  ) {
    return null;
  }

  return {
    slot,
    type: typeDescription ?? 'No type listed',
    restriction: description ?? 'No description listed',
    duration: formatDuration(durationMinutes),
    days:
      fromDay != null && toDay != null
        ? `${fromDay === toDay ? `Day ${fromDay}` : `Day ${fromDay}-${toDay}`}`
        : 'Days not listed',
    hours:
      startTime && endTime ? `${formatClock(startTime)}-${formatClock(endTime)}` : 'Hours not listed',
  };
}

async function fetchLegacyBayRestrictions(bayId) {
  const params = new URLSearchParams({
    where: `bayid=${bayId}`,
    limit: '1',
  });
  const payload = await fetchJson(`${BAY_RESTRICTIONS_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
    },
  });
  const row = payload.results?.[0];

  if (!row) {
    return null;
  }

  const restrictions = Array.from({ length: 6 }, (_, index) => buildLegacyRestriction(row, index + 1)).filter(
    Boolean,
  );

  return {
    bayId: row.bayid ?? String(bayId),
    deviceId: row.deviceid ?? 'n/a',
    restrictions,
  };
}

async function geocodeAddress(address) {
  const query = address.toLowerCase().includes('melbourne')
    ? address
    : `${address}, Melbourne VIC, Australia`;
  const params = new URLSearchParams({
    format: 'jsonv2',
    limit: '1',
    q: query,
  });
  const results = await fetchJson(`${GEOCODER_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'melb_parking/1.0',
    },
  });
  const match = results[0];

  if (!match) {
    throw new Error(`No geocoding match was returned for "${address}".`);
  }

  return {
    query: address,
    resolvedAddress: match.display_name,
    latitude: Number.parseFloat(match.lat),
    longitude: Number.parseFloat(match.lon),
  };
}

function findNearestSensorBay(sensorRows, addressMatch) {
  const target = {
    lat: addressMatch.latitude,
    lon: addressMatch.longitude,
  };
  let nearest = null;

  for (const row of sensorRows) {
    const latitude = toNumber(row.latitude);
    const longitude = toNumber(row.longitude);

    if (latitude == null || longitude == null) {
      continue;
    }

    const distanceMeters = haversineDistanceMeters(target, {
      lat: latitude,
      lon: longitude,
    });

    if (!nearest || distanceMeters < nearest.distanceMeters) {
      nearest = {
        ...row,
        distanceMeters,
      };
    }
  }

  return nearest;
}

function printLookupSummary(summary) {
  console.table([
    {
      bayId: summary.bayId,
      status: summary.status ?? 'No live sensor status',
      zoneNumber: summary.zoneNumber ?? 'n/a',
      roadSegment: summary.roadSegment ?? 'n/a',
      latitude: summary.latitude ?? 'n/a',
      longitude: summary.longitude ?? 'n/a',
      distanceMeters: summary.distanceMeters?.toFixed(1) ?? 'n/a',
      resolvedAddress: summary.resolvedAddress ?? 'n/a',
      lastUpdated: summary.lastUpdated ?? 'n/a',
    },
  ]);
}

function buildZoneSummary(zoneRows) {
  if (!zoneRows || zoneRows.length === 0) {
    return 'No zone restrictions found.';
  }

  const toMinutes = (time) => {
    const match = /^(\d{2}):(\d{2})$/.exec(time ?? '');

    if (!match) {
      return null;
    }

    return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
  };

  const mergeWindows = (rows) => {
    const ordered = [...rows]
      .map((row) => {
        const [start, end] = String(row.hours ?? '').split('-');
        return {
          days: row.days,
          start,
          end,
          startMinutes: toMinutes(start),
          endMinutes: toMinutes(end),
        };
      })
      .sort((left, right) => {
        if (left.days !== right.days) {
          return left.days.localeCompare(right.days);
        }

        return (left.startMinutes ?? Number.MAX_SAFE_INTEGER) - (right.startMinutes ?? Number.MAX_SAFE_INTEGER);
      });

    const merged = [];

    for (const window of ordered) {
      const last = merged[merged.length - 1];

      if (
        last &&
        last.days === window.days &&
        last.endMinutes != null &&
        window.startMinutes != null &&
        last.endMinutes === window.startMinutes
      ) {
        last.end = window.end;
        last.endMinutes = window.endMinutes;
        continue;
      }

      merged.push({ ...window });
    }

    return merged.map((window) =>
      window.start && window.end ? `${window.days} ${window.start}-${window.end}` : `${window.days} ${window.start ?? ''}${window.end ?? ''}`.trim(),
    );
  };

  const grouped = new Map();

  for (const row of zoneRows) {
    const label = row.restrictionLabel ?? row.restriction ?? 'Unknown restriction';

    if (!grouped.has(label)) {
      grouped.set(label, []);
    }

    grouped.get(label).push(row);
  }

  return Array.from(grouped.entries())
    .map(([label, rows]) => `${label}: ${mergeWindows(rows).join(', ')}`)
    .join('; ');
}

function printZoneTable(zoneRows, heading) {
  if (!zoneRows || zoneRows.length === 0) {
    console.log(`${heading}: no zone restrictions found.`);
    return;
  }

  console.log(`${heading} summary: ${buildZoneSummary(zoneRows)}`);
  console.log(`${heading}:`);
  console.table(zoneRows);
}

async function lookupBySensorBay(sensorRows, bayId) {
  return sensorRows.find((row) => row.bayId === String(bayId)) ?? null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.bayId && !args.address) {
    console.log('Pass either --bay=<id> or --address="<street address>".');
    process.exitCode = 1;
    return;
  }

  try {
    const sensorRows = await fetchSensorRows();

    let liveBay = null;
    let geocodedAddress = null;

    if (args.address) {
      geocodedAddress = await geocodeAddress(args.address);
      liveBay = findNearestSensorBay(sensorRows, geocodedAddress);

      if (!liveBay) {
        throw new Error('No nearby live parking bay could be resolved from that address.');
      }
    } else if (args.bayId) {
      liveBay = await lookupBySensorBay(sensorRows, args.bayId);
    }

    if (liveBay) {
      const [zoneSigns, locationDetails] = await Promise.all([
        fetchZoneSigns(liveBay.zoneNumber),
        fetchBayLocationDetails(liveBay.bayId),
      ]);
      const fallbackZoneNumbers =
        zoneSigns.length === 0 ? await fetchZoneNumbersForRoadSegment(locationDetails?.roadsegmentid) : [];
      const fallbackZoneSigns =
        zoneSigns.length === 0
          ? (
              await Promise.all(fallbackZoneNumbers.map((zoneNumber) => fetchZoneSigns(zoneNumber)))
            ).flat()
          : [];
      const effectiveZoneSigns = zoneSigns.length > 0 ? zoneSigns : fallbackZoneSigns;
      const effectiveZoneNumber =
        liveBay.zoneNumber ?? (fallbackZoneNumbers.length === 1 ? fallbackZoneNumbers[0] : fallbackZoneNumbers.join(', '));

      const summary = {
        bayId: liveBay.bayId,
        status: liveBay.status,
        zoneNumber: effectiveZoneNumber,
        roadSegment: locationDetails?.roadsegmentdescription ?? null,
        latitude: locationDetails?.latitude ?? liveBay.latitude,
        longitude: locationDetails?.longitude ?? liveBay.longitude,
        distanceMeters: geocodedAddress ? liveBay.distanceMeters : null,
        resolvedAddress: geocodedAddress?.resolvedAddress ?? null,
        lastUpdated: liveBay.lastUpdated,
      };

      printLookupSummary(summary);
      printZoneTable(
        effectiveZoneSigns.map((row) => ({
          zoneNumber: row.zoneNumber,
          restriction: row.restriction,
          restrictionLabel: row.restrictionLabel,
          days: row.days,
          hours: row.hours,
        })),
        'Zone restrictions',
      );
      return;
    }

    const legacyMatch = args.bayId ? await fetchLegacyBayRestrictions(args.bayId) : null;

    if (!legacyMatch) {
      console.log('No live or legacy parking bay match was found.');
      process.exitCode = 1;
      return;
    }

    console.table([
      {
        bayId: legacyMatch.bayId,
        deviceId: legacyMatch.deviceId,
        status: 'No live sensor match',
      },
    ]);
    printZoneTable(legacyMatch.restrictions, 'Legacy bay restrictions');
  } catch (error) {
    console.error('Unable to fetch Melbourne parking zone information.');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main();
