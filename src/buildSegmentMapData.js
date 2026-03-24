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

function clusterProjectedPointsByAcross(projectedPoints) {
  const sortedAcross = [...projectedPoints].sort((left, right) => left.across - right.across);
  const preferredGapMeters = 3;
  const fallbackGapMeters = 2.2;
  const minimumSpanMeters = 6;

  function splitCluster(cluster) {
    if (cluster.length < 2) {
      return [cluster];
    }

    let largestGapMeters = 0;
    let splitIndex = -1;

    for (let index = 1; index < cluster.length; index += 1) {
      const gapMeters = cluster[index].across - cluster[index - 1].across;
      if (gapMeters > largestGapMeters) {
        largestGapMeters = gapMeters;
        splitIndex = index;
      }
    }

    const spanMeters = cluster[cluster.length - 1].across - cluster[0].across;
    const shouldSplit =
      largestGapMeters >= preferredGapMeters ||
      (largestGapMeters >= fallbackGapMeters && spanMeters >= minimumSpanMeters);

    if (!shouldSplit || splitIndex <= 0 || splitIndex >= cluster.length) {
      return [cluster];
    }

    const leftCluster = cluster.slice(0, splitIndex);
    const rightCluster = cluster.slice(splitIndex);

    return [...splitCluster(leftCluster), ...splitCluster(rightCluster)];
  }

  return splitCluster(sortedAcross);
}

