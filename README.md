# melb_parking

Small Node.js script that fetches 20 rows from the City of Melbourne's public on-street parking bay sensors dataset.

## Run

```bash
npm start
```

The script prints a 20-row table with bay ID, status, coordinates, and last updated time.

## Parking zone info

```bash
npm run lookup -- --bay=57940
```

To look up by address:

```bash
node src/fetchParkingZoneInfo.js --address="200 Bourke Street Melbourne"
```

The lookup script:
- accepts either a live sensor bay ID with `--bay=<id>` or an address with `--address="..."`
- returns the live occupancy status when a sensor-backed bay is found
- joins the bay's `zone_number` to the City of Melbourne parking-zone sign dataset so you can see rules like `1P`, `2P`, `4P`, meter parking, and time windows
- includes a friendly text label for common sign codes such as `MP2P` -> `Metered parking 2P` and `LZ30` -> `Loading zone 30 min`
- prints a grouped plain-English summary before the detailed zone table
- merges adjacent time windows in that summary when they touch, such as `Mon-Fri 16:00-19:00` plus `Mon-Fri 19:00-22:00` becoming `Mon-Fri 16:00-22:00`
- falls back to the older bay restrictions dataset when you pass a bay ID that is not present in the live sensor feed
