import { afterEach, expect, it, vi } from "vitest";
import { MediaQueue } from "../src/media/queue.js";
import { mediaLink } from "../src/media/list.js";
import { YoutubeAdapter } from "../src/media/youtube.js";
const url = "https://www.youtube.com/watch?v=abcdefghijk";
afterEach(() => vi.unstubAllGlobals());

it("fetches a title through the fixed YouTube oEmbed endpoint", async () => {
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ title: "動画タイトル" })),
  );
  vi.stubGlobal("fetch", fetcher);
  const adapter = new YoutubeAdapter();
  expect(await adapter.title(url, new AbortController().signal)).toBe(
    "動画タイトル",
  );
  expect(fetcher).toHaveBeenCalledWith(expect.any(URL), {
    signal: expect.any(AbortSignal),
  });
  const endpoint = (fetcher.mock.calls[0] as unknown as [URL])[0];
  expect(endpoint.origin).toBe("https://www.youtube.com");
  expect(endpoint.searchParams.get("url")).toBe(url);
});

it.each([new Response("", { status: 404 }), new Response('{"title":42}')])(
  "rejects unavailable or malformed titles",
  async (response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(
      new YoutubeAdapter().title(url, new AbortController().signal),
    ).rejects.toThrow();
  },
);

it("shares in-flight title requests, caches results, and preserves queue order", async () => {
  let resolve!: (title: string) => void;
  const title = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const queue = new MediaQueue({ open: vi.fn(), title }, vi.fn());
  queue.push(url, async () => {});
  const first = queue.list();
  const second = queue.list();
  expect(title).toHaveBeenCalledTimes(1);
  resolve("テスト動画");
  const expected = {
    current: undefined,
    paused: false,
    waiting: [{ url, title: "テスト動画" }],
  };
  expect(await first).toEqual(expected);
  expect(await second).toEqual(expected);
  expect(await queue.list()).toEqual(expected);
  expect(title).toHaveBeenCalledTimes(1);
  queue.close();
});

it("falls back to the URL on failure and retries on the next list", async () => {
  const title = vi
    .fn()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce("復旧");
  const queue = new MediaQueue({ open: vi.fn(), title }, vi.fn());
  queue.push(url, async () => {});
  const first = await queue.list();
  expect(mediaLink(first.waiting[0]!)).toBe(url);
  expect((await queue.list()).waiting[0]?.title).toBe("復旧");
  expect(queue.snapshot().waiting).toEqual([url]);
  queue.close();
});

it("cancels metadata requests on session closure", async () => {
  let signal!: AbortSignal;
  const queue = new MediaQueue(
    {
      open: vi.fn(),
      title: (_url, abort) => {
        signal = abort;
        return new Promise((_resolve, reject) =>
          abort.addEventListener("abort", () => reject(abort.reason), {
            once: true,
          }),
        );
      },
    },
    vi.fn(),
  );
  queue.push(url, async () => {});
  const listing = queue.list();
  queue.close();
  expect(signal.aborted).toBe(true);
  expect((await listing).waiting).toEqual([]);
});

it("escapes title Markdown and bounds a full list below the embed limit", () => {
  expect(mediaLink({ url, title: "曲 [live] *new*\n版" })).toBe(
    `[曲 \\[live\\] \\*new\\* 版](<${url}>)`,
  );
  const links = Array.from(
    { length: 21 },
    (_, i) => `${i + 1}. ${mediaLink({ url, title: "[".repeat(300) })}`,
  );
  expect(("再生中・取得中: " + links.join("\n")).length).toBeLessThan(4096);
});
