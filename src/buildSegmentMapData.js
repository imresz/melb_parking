import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ZONE_SEGMENTS_URL =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/parking-zones-linked-to-street-segments/exports/json';
const ON_STREET_BAYS_URL =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/on-street-parking-bays/exports/json';
const SIGN_PLATES_URL =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/sign-plates-located-in-each-parking-zone/exports/json';

const CATEGORY_LABELS = {
  metered: 'Metered parking',
  timed: 'Timed parking',
  loading: 'Loading zone',
  priority: 'Permit / priority',
  mixed: 'Mixed rules',
  other: 'Other',
};

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
    PP: 'Permit parking',
    QP: 'Priority parking',
    HP: 'Hire parking',
    SP: 'Special parking',
  };

  for (const [token, label] of Object.entries(tokenMap)) {
    if (normalized === token || normalized.startsWith(`${token} `)) {
      return label;
    }
  }

  return normalized;
}

function classifyRestriction(code, label) {
  const normalized = String(code ?? '').trim().toUpperCase();
  const friendly = String(label ?? '').toLowerCase();

  if (normalized.startsWith('LZ') || friendly.includes('loading zone')) {
    return 'loading';
  }

  if (normalized.startsWith('MP') || friendly.includes('metered parking')) {
    return 'metered';
  }

  if (/^\d+P$/.test(normalized) || /\b\d+\s*p parking\b/i.test(label ?? '')) {
    return 'timed';
  }

  if (
    ['PP', 'QP', 'SP', 'HP'].includes(normalized) ||
    normalized.startsWith('FP') ||
    normalized.startsWith('DP')
  ) {
    return 'priority';
  }

  return 'other';
}

function formatClock(value) {
  if (!value) {
    return 'All day';
  }

  const match = value.match(/(\d{2}:\d{2})(?::\d{2})?$/) ?? value.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : value;
}

function buildZoneSummary(signRows) {
  if (!signRows || signRows.length === 0) {
    return 'No sign-plate restrictions found.';
  }

  const grouped = new Map();

  for (const row of signRows) {
    const label = row.restrictionLabel;
    const window = `${row.days} ${row.hours}`.trim();

    if (!grouped.has(label)) {
      grouped.set(label, []);
    }

    grouped.get(label).push(window);
  }

  return Array.from(grouped.entries())
    .map(([label, windows]) => `${label}: ${windows.join(', ')}`)
    .join('; ');
}

