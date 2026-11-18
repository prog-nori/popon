import { MediaError } from "./dependencies.js";
import { NiconicoAdapter, niconicoURL } from "./niconico.js";
import { YoutubeAdapter, youtubeURL, type MediaAdapter } from "./youtube.js";

export function mediaURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaError(
      "YouTubeまたはニコニコ動画の動画URLを指定してください。",
    );
  }
  if (["nicovideo.jp", "www.nicovideo.jp", "nico.ms"].includes(url.hostname))
    return niconicoURL(value);
  return youtubeURL(value);
}

/** Share the existing queue; each adapter owns only its service's acquisition. */
export class VideoAdapter implements MediaAdapter {
  private youtube = new YoutubeAdapter();
  private niconico = new NiconicoAdapter();
  private select(value: string) {
    const url = mediaURL(value);
    return {
      url,
      adapter:
        new URL(url).hostname === "www.nicovideo.jp"
          ? this.niconico
          : this.youtube,
    };
  }
  title(value: string, signal: AbortSignal): Promise<string> {
    const { url, adapter } = this.select(value);
    return adapter.title(url, signal);
  }
  open(value: string, signal: AbortSignal) {
    const { url, adapter } = this.select(value);
    return adapter.open(url, signal);
  }
}
