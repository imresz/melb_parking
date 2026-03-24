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
<<<<<<< HEAD

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
- lets you switch between `road sides` and a simpler `merged road segment` view
- includes address search that jumps to the nearest coloured road segment
- groups multiple parking zones per segment into tap-to-open details
- reconstructs road-segment geometry from City of Melbourne on-street bay locations
- includes a fuller legend key that explains every map colour before the filter chips
- gives each map colour a matching filter option, plus an `All colours` reset
- lets you tap the full legend key itself to filter by colour, not just the chip row
- shows the active map view and active colour filter directly inside each popup
- prints LAN URLs when the server starts, so you can open it from your Android device on the same Wi-Fi

## Android App

This project can also be packaged as a local Android app for sideloading onto a phone.

Android wrapper files now included:
- `capacitor.config.json`
- `android/`

Useful commands:

```bash
npm run map:build
npm run android:sync
npm run android:open
```

Notes:
- the Android app loads the bundled map files from `public/`
- address search works inside the app without the local Node server
- the app still needs internet access on the phone for map tiles and geocoding

### Build And Sideload

1. Install Android Studio on your PC.
2. Install a Java JDK and set `JAVA_HOME` if it is not already configured.
3. In this project folder, run:

```bash
npm run map:build
npm run android:sync
npm run android:open
```

4. In Android Studio, let Gradle finish syncing.
5. Build a debug APK from Android Studio:
   `Build` -> `Build Bundle(s) / APK(s)` -> `Build APK(s)`
6. When the build finishes, find the APK under:
   `android/app/build/outputs/apk/debug/app-debug.apk`
7. Copy that APK to your Android phone.
8. On the phone, open `Settings` -> `Security & privacy` -> `More security & privacy` -> `Install unknown apps`.
9. Allow the app you will open the APK from, such as `Files by Google`, to install unknown apps.
10. Open the APK on the phone and tap `Install`.
=======
>>>>>>> c5dbf396b9bc279464534fe20103a7acce6dd0e5
