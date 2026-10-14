package com.opendungeonmaster.app;

import android.media.AudioAttributes;
import android.speech.tts.TextToSpeech;
import android.os.Bundle;
import androidx.annotation.NonNull;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

/**
 * Uses Android's built-in TextToSpeech, routed through the active media output
 * (Bluetooth headphones, car media, or the phone speaker). No remote speech
 * server, payment, or audio files are involved.
 *
 * Called from the embedded game's new-DM-message event, not by scraping the
 * screen or speaking the back-catalog when a campaign loads.
 */
@CapacitorPlugin(name = "OdmNarration")
public class NativeNarrationPlugin extends Plugin implements TextToSpeech.OnInitListener {
    private TextToSpeech synthesizer;
    private volatile boolean ready = false;

    @Override
    public void load() {
        synthesizer = new TextToSpeech(getContext(), this);
    }

    @Override
    public void onInit(int status) {
        if (status != TextToSpeech.SUCCESS || synthesizer == null) {
            ready = false;
            return;
        }
        int supported = synthesizer.setLanguage(Locale.UK);
        if (supported == TextToSpeech.LANG_MISSING_DATA ||
            supported == TextToSpeech.LANG_NOT_SUPPORTED) {
            synthesizer.setLanguage(Locale.ENGLISH);
        }
        synthesizer.setSpeechRate(1.0f);
        synthesizer.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build());
        ready = true;
    }

    @PluginMethod
    public void speak(PluginCall call) {
        final String input = call.getString("text", "").trim();
        if (input.isEmpty()) {
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (!ready || synthesizer == null) {
                call.reject("Android text-to-speech is not ready. Check your installed speech engine.");
                return;
            }
            String words = input
                .replaceAll("\\[roll:[^\\]]+\\]", " ")
                .replaceAll("[*_#~`]", "")
                .replaceAll("\\s+", " ")
                .trim();
            if (words.isEmpty()) {
                call.resolve();
                return;
            }
            int max = Math.min(2500, TextToSpeech.getMaxSpeechInputLength() - 1);
            int offset = 0;
            int count = 0;
            while (offset < words.length()) {
                int end = Math.min(words.length(), offset + max);
                if (end < words.length()) {
                    int split = words.lastIndexOf(' ', end);
                    if (split > offset + max / 2) end = split;
                }
                String part = words.substring(offset, end).trim();
                if (!part.isEmpty()) {
                    synthesizer.speak(part,
                        count == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD,
                        new Bundle(), "odm-" + System.nanoTime() + "-" + count);
                    count++;
                }
                offset = end;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (synthesizer != null) synthesizer.stop();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (synthesizer != null) {
            synthesizer.stop();
            synthesizer.shutdown();
            synthesizer = null;
        }
        ready = false;
        super.handleOnDestroy();
    }
}
