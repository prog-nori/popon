import { log } from "../log.js";
import { ProcessFailure, type FailureClass } from "../audio/failure.js";

export const POT_VERSION = "2.0.2";
export interface PoTokenOptions {
  enabled: boolean;
  baseUrl: string;
}
function failure(classification: FailureClass) {
  return new ProcessFailure({
    stage: "metadata",
    tool: "yt-dlp",
    classification,
    exitCode: null,
    signal: null,
  });
}

// Deliberately independent of config.ts: credential-free media probes use this.
export function poTokenOptions(env = process.env): PoTokenOptions {
  const flag = env.YOUTUBE_POT_ENABLED ?? "false";
  if (flag !== "true" && flag !== "false") throw failure("pot_configuration");
  if (flag === "false") return { enabled: false, baseUrl: "" };
  try {
    const url = new URL(env.YOUTUBE_POT_BASE_URL || "http://127.0.0.1:4416");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
    return { enabled: true, baseUrl: url.origin };
  } catch {
    throw failure("pot_configuration");
  }
}

export function poTokenArgs(options: PoTokenOptions): string[] {
  // pip-installed plugins auto-load even with --ignore-config. OFF must disable
  // them explicitly so the same comparison image really tests the old path.
  if (!options.enabled) return ["--no-plugin-dirs"];
  return [
    "--verbose",
    "--extractor-args",
    "youtube:player_client=mweb;fetch_pot=always",
    "--extractor-args",
    `youtubepot-bgutilhttp:base_url=${options.baseUrl}`,
    // HTTP only: never silently fall back to a script under a user's home.
    "--extractor-args",
    "youtubepot-bgutilscript:server_home=/nonexistent/popon-http-only",
  ];
}

export async function checkPoTokenProvider(
  options: PoTokenOptions,
  signal: AbortSignal,
): Promise<void> {
  if (!options.enabled) return;
  signal.throwIfAborted();
  try {
    const response = await fetch(`${options.baseUrl}/ping`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      redirect: "error",
    });
    // /ping is a small, non-secret response. Bound reads even for a bad URL.
    const reader = response.body?.getReader();
    let body = "";
    if (!response.ok || !reader) throw new Error();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        body += new TextDecoder().decode(value);
        if (body.length > 4096) throw new Error();
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const data = JSON.parse(body) as { version?: unknown };
    if (data.version !== POT_VERSION) throw failure("pot_version_mismatch");
    log("youtube_pot_provider", { reachable: true, version: POT_VERSION });
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    const classification =
      error instanceof ProcessFailure
        ? error.details.classification
        : "pot_provider_unavailable";
    log("youtube_pot_provider", { reachable: false, classification });
    throw failure(classification);
  }
}

// Whitelist fixed observations only. Never forward raw verbose output, argv,
// URLs, tokens, headers, or exception messages. pot_trace stays DISABLED.
export function poTokenObserver(stage: "metadata" | "download") {
  let pending = "";
  let plugin = false;
  let requested = false;
  let received = false;
  let generationFailed = false;
  let tokenOnGvsRequest = false;
  function line(text: string) {
    if (/PO Token Providers:.*bgutil:http-2\.0\.2\s+\(external\)/.test(text))
      plugin = true;
    if (/Generating a gvs PO Token .*via bgutil HTTP server/i.test(text))
      requested = true;
    if (/Retrieved a gvs PO Token for mweb client/i.test(text)) received = true;
    if (/Error fetching PO Token|Error reaching POST \/get_pot/i.test(text))
      generationFailed = true;
    if (/Invoking .*downloader on/.test(text) && /[?&/]pot[=/]/.test(text))
      tokenOnGvsRequest = true;
  }
  return {
    consume(chunk: string) {
      pending += chunk;
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop()!.slice(-8192);
      for (const text of lines) line(text);
    },
    finish(ok: boolean) {
      line(pending);
      pending = "";
      log("youtube_pot_result", {
        stage,
        ok,
        pluginRecognized: plugin,
        gvsTokenRequested: requested,
        gvsTokenReceived: received,
        generationFailed,
        tokenOnGvsRequest,
      });
    },
    assertPlugin() {
      if (!plugin) throw failure("pot_plugin_missing");
    },
  };
}
