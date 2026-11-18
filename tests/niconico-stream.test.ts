import { spawnSync } from "node:child_process";
import { mkdtemp, copyFile, chmod, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { NiconicoAdapter } from "../src/media/niconico.js";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const available =
  process.platform !== "win32" &&
  spawnSync(ffmpeg, ["-version"]).status === 0 &&
  spawnSync("python3", ["-c", "import yt_dlp"]).status === 0;

it.skipIf(!available)(
  "uses real Niconico HLS parsing, audio selection, FFmpeg streaming and PCM without video or fragment files",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "popon-nico-test-"));
    const wrapper = join(directory, "yt-dlp-fixture");
    const originalPath = process.env.YT_DLP_PATH;
    const originalBase = process.env.POPON_NICONICO_FIXTURE_BASE;
    const requests: string[] = [];
    const audio = spawnSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1:sample_rate=48000",
      "-c:a",
      "aac",
      "-f",
      "mpegts",
      "pipe:1",
    ]);
    expect(audio.status).toBe(0);
    const server = createServer((request, response) => {
      requests.push(request.url!);
      const base = process.env.POPON_NICONICO_FIXTURE_BASE;
      if (request.url === "/master.m3u8") {
        response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        response.end(
          `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac-128kbps",NAME="audio-aac-128kbps",DEFAULT=YES,AUTOSELECT=YES,URI="${base}/audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.42001e,mp4a.40.2",AUDIO="audio-aac-128kbps"\n${base}/video-h264-360p.m3u8\n`,
        );
      } else if (request.url === "/audio.m3u8") {
        response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        response.end(
          `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.024,\n${base}/tone.ts\n#EXT-X-ENDLIST\n`,
        );
      } else if (request.url === "/tone.ts") {
        response.setHeader("Content-Type", "video/mp2t");
        response.end(audio.stdout);
      } else {
        response.writeHead(404).end();
      }
    });
    let source: Awaited<ReturnType<NiconicoAdapter["open"]>> | undefined;
    const controller = new AbortController();
    const before = new Set(await readdir("."));
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("fixture server unavailable");
      process.env.POPON_NICONICO_FIXTURE_BASE = `http://127.0.0.1:${address.port}`;
      await copyFile("tests/fixtures/niconico-yt-dlp.py", wrapper);
      await chmod(wrapper, 0o700);
      process.env.YT_DLP_PATH = wrapper;
      source = await new NiconicoAdapter().open(
        "https://www.nicovideo.jp/watch/sm1",
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of source.stream) chunks.push(chunk as Buffer);
      await source.done;
      const pcm = Buffer.concat(chunks);
      expect(pcm.length).toBeGreaterThan(48000 * 2 * 2 * 0.9);
      expect(pcm.length % 4).toBe(0);
      expect(source.metadata).toEqual({
        id: "sm1",
        title: "Local test tone",
        duration: 1,
        url: "https://www.nicovideo.jp/watch/sm1",
      });
      expect(requests).toContain("/tone.ts");
      expect(requests.some((url) => url.includes("video-h264"))).toBe(false);
      expect((await readdir(".")).filter((name) => !before.has(name))).toEqual(
        [],
      );
    } finally {
      controller.abort();
      source?.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (originalPath === undefined) delete process.env.YT_DLP_PATH;
      else process.env.YT_DLP_PATH = originalPath;
      if (originalBase === undefined)
        delete process.env.POPON_NICONICO_FIXTURE_BASE;
      else process.env.POPON_NICONICO_FIXTURE_BASE = originalBase;
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);
