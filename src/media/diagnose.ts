import { YoutubeAdapter, youtubeURL, type MediaSource } from "./youtube.js";
import { mediaResources, mediaTools } from "./diagnostics.js";
import { failureDetails } from "../audio/failure.js";
import { MediaError } from "./dependencies.js";

// Runs without Discord/AWS credentials. No config/.env loading or raw stderr.
async function main() {
  let url: string;
  try {
    url = youtubeURL(process.argv[2] || "");
  } catch {
    console.log(
      JSON.stringify({ ok: false, classification: "invalid_video_url" }),
    );
    process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(180000),
  ]);
  const before = mediaResources();
  console.log(
    JSON.stringify({
      event: "media_probe_start",
      videoId: new URL(url).searchParams.get("v"),
      tools: mediaTools(),
      resources: before,
    }),
  );
  const started = Date.now();
  let source: MediaSource | undefined;
  let pcmBytes = 0;
  let sampleComplete = false;
  try {
    source = await new YoutubeAdapter().open(url, signal);
    // Consume at playback speed with bounded buffers; sample 10 seconds of PCM.
    const sample = (async () => {
      for await (const chunk of source!.stream) {
        pcmBytes += (chunk as Buffer).length;
        if (pcmBytes >= 48000 * 2 * 2 * 10) {
          sampleComplete = true;
          break;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, (chunk as Buffer).length / 192),
        );
      }
      if (!pcmBytes) throw new Error();
    })();
    await Promise.race([sample, source.done.then(() => sample)]);
    console.log(
      JSON.stringify({
        event: "media_probe_result",
        ok: true,
        sampleComplete,
        pcmBytes,
        elapsedMs: Date.now() - started,
        resources: mediaResources(),
      }),
    );
  } catch (error) {
    if (source?.resolveFailure) error = await source.resolveFailure(error);
    const detail = failureDetails(
      error,
      source ? "decode" : "metadata",
      signal,
    );
    if (error instanceof MediaError)
      detail.classification = "unsupported_video";
    const after = mediaResources();
    console.log(
      JSON.stringify({
        event: "media_probe_result",
        ok: false,
        ...detail,
        pcmBytes,
        totalElapsedMs: Date.now() - started,
        resources: after,
        oomKillDelta:
          before.oomKills !== null && after.oomKills !== null
            ? after.oomKills - before.oomKills
            : null,
      }),
    );
    process.exitCode = 1;
  } finally {
    controller.abort();
    source?.stop();
  }
}
await main();
