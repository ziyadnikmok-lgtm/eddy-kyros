# iOS Mobile Wrapper

This repo now includes a Capacitor-based iOS wrapper for `AI Content Studio`.

For the fastest testing path, the native app loads the hosted Railway app:

- `https://believable-curiosity-production-1126.up.railway.app`

## What You Need

- Xcode from the Mac App Store
- An iPhone connected by cable or the iOS Simulator

## First-Time Setup

From the client folder:

```bash
npm install
npm run mobile:sync
```

## Open In Xcode

```bash
npm run mobile:open:ios
```

Then in Xcode:

1. Pick a Simulator or your iPhone
2. Set your Apple Team under Signing & Capabilities
3. Press Run

## Useful Commands

```bash
npm run build
npm run mobile:sync
npm run mobile:open:ios
npm run mobile:run:ios
```

## Notes

- You do not need the App Store to test locally.
- You do need full Xcode, not only Command Line Tools.
- This is currently a native shell around the hosted web app, which is the quickest way to test on iPhone.
- Later, we can move toward a more native mobile setup if you want deeper iOS behavior.
