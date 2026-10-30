import { youtubeExecutable, MediaError } from "./dependencies.js";
import { command, decode } from "../audio/process.js";
import type { Readable } from "node:stream";
export interface MediaSource {
  stream: Readable;
  done: Promise<void>;
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
      AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    );
    info.child.stdin.end();
    let json = "";
    info.child.stdout.on("data", (chunk: Buffer) => {
      json += chunk.toString();
      if (json.length > 4 * 1024 * 1024) info.stop();
    });
    await info.done;
    const metadata = JSON.parse(json) as {
      duration?: number;
      live_status?: string;
      availability?: string;
    };
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
      stop() {
        download.stop();
        decoded.stop();
      },
    };
  }
}
