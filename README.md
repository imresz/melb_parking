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
- for address lookups, also returns nearby off-street car parks with distance, type, and capacity
- warns when the nearest on-street bay is still more than 250 meters from the resolved address
- prints the resolved geocoded address explicitly before the parking results
- joins the bay's `zone_number` to the City of Melbourne parking-zone sign dataset so you can see rules like `1P`, `2P`, `4P`, meter parking, and time windows
- explicitly flags whether the resolved zone also includes a loading zone
- includes a friendly text label for common sign codes such as `MP2P` -> `Metered parking 2P` and `LZ30` -> `Loading zone 30 min`
- prints a grouped plain-English summary before the detailed zone table
- merges adjacent time windows in that summary when they touch, such as `Mon-Fri 16:00-19:00` plus `Mon-Fri 19:00-22:00` becoming `Mon-Fri 16:00-22:00`
- falls back to the older bay restrictions dataset when you pass a bay ID that is not present in the live sensor feed

## Android Map

Build the mobile map data:

```bash
npm run map:build
```

Serve the Android-friendly map:

```bash
npm run map:serve
```

Or do both in one step:

```bash
npm run map
```

The map:
- serves a mobile-first Leaflet UI that works well on Android browsers
- colour-codes road segments by parking rule category
- splits opposite sides of the same road segment into separate kerbside traces instead of joining them into one line
- includes address search that jumps to the nearest coloured road segment
- groups multiple parking zones per segment into tap-to-open details
- reconstructs road-segment geometry from City of Melbourne on-street bay locations
- includes a fuller legend key that explains every map colour before the filter chips
- prints LAN URLs when the server starts, so you can open it from your Android device on the same Wi-Fi
