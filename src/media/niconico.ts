import { command, decode } from "../audio/process.js";
import { failureDetails, ProcessFailure } from "../audio/failure.js";
import { log } from "../log.js";
import { MediaError, youtubeExecutable } from "./dependencies.js";
import type { MediaAdapter, MediaSource } from "./youtube.js";

const videoId = /^(?:sm|so|nm)?[0-9]{1,20}$/;

/** Never follow nico.ms redirects: accept a video ID and construct a fixed URL. */
export function niconicoURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaError("ニコニコ動画の動画URLを確認してください。");
  }
  const allowed = ["www.nicovideo.jp", "nicovideo.jp", "nico.ms"];
  if (
    url.protocol !== "https:" ||
    !allowed.includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new MediaError(
      "HTTPSのニコニコ動画の単体動画URLを指定してください。",
    );
  const match = (
    url.hostname === "nico.ms" ? /^\/([^/]+)\/?$/ : /^\/watch\/([^/]+)\/?$/
  ).exec(url.pathname);
  const id = match?.[1];
  if (!id || !videoId.test(id))
    throw new MediaError("ニコニコ動画の単体動画URLを確認してください。");
  return `https://www.nicovideo.jp/watch/${id}`;
}

export interface NiconicoMetadata {
  id: string;
  title: string;
  duration: number;
  url: string;
}

// No YouTube cookies, PO providers, runtime options, netrc, or user config.
// Restrict extraction to Niconico; select audio-only in both stages, with no fallback.
const base = [
  "--ignore-config",
  "--no-plugin-dirs",
  "--use-extractors",
  "Niconico$",
  "--no-playlist",
  "--no-cache-dir",
  "--no-progress",
  "--no-warnings",
  "--xff",
  "never",
  "--socket-timeout",
  "15",
  "--retries",
  "2",
  "--fragment-retries",
  "2",
  "--abort-on-unavailable-fragments",
  "--downloader",
  // Native HLS creates fragment files even with -o -. FFmpeg streams to stdout.
  "m3u8:ffmpeg",
  "--downloader-args",
  "ffmpeg_i:-rw_timeout 15000000",
  "--downloader-args",
  "ffmpeg_o:-vn",
  "-f",
  "bestaudio[vcodec=none][acodec!=none]",
];

/** Inspect only bounded stderr in memory; never expose it or signed URLs. */
function observation() {
  let stderr = "";
  return {
    consume: (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    },
    failure(error: unknown): unknown {
      if (!(error instanceof ProcessFailure)) return error;
      if (
        ["cancelled", "timeout", "killed"].includes(
          error.details.classification,
        )
      )
        return error;
      const classification =
        /login required|sign in|log in|members only|premium|payment|PPV|no permission|set to private|sensitive content|not available in your country/i.test(
          stderr,
        )
          ? "provider_restriction"
          : /video unavailable|removed by|may not exist|was deleted|page unavailable/i.test(
                stderr,
              )
            ? "media_unavailable"
            : error.details.classification;
      return classification === error.details.classification
        ? error
        : new ProcessFailure({ ...error.details, classification });
    },
  };
}

export class NiconicoAdapter implements MediaAdapter {
  private titlePending = false;
  async title(url: string, signal: AbortSignal): Promise<string> {
    // /list can request 21 titles at once. Do not spawn 21 Python processes on
    // a small Fargate task; busy lookups keep the existing URL fallback.
    if (this.titlePending) throw new MediaError("動画タイトルを取得中です。");
    this.titlePending = true;
    try {
      return (await this.metadata(url, signal, 8000)).title;
    } finally {
      this.titlePending = false;
    }
  }

