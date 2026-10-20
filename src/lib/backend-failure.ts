import { isPrivateBackendHost } from "@/lib/backend-host";

// What a failed model call can tell the table, and whether it is worth
// asking again. Pure, so scripts/test-backend-failure.mjs covers it.

// The failures a public API names when it simply had a bad moment: OpenAI's
// "server_error" ("The server had an error while processing your request")
// and a rate limit that a second try a moment later often clears. Anything
// else it names (an invalid prompt, a refused image) fails the same way
// twice, so it is not asked again. A failure that names no code at all is
// read as a blip.
const TRANSIENT_CODES = new Set(["server_error", "rate_limit_exceeded"]);

export function transientFailureCode(code: string | undefined): boolean {
  return !code || TRANSIENT_CODES.has(code);
}

// An HTTP refusal that is the server's trouble rather than the request's.
// Not 504: that is a call that already waited out its whole timeout.
export function transientHttpStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503;
}

const REASON_CHARS = 200;

// The backend's own words for the table's notice. A public API's message
// ("The server had an error while processing your request...") names
// nothing of the host's; a server on this machine or the LAN keeps its words
// in the server log, where they may name its hosts and paths. A JSON error
// body gives its message; plain text is used as it came. Empty when there
// is nothing fit to show.
export function tableReason(text: string, baseUrl: string): string {
  if (!text || isPrivateBackendHost(baseUrl)) {
    return "";
  }
  let said = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message =
      typeof parsed?.error === "string"
        ? parsed.error
        : typeof parsed?.error?.message === "string"
          ? parsed.error.message
          : typeof parsed?.message === "string"
            ? parsed.message
            : "";
    if (message) {
      said = message;
    }
  } catch {
    // Not JSON: the text itself.
  }
  const flat = said.replace(/\s+/g, " ").trim();
  if (!flat || flat.startsWith("<")) {
    // An HTML error page is no sentence to read out.
    return "";
  }
  return flat.length > REASON_CHARS ? `${flat.slice(0, REASON_CHARS - 1).trimEnd()}…` : flat;
}
