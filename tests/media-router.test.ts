import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { VideoAdapter, mediaURL } from "../src/media/router.js";
import { YoutubeAdapter } from "../src/media/youtube.js";
import { NiconicoAdapter } from "../src/media/niconico.js";
import { MediaQueue } from "../src/media/queue.js";
const youtube = "https://www.youtube.com/watch?v=abcdefghijk";
const nico = "https://www.nicovideo.jp/watch/sm12345678";
afterEach(() => vi.restoreAllMocks());

it("routes canonical YouTube and Niconico URLs to their own adapters", async () => {
  const source = () => ({
    stream: Readable.from([]),
    done: Promise.resolve(),
    stop() {},
  });
  const yt = vi
    .spyOn(YoutubeAdapter.prototype, "open")
    .mockImplementation(async () => source());
  const nc = vi
    .spyOn(NiconicoAdapter.prototype, "open")
    .mockImplementation(async () => source());
  const ytTitle = vi
    .spyOn(YoutubeAdapter.prototype, "title")
    .mockResolvedValue("YouTube");
  const ncTitle = vi
    .spyOn(NiconicoAdapter.prototype, "title")
    .mockResolvedValue("ニコニコ");
  const adapter = new VideoAdapter();
  const signal = new AbortController().signal;
  await adapter.open("https://youtu.be/abcdefghijk?t=10", signal);
  await adapter.open("https://nico.ms/sm12345678?from=foo", signal);
  expect(yt).toHaveBeenCalledExactlyOnceWith(youtube, signal);
  expect(nc).toHaveBeenCalledExactlyOnceWith(nico, signal);
  expect(await adapter.title(youtube, signal)).toBe("YouTube");
  expect(await adapter.title(nico, signal)).toBe("ニコニコ");
  expect(ytTitle).toHaveBeenCalledOnce();
  expect(ncTitle).toHaveBeenCalledOnce();
});

it.each([
  "https://evil.invalid/watch/sm1",
  "https://nicovideo.jp.evil/watch/sm1",
  "file:///etc/passwd",
  "not-url",
])("rejects arbitrary input %s", (url) =>
  expect(() => mediaURL(url)).toThrow(),
);

it("plays a mixed queue in order, carries the Niconico title, and continues after failure", async () => {
  const order: string[] = [];
  const stops = vi.fn();
  vi.spyOn(YoutubeAdapter.prototype, "open").mockImplementation(async (url) => {
    order.push(url);
    return { stream: Readable.from([]), done: Promise.resolve(), stop: stops };
  });
  vi.spyOn(NiconicoAdapter.prototype, "open").mockImplementation(
    async (url) => {
      order.push(url);
      if (url.endsWith("so1")) throw new Error("unavailable");
      return {
        stream: Readable.from([]),
        done: Promise.resolve(),
        stop: stops,
        metadata: {
          id: "sm12345678",
          title: "ニコニコの曲",
          duration: 120,
          url,
        },
      };
    },
  );
  const finish: (() => void)[] = [];
  const play = vi.fn(
    () => new Promise<void>((resolve) => finish.push(resolve)),
  );
  const notify = vi.fn(async () => {});
  const queue = new MediaQueue(new VideoAdapter(), play);
  queue.push(youtube, notify);
  queue.push(nico, notify);
  queue.push("https://www.nicovideo.jp/watch/so1", notify);
  queue.push(youtube, notify);
  queue.start();
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  finish[0]!();
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  expect(queue.snapshot().current).toBe(nico);
  // The title from open() is stored without another metadata request.
  const title = vi
    .spyOn(NiconicoAdapter.prototype, "title")
    .mockRejectedValue(new Error());
  vi.spyOn(YoutubeAdapter.prototype, "title").mockRejectedValue(new Error());
  const state = await queue.list();
  expect(state.current?.title).toBe("ニコニコの曲");
  expect(state.current).toMatchObject({ id: "sm12345678", duration: 120 });
  expect(title).not.toHaveBeenCalledWith(nico, expect.anything());
  finish[1]!();
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(3));
  finish[2]!();
  await vi.waitFor(() => expect(queue.isBusy).toBe(false));
  expect(order).toEqual([
    youtube,
    nico,
    "https://www.nicovideo.jp/watch/so1",
    youtube,
  ]);
  expect(notify).toHaveBeenCalledOnce();
  expect(stops).toHaveBeenCalledTimes(3);
  queue.close();
});

it.each(["skip", "stop", "close"] as const)(
  "%s aborts a Niconico track and cleans up its source",
  async (action) => {
    const stopped = vi.fn();
    let trackSignal!: AbortSignal;
    vi.spyOn(NiconicoAdapter.prototype, "open").mockImplementation(
      async (_url, signal) => {
        trackSignal = signal;
        return {
          stream: new Readable({ read() {} }),
          done: Promise.resolve(),
          stop: stopped,
        };
      },
    );
    const queue = new MediaQueue(
      new VideoAdapter(),
      (_stream, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        }),
    );
    queue.push(nico, async () => {});
    queue.start();
    await vi.waitFor(() => expect(trackSignal).toBeDefined());
    queue[action]();
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce());
    expect(trackSignal.aborted).toBe(true);
    queue.close();
  },
);
