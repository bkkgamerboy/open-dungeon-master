# Dungeon Master Voice — disposable Android APK test

This is a lightweight **client** for an **already running** Open Dungeon Master Next.js server. It does not contain a game server, Next.js, SQLite, or any AI API credentials.

## What works

- Type the URL that currently opens the game in your phone browser.
- The web interface opens in a WebView and retains the normal game mechanics and accounts on the server.
- **New** Dungeon Master transcript passages are spoken using the phone's Android TextToSpeech engine. English UK is preferred.
- Use Voice ON/OFF or Stop to interrupt speech. Audio routes through the phone's selected Bluetooth output.
- Voice input through Gboard's microphone is available. Web SpeechRecognition inside an Android WebView may not behave like the phone's Chrome browser.

## Important server setting

Set **Admin → Speech → Narration server: Off** to stop remote Kokoro/OpenAI audio charges and errors. Local Android speech works separately from that server setting, when new Dungeon Master text appears. Leave the OpenAI *text model* unchanged.

## Building

The included GitHub Actions workflow "Build Android voice APK" runs on changes to this folder on the android-native-tts-test branch, then uploads artifact dungeon-master-android-tts-apk (a ZIP holding app-debug.apk). It uses a debug signing key, not a Play Store certificate.

## Known limitations

- The phone must be able to reach your separate game server at the chosen URL.
- This test identifies new messages from the game's .session-dm markup instead of a stable native message API, so upstream UI changes may affect recognition.
- An Android WebView is not identical to Chrome; test your preferred speech-to-text interaction.
- Keep the app on screen during the first trial: the WebView may stop observing messages when Android suspends the app.
- Only the Android speech engine is free; OpenAI usage for the Dungeon Master text still costs money.
