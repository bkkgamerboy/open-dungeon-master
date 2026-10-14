# ODM Voice: the Android app with the phone's own narration voice

This folder builds a private Android app from this fork. It is the official
Open Dungeon Master app with two changes:

- **The phone's own voice reads the DM's passages.** Android's built-in
  text-to-speech does the reading, so it's free, starts instantly, works
  offline and downloads nothing. It's used wherever the server has no
  narration (Admin > Speech set to Off). Turn on **Always use this phone's
  voice** in Settings > Playback to use it everywhere. The voice, speed and a
  Test button are there too.
- **Read aloud no longer jams narration.** Before, pressing Read aloud on an
  earlier passage could leave the player stuck and silent for the rest of the
  session.

The game-screen half of this lives on this branch. `client.patch` is the
app's half: the native voice plugin and the media fix. It's applied to the
official app (the `CLIENT_REF` commit) at build time.

## How a build happens

`.github/workflows/android-voice-apk.yml` runs on every push to
`phone-voice`, or by hand from the Actions tab (**Run workflow**). It
publishes the APK as a pre-release on this repo's **Releases** page. Open
that page on the phone and tap the `.apk` to install it.

The app is **ODM Voice** (`com.opendungeonmaster.app.voice`). It installs
beside the official app instead of over it, so the official app and its
world stay untouched. To bring a world across, use **Move your world** in
Settings.

## Signing

`voice.keystore` is the signing key, encrypted (PKCS#12, AES-256). Every
build is signed with it, so each new build installs over the last one and
keeps its world. The password, six lowercase words joined by hyphens, is
the repository secret `MY_SECRET` (or `ODM_VOICE_KEYSTORE_PASSWORD`) and is
never committed. The build checks it first: capitals, and spaces or
dashes in place of hyphens, are forgiven, and a wrong or missing password
stops the build in its first minute.