function splitClusterByAlongGaps(cluster) {
  const sortedAlong = [...cluster].sort((left, right) => left.along - right.along);
  const segments = [];
  const minimumGapMeters = 30;
  let currentSegment = [sortedAlong[0]];

  for (let index = 1; index < sortedAlong.length; index += 1) {
    const point = sortedAlong[index];
    const previousPoint = sortedAlong[index - 1];
    const gapMeters = point.along - previousPoint.along;

    if (gapMeters >= minimumGapMeters && currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [point];
      continue;
    }

    currentSegment.push(point);
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

function splitClusterByStepGaps(cluster) {
  const sortedAlong = [...cluster].sort((left, right) => left.along - right.along);
  const segments = [];
  const maximumStepDistanceMeters = 16;
  const maximumAcrossJumpMeters = 9;
  let currentSegment = [sortedAlong[0]];

  for (let index = 1; index < sortedAlong.length; index += 1) {
    const point = sortedAlong[index];
    const previousPoint = sortedAlong[index - 1];
    const alongGap = point.along - previousPoint.along;
    const acrossGap = Math.abs(point.across - previousPoint.across);
    const stepDistance = Math.hypot(alongGap, acrossGap);

    if (
      stepDistance > maximumStepDistanceMeters ||
      (acrossGap > maximumAcrossJumpMeters && alongGap > 3)
    ) {
      segments.push(currentSegment);
      currentSegment = [point];
      continue;
    }

    currentSegment.push(point);
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

function buildLaneTraces(projectedPoints) {
  const sortedAlong = [...projectedPoints].sort((left, right) => left.along - right.along);
  const alongBucketGapMeters = 2.5;
  const traceJoinAcrossMeters = 3.6;
  const traceJoinAlongMeters = 10;
  const traces = [];
  let bucket = [sortedAlong[0]];

  function flushBucket(points) {
    const orderedPoints = [...points].sort((left, right) => left.across - right.across);
    const availableTraceIndexes = new Set(traces.map((_, index) => index));

    for (const point of orderedPoints) {
      let bestTraceIndex = null;
      let bestScore = Number.POSITIVE_INFINITY;

      for (const traceIndex of availableTraceIndexes) {
        const trace = traces[traceIndex];
        const lastPoint = trace[trace.length - 1];
        const alongGap = point.along - lastPoint.along;
        const acrossGap = Math.abs(point.across - lastPoint.across);

        if (alongGap < 0 || alongGap > traceJoinAlongMeters || acrossGap > traceJoinAcrossMeters) {
          continue;
        }

        const score = acrossGap * 3 + alongGap;
        if (score < bestScore) {
          bestScore = score;
          bestTraceIndex = traceIndex;
        }
      }

      if (bestTraceIndex == null) {
        traces.push([point]);
        continue;
      }

      traces[bestTraceIndex].push(point);
      availableTraceIndexes.delete(bestTraceIndex);
    }
  }

  for (let index = 1; index < sortedAlong.length; index += 1) {
    const point = sortedAlong[index];
    const previousPoint = sortedAlong[index - 1];

    if (point.along - previousPoint.along <= alongBucketGapMeters) {
      bucket.push(point);
      continue;
    }

    flushBucket(bucket);
    bucket = [point];
  }

  if (bucket.length > 0) {
    flushBucket(bucket);
  }

  return traces.flatMap((trace) => splitClusterByAlongGaps(trace));
}

function splitRoadSegmentSides(points) {
  const dedupedPoints = dedupeCoordinates(points);

  if (dedupedPoints.length < 3) {
    return [sortPointsAlongSegment(dedupedPoints)];
  }

  const projectedPoints = projectPointsToLocalAxis(dedupedPoints);
  const acrossClusters = clusterProjectedPointsByAcross(projectedPoints)
    .filter((cluster) => cluster.length > 0)
    .sort((left, right) => {
      const leftMean = left.reduce((sum, point) => sum + point.across, 0) / left.length;
      const rightMean = right.reduce((sum, point) => sum + point.across, 0) / right.length;
      return leftMean - rightMean;
    });
  const splitClusters = acrossClusters.flatMap((cluster) => splitClusterByAlongGaps(cluster));
  const laneTraces = buildLaneTraces(projectedPoints);
  const chosenClusters =
    laneTraces.length > splitClusters.length
      ? laneTraces
      : splitClusters;
  const refinedClusters = chosenClusters.flatMap((cluster) => splitClusterByStepGaps(cluster));
  const coordinates = refinedClusters
    .filter((cluster) => cluster.length > 0)
    .map((cluster) => cluster.map(({ lat, lon }) => ({ lat, lon })));

  return coordinates.length > 0 ? coordinates : [sortPointsAlongSegment(dedupedPoints)];
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

function countCategories(features) {
  const countsByCategory = {
    all: features.length,
    metered: 0,
    timed: 0,
    loading: 0,
    priority: 0,
    mixed: 0,
    other: 0,
  };

  for (const feature of features) {
    countsByCategory[feature.category] += 1;
  }

  return countsByCategory;
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

  const mergedSegments = [];
  const mergedByRoadSegmentId = new Map();

  for (const segment of segments) {
    if (!mergedByRoadSegmentId.has(segment.roadSegmentId)) {
      const merged = {
        segmentId: String(segment.roadSegmentId),
        roadSegmentId: segment.roadSegmentId,
        viewType: 'merged',
        roadSegment: segment.roadSegment,
        streetName: segment.streetName,
        streetFrom: segment.streetFrom,
        streetTo: segment.streetTo,
        zoneNumbers: segment.zoneNumbers,
        category: segment.category,
        categoryLabel: segment.categoryLabel,
        hasLoadingZone: segment.hasLoadingZone,
        zoneDetails: segment.zoneDetails,
        coordinateGroups: [],
        pointCount: 0,
      };

      mergedByRoadSegmentId.set(segment.roadSegmentId, merged);
      mergedSegments.push(merged);
    }

    const merged = mergedByRoadSegmentId.get(segment.roadSegmentId);
    merged.coordinateGroups.push(segment.coordinates);
    merged.pointCount += segment.pointCount;
  }

  for (const merged of mergedSegments) {
    merged.traceCount = merged.coordinateGroups.length;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    stats: {
      roadSideCount: segments.length,
      mergedSegmentCount: mergedSegments.length,
      zoneCount: zoneDetailsByZoneNumber.size,
    },
    views: {
      roadSides: {
        featureCount: segments.length,
        countsByCategory: countCategories(segments),
        features: segments.map((segment) => ({
          ...segment,
          viewType: 'roadSides',
        })),
      },
      mergedSegments: {
        featureCount: mergedSegments.length,
        countsByCategory: countCategories(mergedSegments),
        features: mergedSegments,
      },
    },
    legend: {
      labels: CATEGORY_LABELS,
    },
  };

  const projectRoot = path.dirname(fileURLToPath(import.meta.url));
  const outputDirectory = path.resolve(projectRoot, '..', 'public', 'data');
  const outputPath = path.join(outputDirectory, 'segment-map-data.json');

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload), 'utf8');

  console.log(
    `Generated ${payload.stats.roadSideCount} road-side traces and ${payload.stats.mergedSegmentCount} merged road segments at ${outputPath}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSegmentMapData().catch((error) => {
    console.error('Unable to build map data.');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
