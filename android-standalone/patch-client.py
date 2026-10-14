#!/usr/bin/env python3
"""Apply the private phone-hosted, native-TTS modifications to the official
Open Dungeon Master Android *client* checkout during the GitHub build.
The Android client embeds the server from this user's fork, so no separate
web server or invitation-code login is involved.
"""
from pathlib import Path
import shutil
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: patch-client.py /path/to/open-dungeon-master-client")

client = Path(sys.argv[1]).resolve()
patches = Path(__file__).resolve().parent
src = client / "mobile" / "src"
native = client / "mobile" / "android" / "app" / "src" / "main"
android = native / "java" / "com" / "opendungeonmaster" / "app"


def replace_once(path: Path, before: str, after: str):
    content = path.read_text(encoding="utf-8")
    if content.count(before) != 1:
        raise SystemExit(f"Expected one instance of {before!r} in {path}, got {content.count(before)}")
    path.write_text(content.replace(before, after), encoding="utf-8")

shutil.copyfile(patches / "NativeNarrationPlugin.java", android / "NativeNarrationPlugin.java")
shutil.copyfile(patches / "native-narration.ts", src / "native-narration.ts")

replace_once(
    android / "MainActivity.java",
    "        registerPlugin(DictationPlugin.class);",
    "        registerPlugin(DictationPlugin.class);\n        registerPlugin(NativeNarrationPlugin.class);",
)
replace_once(
    src / "bridge.ts",
    'import { offerNativeDictation } from "./dictation";',
    'import { offerNativeDictation } from "./dictation";\n'
    'import { offerNativeNarration } from "./native-narration";',
)
replace_once(
    src / "bridge.ts",
    "  offerNativeDictation();",
    "  offerNativeDictation();\n  offerNativeNarration();",
)
# Distinct application ID keeps the original official app and all its
# characters/campaigns installed and completely untouched on the same phone.
replace_once(
    client / "mobile" / "android" / "app" / "build.gradle",
    'applicationId "com.opendungeonmaster.app"',
    'applicationId "com.bkkgamerboy.dmstandalonevoice"',
)
replace_once(
    native / "res" / "values" / "strings.xml",
    "<string name=\"app_name\">Open Dungeon Master</string>",
    "<string name=\"app_name\">Dungeon Master Voice</string>",
)
manifest = native / "AndroidManifest.xml"
replace_once(
    manifest,
    '<action android:name="android.speech.RecognitionService" />',
    '<action android:name="android.speech.RecognitionService" />\n'
    '            <action android:name="android.intent.action.TTS_SERVICE" />',
)
print("Android standalone native-TTS patches applied. Original app stays untouched.")