function dedupeCoordinates(points) {
  const seen = new Set();
  const deduped = [];

  for (const point of points) {
    const key = `${point.lat.toFixed(7)}|${point.lon.toFixed(7)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(point);
  }

  return deduped;
}

function projectPointsToLocalAxis(points) {
  const meanLon = points.reduce((sum, point) => sum + point.lon, 0) / points.length;
  const meanLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const metersPerLatDegree = 111320;
  const metersPerLonDegree = Math.cos((meanLat * Math.PI) / 180) * metersPerLatDegree;

  const localPoints = points.map((point) => ({
    ...point,
    x: (point.lon - meanLon) * metersPerLonDegree,
    y: (point.lat - meanLat) * metersPerLatDegree,
  }));

  let sxx = 0;
  let syy = 0;
  let sxy = 0;

  for (const point of localPoints) {
    sxx += point.x * point.x;
    syy += point.y * point.y;
    sxy += point.x * point.y;
  }

  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const normalX = -dirY;
  const normalY = dirX;

  return localPoints.map((point) => ({
    ...point,
    along: point.x * dirX + point.y * dirY,
    across: point.x * normalX + point.y * normalY,
  }));
}

function sortPointsAlongSegment(points) {
  return [...projectPointsToLocalAxis(points)]
    .sort((left, right) => left.along - right.along)
    .map(({ lat, lon }) => ({ lat, lon }));
}

function splitRoadSegmentSides(points) {
  const dedupedPoints = dedupeCoordinates(points);

  if (dedupedPoints.length < 6) {
    return [sortPointsAlongSegment(dedupedPoints)];
  }

  const projectedPoints = projectPointsToLocalAxis(dedupedPoints);
  const sortedAcross = [...projectedPoints].sort((left, right) => left.across - right.across);
  const minClusterSize = 2;
  const minimumGapMeters = 5;

  const prefixSums = [];
  const prefixSquares = [];

  sortedAcross.forEach((point, index) => {
    prefixSums[index] = point.across + (prefixSums[index - 1] ?? 0);
    prefixSquares[index] = point.across * point.across + (prefixSquares[index - 1] ?? 0);
  });

  const totalSse = (() => {
    const total = prefixSums[prefixSums.length - 1];
    const totalSquares = prefixSquares[prefixSquares.length - 1];
    return totalSquares - (total * total) / sortedAcross.length;
  })();

  let bestSplitIndex = null;
  let bestCombinedSse = Number.POSITIVE_INFINITY;

  for (let index = minClusterSize - 1; index <= sortedAcross.length - minClusterSize - 1; index += 1) {
    const leftCount = index + 1;
    const rightCount = sortedAcross.length - leftCount;
    const leftSum = prefixSums[index];
    const leftSquares = prefixSquares[index];
    const rightSum = prefixSums[prefixSums.length - 1] - leftSum;
    const rightSquares = prefixSquares[prefixSquares.length - 1] - leftSquares;
    const leftSse = leftSquares - (leftSum * leftSum) / leftCount;
    const rightSse = rightSquares - (rightSum * rightSum) / rightCount;
    const gapMeters = sortedAcross[index + 1].across - sortedAcross[index].across;
    const combinedSse = leftSse + rightSse;

    if (gapMeters < minimumGapMeters) {
      continue;
    }

    if (totalSse - combinedSse < 18) {
      continue;
    }

    if (combinedSse < bestCombinedSse) {
      bestCombinedSse = combinedSse;
      bestSplitIndex = index;
    }
  }

  if (bestSplitIndex == null) {
    return [sortPointsAlongSegment(dedupedPoints)];
  }

  const splitThreshold =
    (sortedAcross[bestSplitIndex].across + sortedAcross[bestSplitIndex + 1].across) / 2;
  const leftCluster = projectedPoints.filter((point) => point.across <= splitThreshold);
  const rightCluster = projectedPoints.filter((point) => point.across > splitThreshold);

  const clusters = [leftCluster, rightCluster]
    .filter((cluster) => cluster.length > 0)
    .sort((left, right) => {
      const leftMean = left.reduce((sum, point) => sum + point.across, 0) / left.length;
      const rightMean = right.reduce((sum, point) => sum + point.across, 0) / right.length;
      return leftMean - rightMean;
    })
    .map((cluster) =>
      [...cluster].sort((left, right) => left.along - right.along).map(({ lat, lon }) => ({ lat, lon })),
    );

  return clusters.length > 0 ? clusters : [sortPointsAlongSegment(dedupedPoints)];
}

function chooseSegmentCategory(zoneDetails) {
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status} for ${url}`);
  }

  return response.json();
}

