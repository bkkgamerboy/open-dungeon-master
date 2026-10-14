import { stripToolText } from "@/lib/dm/tool-text";

// The words of a DM passage that are meant to be heard: no leaked tool
// calls, roll markers, code or markdown. Shared by the server's narration
// (src/lib/tts.ts) and a device's own voice (src/lib/native-speech.ts), so
// both read exactly the same text. Dependency-free past tool-text, so the
// table's client code can import it.
export function stripForSpeech(text: string): string {
  return stripToolText(text)
    .replace(/\[roll:[^\]]+\]/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#>`]/g, "")
    // Line breaks stay: who said a line depends on the paragraph it opens
    // (src/lib/dm/speech.ts), and the voices must hear it as the
    // transcript shows it. planSpeech flattens each part it reads.
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n\s*/g, "\n")
    .trim();
}
