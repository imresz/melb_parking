import { buildSegmentMapData } from './buildSegmentMapData.js';
import { startMapServer } from './serveMap.js';

async function main() {
  console.log('Building Melbourne parking segment map data...');
  await buildSegmentMapData();
  console.log('Starting Android-friendly map server...');
  startMapServer();
}

main().catch((error) => {
  console.error('Unable to start the parking map.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
