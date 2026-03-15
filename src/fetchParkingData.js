const DATASET_URL =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/on-street-parking-bay-sensors/records?limit=20';

async function fetchParkingData() {
  const response = await fetch(DATASET_URL, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  const payload = await response.json();
  return payload.results ?? [];
}

function formatRow(row, index) {
  return {
    row: index + 1,
    bayId: row.bay_id ?? row.kerbsideid ?? row.zone_number ?? 'n/a',
    status: row.status_description ?? row.status ?? 'n/a',
    latitude: row.lat ?? row.latitude ?? row.location?.lat ?? 'n/a',
    longitude: row.lon ?? row.longitude ?? row.location?.lon ?? 'n/a',
    lastUpdated: row.lastupdated ?? row.last_updated ?? 'n/a',
  };
}

async function main() {
  try {
    const rows = await fetchParkingData();

    if (rows.length === 0) {
      console.log('No parking rows were returned.');
      return;
    }

    console.table(rows.map(formatRow));
  } catch (error) {
    console.error('Unable to fetch Melbourne parking data.');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main();