  async metadata(
    value: string,
    signal: AbortSignal,
    timeoutMs = 30000,
  ): Promise<NiconicoMetadata> {
    const url = niconicoURL(value);
    const observed = observation();
    const info = command(
      youtubeExecutable(),
      [...base, "--dump-single-json", "--skip-download", "--", url],
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      { stage: "metadata", tool: "yt-dlp", observeStderr: observed.consume },
    );
    info.child.stdin.end();
    const chunks: Buffer[] = [];
    let bytes = 0;
    info.child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) info.stop();
      else chunks.push(chunk);
    });
    try {
      await info.done;
      if (bytes > 4 * 1024 * 1024) throw new Error();
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error();
        data = parsed as Record<string, unknown>;
        if (
          typeof data.id !== "string" ||
          !videoId.test(data.id) ||
          typeof data.title !== "string" ||
          !data.title.trim() ||
          typeof data.duration !== "number" ||
          !Number.isFinite(data.duration)
        )
          throw new Error();
      } catch {
        throw new ProcessFailure({
          stage: "metadata",
          tool: "yt-dlp",
          classification: "invalid_metadata",
          exitCode: 0,
          signal: null,
        });
      }
      if (
        data.availability !== "public" ||
        data.is_live === true ||
        (data.live_status !== undefined && data.live_status !== "not_live") ||
        data._type === "playlist" ||
        data.has_drm === true ||
        (data.duration as number) <= 0 ||
        (data.duration as number) > 7200
      )
        throw new MediaError(
          "ニコニコ動画は認証不要の公開動画（2時間以内）のみ対応しています。",
        );
      if (
        data.vcodec !== "none" ||
        typeof data.acodec !== "string" ||
        data.acodec === "none"
      )
        throw new MediaError(
          "このニコニコ動画には利用可能な音声専用形式がありません。映像付き形式は取得しません。",
        );
      signal.throwIfAborted();
      log("niconico_media_result", { stage: "metadata", ok: true });
      return {
        id: data.id as string,
        title: (data.title as string).trim(),
        duration: data.duration as number,
        url,
      };
    } catch (error) {
      const failure =
        bytes > 4 * 1024 * 1024
          ? new ProcessFailure({
              stage: "metadata",
              tool: "yt-dlp",
              classification: "metadata_too_large",
              exitCode: info.child.exitCode,
              signal: info.child.signalCode,
            })
          : observed.failure(error);
      log("niconico_media_result", {
        ...failureDetails(failure, "metadata", signal),
        ok: false,
      });
      throw failure;
    }
  }

  async open(value: string, signal: AbortSignal): Promise<MediaSource> {
    const metadata = await this.metadata(value, signal);
    signal.throwIfAborted();
    const observed = observation();
    const download = command(
      youtubeExecutable(),
      [...base, "-o", "-", "--", metadata.url],
      signal,
      { stage: "download", tool: "yt-dlp", observeStderr: observed.consume },
    );
    download.child.stdin.end();
    let decoded: ReturnType<typeof decode>;
    try {
      decoded = decode(download.child.stdout, signal);
    } catch (error) {
      download.stop();
      throw error;
    }
    download.child.stdout.once("data", () =>
      log("niconico_media_result", { stage: "download", state: "first_bytes" }),
    );
    const acquired = download.done.then(
      () => log("niconico_media_result", { stage: "download", ok: true }),
      (error: unknown) => {
        const failure = observed.failure(error);
        log("niconico_media_result", {
          ...failureDetails(failure, "download", signal),
          ok: false,
        });
        decoded.stop();
        throw failure;
      },
    );
    const pcm = decoded.done.catch((error: unknown) => {
      download.stop();
      throw error;
    });
    const done = Promise.all([acquired, pcm]).then(() => {});
    void done.catch(() => {});
    return {
      metadata,
      stream: decoded.stream,
      done,
      async resolveFailure(error: unknown) {
        if (
          !(error instanceof ProcessFailure) ||
          error.details.stage !== "decode"
        )
          return error;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const upstream = await Promise.race([
            acquired.then(
              () => undefined,
              (failure: unknown) => failure,
            ),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), 1000);
            }),
          ]);
          return upstream instanceof ProcessFailure &&
            !["process_exit", "cancelled", "killed"].includes(
              upstream.details.classification,
            )
            ? upstream
            : error;
        } finally {
          clearTimeout(timer);
        }
      },
      stop() {
        download.stop();
        decoded.stop();
      },
    };
  }
}
