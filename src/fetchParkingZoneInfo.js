const DATASET_URL =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/on-street-car-park-bay-restrictions/records';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEFAULT_LIMIT = 20;

function parseArgs(argv) {
  const args = {
    bayId: null,
    limit: DEFAULT_LIMIT,
  };

  for (const rawArg of argv) {
    if (rawArg.startsWith('--bay=')) {
      args.bayId = rawArg.slice('--bay='.length).trim();
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

function formatClock(value) {
  if (!value) {
    return null;
  }

  const match = value.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : value;
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 'No limit listed';
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hr`;
  }

  return `${minutes} min`;
}

function formatDayRange(fromDay, toDay) {
  if (!Number.isFinite(fromDay) || !Number.isFinite(toDay)) {
    return 'Days not listed';
  }

  const startLabel = DAY_LABELS[fromDay - 1];
  const endLabel = DAY_LABELS[toDay - 1];

  if (!startLabel || !endLabel) {
    return 'Days not listed';
  }

  if (fromDay === toDay) {
    return startLabel;
  }

  if (fromDay === 1 && toDay === 5) {
    return 'Mon-Fri';
  }

  if (fromDay === 6 && toDay === 7) {
    return 'Sat-Sun';
  }

  return `${startLabel}-${endLabel}`;
}

function buildRestriction(row, slot) {
  const description = row[`description${slot}`];
  const typeDescription = row[`typedesc${slot}`];
  const durationMinutes = row[`duration${slot}`];
  const fromDay = row[`fromday${slot}`];
  const toDay = row[`today${slot}`];
  const startTime = row[`starttime${slot}`];
  const endTime = row[`endtime${slot}`];
  const publicHolidayFlag = row[`effectiveonph${slot}`];
  const exemption = row[`exemption${slot}`];

  if (
    description == null &&
    typeDescription == null &&
    durationMinutes == null &&
    fromDay == null &&
    toDay == null &&
    startTime == null &&
    endTime == null
  ) {
    return null;
  }

  return {
    slot,
    description: description ?? 'No description listed',
    type: typeDescription ?? 'No type listed',
    durationMinutes: durationMinutes ?? null,
    durationLabel: formatDuration(durationMinutes),
    days: formatDayRange(fromDay, toDay),
    hours:
      startTime && endTime
        ? `${formatClock(startTime)}-${formatClock(endTime)}`
        : 'Hours not listed',
    appliesOnPublicHolidays: publicHolidayFlag === 1,
    exemption: exemption ?? null,
  };
}

function formatRow(row) {
  const restrictions = Array.from({ length: 6 }, (_, index) =>
    buildRestriction(row, index + 1),
  ).filter(Boolean);

  return {
    bayId: row.bayid ?? 'n/a',
    deviceId: row.deviceid ?? 'n/a',
    zoneSummary:
      restrictions.map((restriction) => restriction.description).join(' | ') ||
      'No restrictions listed',
    restrictions,
  };
}

async function fetchParkingZoneInfo({ bayId, limit }) {
  const params = new URLSearchParams({
    limit: String(limit),
  });

  if (bayId) {
    params.set('where', `bayid=${bayId}`);
  }

  const response = await fetch(`${DATASET_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  const payload = await response.json();
  return (payload.results ?? []).map(formatRow);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    const rows = await fetchParkingZoneInfo(args);

    if (rows.length === 0) {
      console.log('No parking zone rows were returned.');
      return;
    }

    console.table(
      rows.map((row) => ({
        bayId: row.bayId,
        deviceId: row.deviceId,
        zoneSummary: row.zoneSummary,
      })),
    );

    for (const row of rows) {
      console.log(`\nBay ${row.bayId} restrictions:`);
      console.table(
        row.restrictions.map((restriction) => ({
          slot: restriction.slot,
          type: restriction.type,
          duration: restriction.durationLabel,
          days: restriction.days,
          hours: restriction.hours,
          description: restriction.description,
          publicHolidays: restriction.appliesOnPublicHolidays ? 'Yes' : 'No',
          exemption: restriction.exemption ?? 'None',
        })),
      );
    }
  } catch (error) {
    console.error('Unable to fetch Melbourne parking zone information.');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main();
