# melb_parking

Small Node.js script that fetches 20 rows from the City of Melbourne's public on-street parking bay sensors dataset.

## Run

```bash
npm start
```

The script prints a 20-row table with bay ID, status, coordinates, and last updated time.

## Parking zone info

```bash
npm run zones
```

To look up a specific bay:

```bash
node src/fetchParkingZoneInfo.js --bay=9003
```

The zone script prints the parking restriction descriptions and expands them into readable duration, day range, and time window fields.
