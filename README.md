# Duo Clock

A free shared focus timer for two people. You both watch the same countdown, either of you can pause it, and it pauses for both. No camera, no accounts, no limits.

- **Shared timer** with any length from 1 to 600 minutes, rounds, short and long breaks, optional automatic breaks
- **Goals** you can both see, presence dot, pings and chat
- **Streaks and stats** (day streak, best streak, 14 day chart, recent rounds)
- **Four in a Row** where turns wait for whoever is away
- **Together tab** with each other's local time, a countdown to your next visit and repeating standing sessions
- **Customization** for theme, accent colour, typeface, timer style (ring, bar, digits), 12/24 hour clock, chime volume, quick lengths, break lengths

It is a static site (Vite, plain JavaScript) that talks directly to a free Firebase Realtime Database. There is no server of your own to run.

## How pairing works

There are no logins. The first time you open the site it creates a private room and puts its ID in the URL (`?r=...`). **Settings > Room > Copy** gives you that link. Send it to your person and open it on both devices. Anyone who has the link can join, so treat it like a password. Use **Start a new room** in Settings to get a fresh room and link.

Each device is identified by a random ID stored in the browser, so the same person on two devices counts as two people. Use one device each.

## Set it up (about 10 minutes)

### 1. Create the free database

1. Go to the [Firebase console](https://console.firebase.google.com) and click **Add project**. Name it anything. Google Analytics is not needed.
2. In the left menu open **Build > Realtime Database** and click **Create Database**. Pick the location closest to you and start in **locked mode**.
3. Open the **Rules** tab, replace everything with the contents of [`database.rules.json`](database.rules.json) from this repo, and click **Publish**. These rules block listing and only allow access to a room if you know its (long, random) ID.
4. Click the gear icon, then **Project settings > General**. Under **Your apps** click the web icon `</>`, register an app (skip Firebase Hosting), and keep the config it shows.
5. Copy the **database URL** from the top of the Realtime Database **Data** tab. It looks like `https://your-project-default-rtdb.firebaseio.com` or `https://your-project-default-rtdb.europe-west1.firebasedatabase.app`.

These values are identifiers, not secrets. Access is controlled by the rules above.

### 2. Run it on your computer

```bash
npm install
cp .env.example .env     # then fill in the four values
npm run dev
```

Open the address it prints. Without a `.env` the app still runs in **local mode**, which syncs between tabs of one browser only. That is handy for trying it out.

### 3. Put it on GitHub

```bash
git remote add origin https://github.com/<you>/duo-clock.git
git branch -M main
git push -u origin main
```

### 4. Deploy to Vercel (free)

1. On [vercel.com](https://vercel.com) choose **Add New > Project** and import the repo. Vercel detects Vite by itself (build command `npm run build`, output `dist`).
2. Before deploying, open **Environment Variables** and add the same four values from your `.env`:
   `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_DATABASE_URL`, `VITE_FIREBASE_APP_ID`
3. Click **Deploy**. Open the site, add your name, copy the invite link from Settings and send it to your person.

If you change the variables later, redeploy, because Vite reads them at build time.

## Troubleshooting

| What you see | Likely cause |
| --- | --- |
| Yellow banner: "Local mode" | The `VITE_FIREBASE_*` variables are missing in the build. Add them and redeploy. |
| "Cannot reach the database" | Wrong database URL, or the rules were not published. |
| "Could not save" toast | Same as above, or you are offline. |
| Partner never shows as here | You are in different rooms. Compare the `?r=` part of the URLs. |

## Project layout

```
index.html            page markup
src/main.js           the app (rendering, timer, game, settings)
src/lib.js            pure helpers (timer format, stats, game logic, time zones)
src/store.js          Firebase and local storage backends
src/style.css         design tokens and styles
database.rules.json   Firebase security rules
test/lib.test.js      unit tests (npm test)
```

## Notes and limits

- The countdown is stored as an end time and every device corrects its clock using Firebase's server time, so both of you see the same second.
- Standing session banners appear only while the site is open. A web page cannot wake itself up in the background.
- Chat keeps the last 60 messages in the room.
- The Firebase free plan (Spark) is far above what two people use. Check Firebase's current limits if you are curious.
