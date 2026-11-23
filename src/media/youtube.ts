import { youtubeExecutable, MediaError } from "./dependencies.js";
import { command, decode } from "../audio/process.js";
import type { Readable } from "node:stream";
import { ProcessFailure } from "../audio/failure.js";
export interface MediaSource {
  stream: Readable;
  done: Promise<void>;
  resolveFailure?(error: unknown): Promise<unknown>;
  stop(): void;
}
export interface MediaAdapter {
  title?(url: string, signal: AbortSignal): Promise<string>;
  open(url: string, signal: AbortSignal): Promise<MediaSource>;
}
export function youtubeURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("YouTubeの動画URLを指定してください。");
  }
  const hosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];
  if (
    url.protocol !== "https:" ||
    !hosts.includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error(
      "HTTPSのYouTube単体動画URLのみ対応しています（プレイリスト非対応）。",
    );
  if (url.pathname === "/playlist")
    throw new Error(
      "プレイリスト全体は追加できません。再生したい動画のURLを指定してください。",
    );
  const id =
    url.hostname === "youtu.be"
      ? url.pathname.slice(1)
      : url.pathname === "/watch"
        ? url.searchParams.get("v")
        : /^\/(shorts|embed)\/([^/]+)$/.exec(url.pathname)?.[2];
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id))
    throw new Error("YouTubeの動画URLを確認してください。");
  return `https://www.youtube.com/watch?v=${id}`;
}
const base = [
  "--ignore-config",
  "--no-playlist",
  "--no-cache-dir",
  "--no-progress",
  "--no-warnings",
  "--socket-timeout",
  "15",
  "--retries",
  "2",
  "--js-runtimes",
  `node:${process.execPath}`,
];
export class YoutubeAdapter implements MediaAdapter {
  async title(url: string, signal: AbortSignal): Promise<string> {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("url", youtubeURL(url));
    endpoint.searchParams.set("format", "json");
    const response = await fetch(endpoint, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw new Error("動画タイトルを取得できませんでした");
    const data = (await response.json()) as { title?: unknown };
    if (typeof data.title !== "string" || !data.title.trim())
      throw new Error("動画タイトルがありません");
    return data.title;
  }

  async open(url: string, signal: AbortSignal): Promise<MediaSource> {
    url = youtubeURL(url);
    const executable = youtubeExecutable();
    const info = command(
      executable,
      [...base, "--dump-single-json", "--skip-download", "--", youtubeURL(url)],
      // JS challenge solving competes with TTS on small Fargate tasks. Local
      // 0.25-CPU probes exceeded the old 30s bound; keep a bounded 90s budget.
      AbortSignal.any([signal, AbortSignal.timeout(90000)]),
      { stage: "metadata", tool: "yt-dlp" },
    );
    info.child.stdin.end();
    let json = "";
    let tooLarge = false;
    info.child.stdout.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      json += chunk.toString();
      if (json.length > 4 * 1024 * 1024) {
        tooLarge = true;
        json = "";
        info.stop();
      }
    });
    await info.done.catch((error: unknown) => {
      if (tooLarge)
        throw new ProcessFailure({
          stage: "metadata",
          tool: "yt-dlp",
          classification: "metadata_too_large",
          exitCode: info.child.exitCode,
          signal: info.child.signalCode,
        });
      throw error;
    });
    let metadata: {
      duration?: number;
      live_status?: string;
      availability?: string;
    };
    try {
      metadata = JSON.parse(json);
      if (!metadata || typeof metadata !== "object") throw new Error();
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
      metadata.live_status !== "not_live" ||
      metadata.availability !== "public" ||
      !Number.isFinite(metadata.duration) ||
      metadata.duration! <= 0 ||
      metadata.duration! > 7200
    )
      throw new MediaError(
        "通常の公開動画（2時間以内）のみ対応しています。ライブ・制限付き動画は再生できません。",
      );
    signal.throwIfAborted();
    const download = command(
      executable,
      [...base, "-f", "bestaudio", "-o", "-", "--", url],
      signal,
      { stage: "download", tool: "yt-dlp" },
    );
    download.child.stdin.end();
    let decoded: ReturnType<typeof decode>;
    try {
      decoded = decode(download.child.stdout, signal);
    } catch (error) {
      download.stop();
      throw error;
    }
    return {
      stream: decoded.stream,
      done: Promise.all([download.done, decoded.done]).then(() => {}),
      async resolveFailure(error: unknown) {
        // A failed download closes FFmpeg's input. Let its close event arrive
        // before reporting a secondary invalid-input error as the root cause.
        if (
          !(error instanceof ProcessFailure) ||
          error.details.stage !== "decode"
        )
          return error;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const upstream = await Promise.race([
            download.done.then(
              () => undefined,
              (failure: unknown) => failure,
            ),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), 1000);
            }),
          ]);
          return upstream instanceof ProcessFailure &&
            upstream.details.exitCode !== null &&
            upstream.details.exitCode !== 0 &&
            // A decoder failure can itself give yt-dlp a broken pipe. A
            // generic nonzero exit is insufficient evidence to override it.
            upstream.details.classification !== "process_exit" &&
            upstream.details.classification !== "cancelled"
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