export async function buildSegmentMapData() {
  const [zoneSegmentRows, bayRows, signRows] = await Promise.all([
    fetchJson(ZONE_SEGMENTS_URL),
    fetchJson(ON_STREET_BAYS_URL),
    fetchJson(SIGN_PLATES_URL),
  ]);

  const signsByZone = new Map();
  for (const row of signRows) {
    const zoneNumber = row.parkingzone;
    const parsedRow = {
      zoneNumber,
      restriction: row.restriction_display ?? 'Unknown',
      restrictionLabel: expandRestrictionCode(row.restriction_display),
      days: row.restriction_days ?? 'Days not listed',
      hours:
        row.time_restrictions_start && row.time_restrictions_finish
          ? `${formatClock(row.time_restrictions_start)}-${formatClock(row.time_restrictions_finish)}`
          : 'Hours not listed',
    };

    if (!signsByZone.has(zoneNumber)) {
      signsByZone.set(zoneNumber, []);
    }

    signsByZone.get(zoneNumber).push(parsedRow);
  }

  const zoneDetailsByZoneNumber = new Map();
  for (const [zoneNumber, rows] of signsByZone.entries()) {
    const categories = [...new Set(rows.map((row) => classifyRestriction(row.restriction, row.restrictionLabel)))];
    zoneDetailsByZoneNumber.set(zoneNumber, {
      zoneNumber,
      summary: buildZoneSummary(rows),
      categories,
      hasLoadingZone: categories.includes('loading'),
      restrictions: rows,
    });
  }

  const segmentPointsById = new Map();
  for (const row of bayRows) {
    const segmentId = row.roadsegmentid;
    const lat = Number(row.location?.lat ?? row.latitude);
    const lon = Number(row.location?.lon ?? row.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || segmentId == null) {
      continue;
    }

    if (!segmentPointsById.has(segmentId)) {
      segmentPointsById.set(segmentId, {
        roadSegmentId: segmentId,
        description: row.roadsegmentdescription ?? 'Road segment',
        points: [],
      });
    }

    segmentPointsById.get(segmentId).points.push({ lat, lon });
  }

  const segmentZoneMap = new Map();
  for (const row of zoneSegmentRows) {
    if (!segmentZoneMap.has(row.segment_id)) {
      segmentZoneMap.set(row.segment_id, {
        segmentId: row.segment_id,
        streetName: row.onstreet ?? 'Unknown street',
        streetFrom: row.streetfrom ?? 'Unknown',
        streetTo: row.streetto ?? 'Unknown',
        zoneNumbers: [],
      });
    }

    segmentZoneMap.get(row.segment_id).zoneNumbers.push(row.parkingzone);
  }

  const segments = [];
  for (const segmentEntry of segmentZoneMap.values()) {
    const pointsEntry = segmentPointsById.get(segmentEntry.segmentId);

    if (!pointsEntry || pointsEntry.points.length === 0) {
      continue;
    }

    const splitCoordinates = splitRoadSegmentSides(pointsEntry.points);
    const zoneNumbers = [...new Set(segmentEntry.zoneNumbers)].sort((left, right) => left - right);
    const zoneDetails = zoneNumbers.map((zoneNumber) => {
      const zoneInfo = zoneDetailsByZoneNumber.get(zoneNumber);

      return {
        zoneNumber,
        summary: zoneInfo?.summary ?? 'No sign-plate restrictions found.',
        categories: zoneInfo?.categories ?? ['other'],
        hasLoadingZone: zoneInfo?.hasLoadingZone ?? false,
        restrictions: zoneInfo?.restrictions ?? [],
      };
    });
    const category = chooseSegmentCategory(zoneDetails);

    splitCoordinates.forEach((coordinates, traceIndex) => {
      segments.push({
        segmentId: `${segmentEntry.segmentId}-${traceIndex + 1}`,
        roadSegmentId: segmentEntry.segmentId,
        traceIndex: traceIndex + 1,
        traceCount: splitCoordinates.length,
        roadSegment: pointsEntry.description,
        streetName: segmentEntry.streetName,
        streetFrom: segmentEntry.streetFrom,
        streetTo: segmentEntry.streetTo,
        zoneNumbers,
        category,
        categoryLabel: CATEGORY_LABELS[category] ?? CATEGORY_LABELS.other,
        hasLoadingZone: zoneDetails.some((detail) => detail.hasLoadingZone),
        zoneDetails,
        coordinates: coordinates.map((point) => [point.lat, point.lon]),
        pointCount: coordinates.length,
      });
    });
  }

  segments.sort(
    (left, right) =>
      left.streetName.localeCompare(right.streetName) ||
      left.roadSegmentId - right.roadSegmentId ||
      left.traceIndex - right.traceIndex,
  );

  const countsByCategory = {
    all: segments.length,
    metered: 0,
    timed: 0,
    loading: 0,
    priority: 0,
    mixed: 0,
    other: 0,
  };

  for (const segment of segments) {
    countsByCategory[segment.category] += 1;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    stats: {
      segmentCount: segments.length,
      zoneCount: zoneDetailsByZoneNumber.size,
    },
    legend: {
      countsByCategory,
      labels: CATEGORY_LABELS,
    },
    segments,
  };

  const projectRoot = path.dirname(fileURLToPath(import.meta.url));
  const outputDirectory = path.resolve(projectRoot, '..', 'public', 'data');
  const outputPath = path.join(outputDirectory, 'segment-map-data.json');

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload), 'utf8');

  console.log(`Generated ${payload.stats.segmentCount} coloured road segments at ${outputPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSegmentMapData().catch((error) => {
    console.error('Unable to build map data.');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
