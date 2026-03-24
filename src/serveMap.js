import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
const GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
const CITY_OF_MELBOURNE_VIEWBOX = '144.8970,-37.7800,144.9910,-37.8600';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function getLanUrls(port) {
  const nets = networkInterfaces();
  const urls = [];

  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }

  return [...new Set(urls)];
}

async function geocodeAddress(address) {
  const query = address.toLowerCase().includes('melbourne')
    ? `${address}, Victoria, Australia`
    : `${address}, Melbourne VIC, Australia`;
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'melb_parking-map/1.0',
  };
  const boundedParams = new URLSearchParams({
    format: 'jsonv2',
    limit: '5',
    countrycodes: 'au',
    addressdetails: '1',
    bounded: '1',
    viewbox: CITY_OF_MELBOURNE_VIEWBOX,
    q: query,
  });
  const boundedResponse = await fetch(`${GEOCODER_URL}?${boundedParams.toString()}`, {
    headers,
  });

  if (!boundedResponse.ok) {
    throw new Error(`Geocoder request failed with status ${boundedResponse.status}`);
  }

  const boundedResults = await boundedResponse.json();
  let results = boundedResults;

  if (results.length === 0) {
    const fallbackParams = new URLSearchParams({
      format: 'jsonv2',
      limit: '5',
      countrycodes: 'au',
      addressdetails: '1',
      q: query,
    });
    const fallbackResponse = await fetch(`${GEOCODER_URL}?${fallbackParams.toString()}`, {
      headers,
    });

    if (!fallbackResponse.ok) {
      throw new Error(`Geocoder fallback request failed with status ${fallbackResponse.status}`);
    }

    results = await fallbackResponse.json();
  }

  const match = results[0];

  if (!match) {
    return null;
  }

  return {
    query: address,
    resolvedAddress: match.display_name,
    latitude: Number.parseFloat(match.lat),
    longitude: Number.parseFloat(match.lon),
  };
}

export function startMapServer({ host = '0.0.0.0', port = 4173 } = {}) {
  const srcDirectory = path.dirname(fileURLToPath(import.meta.url));
  const publicDirectory = path.resolve(srcDirectory, '..', 'public');

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      if (requestUrl.pathname === '/api/geocode') {
        const address = requestUrl.searchParams.get('address')?.trim();

        if (!address) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Missing address parameter' }));
          return;
        }

        const match = await geocodeAddress(address);

        if (!match) {
          response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Address not found' }));
          return;
        }

        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        response.end(JSON.stringify(match));
        return;
      }

      let pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
      pathname = pathname.replace(/^\/+/, '');

      const filePath = path.resolve(publicDirectory, pathname);
      if (!filePath.startsWith(publicDirectory)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Forbidden');
        return;
      }

      const fileContents = await readFile(filePath);
      const extension = path.extname(filePath).toLowerCase();

      response.writeHead(200, {
        'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
        'Cache-Control': extension === '.json' ? 'no-cache' : 'public, max-age=300',
      });
      response.end(fileContents);
    } catch (error) {
      const message =
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'Not Found'
          : 'Server Error';
      const statusCode = message === 'Not Found' ? 404 : 500;

      response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(message);
    }
  });

  server.listen(port, host, () => {
    console.log(`Map server running on http://localhost:${port}`);

    for (const url of getLanUrls(port)) {
      console.log(`LAN URL for Android: ${url}`);
    }
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startMapServer();
}
