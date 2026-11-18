import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/audio/process.js", () => ({
  command: vi.fn(),
  decode: vi.fn(),
}));
vi.mock("../src/log.js", () => ({ log: vi.fn() }));
import { command, decode } from "../src/audio/process.js";
import { ProcessFailure } from "../src/audio/failure.js";
import { log } from "../src/log.js";
import { NiconicoAdapter, niconicoURL } from "../src/media/niconico.js";

const url = "https://www.nicovideo.jp/watch/sm12345678";
const valid = {
  id: "sm12345678",
  title: "検証用の曲",
  duration: 120,
  availability: "public",
  vcodec: "none",
  acodec: "aac",
};
function result(value = "") {
  const stdout = new PassThrough();
  const done = new Promise<void>((resolve) =>
    queueMicrotask(() => {
      stdout.end(value);
      resolve();
    }),
  );
  return {
    child: { stdin: new PassThrough(), stdout, exitCode: 0, signalCode: null },
    done,
    stop: vi.fn(),
  } as unknown as ReturnType<typeof command>;
}
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([
  ["https://www.nicovideo.jp/watch/sm12345678?from=foo#bar", "sm12345678"],
  ["https://nicovideo.jp/watch/so12345678", "so12345678"],
  ["https://nico.ms/sm12345678?t=12", "sm12345678"],
  ["https://nico.ms/so12345678/", "so12345678"],
  ["https://www.nicovideo.jp/watch/nm14296458", "nm14296458"],
  ["https://www.nicovideo.jp/watch/1173108780", "1173108780"],
])("canonicalizes %s without following redirects", (value, id) => {
  expect(niconicoURL(value)).toBe(`https://www.nicovideo.jp/watch/${id}`);
});

it.each([
  "not a url",
  "http://www.nicovideo.jp/watch/sm1",
  "https://www.nicovideo.jp.evil/watch/sm1",
  "https://evil/?nicovideo.jp/watch/sm1",
  "https://nico.ms.evil/sm1",
  "https://nico.ms/@user",
  "https://nico.ms/watch/sm1",
  "https://www.nicovideo.jp/mylist/123",
  "https://live.nicovideo.jp/watch/lv1",
  "https://www.nicovideo.jp/watch/lv1",
  "https://www.nicovideo.jp/watch/sm1/extra",
  "https://u:password@www.nicovideo.jp/watch/sm1",
  "https://www.nicovideo.jp:5000/watch/sm1",
  "file:///watch/sm1",
  "https://www.nicovideo.jp/watch/%73m1",
  "https://www.nicovideo.jp/watch/sm1;echo",
  "https://nico.ms/sm123456789012345678901",
])("rejects unsafe or unsupported input %s before spawning", async (value) => {
  await expect(
    new NiconicoAdapter().open(value, new AbortController().signal),
  ).rejects.toThrow();
  expect(command).not.toHaveBeenCalled();
});

it("fetches validated metadata without downloading media or returning signed URLs", async () => {
  vi.mocked(command).mockReturnValue(
    result(
      JSON.stringify({
        ...valid,
        url: "https://media.invalid/?signature=secret",
        webpage_url: "http://127.0.0.1/",
      }),
    ),
  );
  expect(
    await new NiconicoAdapter().metadata(url, new AbortController().signal),
  ).toEqual({
    id: valid.id,
    title: valid.title,
    duration: valid.duration,
    url,
  });
  const args = vi.mocked(command).mock.calls[0]![1];
  expect(args).toEqual(
    expect.arrayContaining([
      "--skip-download",
      "--dump-single-json",
      "--use-extractors",
      "Niconico$",
    ]),
  );
  expect(args.at(-1)).toBe(url);
  expect(decode).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("secret");
});

it("limits concurrent list-title subprocesses and releases the slot afterward", async () => {
  vi.mocked(command).mockImplementation(() => result(JSON.stringify(valid)));
  const adapter = new NiconicoAdapter();
  const signal = new AbortController().signal;
  const first = adapter.title(url, signal);
  await expect(adapter.title(url, signal)).rejects.toThrow("取得中");
  expect(await first).toBe(valid.title);
  expect(await adapter.title(url, signal)).toBe(valid.title);
  expect(command).toHaveBeenCalledTimes(2);
});

it("streams audio-only stdout to the existing decoder without YouTube credentials/options", async () => {
  vi.stubEnv("YOUTUBE_COOKIES_ENABLED", "true");
  vi.stubEnv("YOUTUBE_COOKIE_SECRET_ID", "never-use-this-secret");
  vi.stubEnv("YOUTUBE_POT_ENABLED", "true");
  const download = result("audio-placeholder");
  const decoded = {
    stream: new PassThrough(),
    done: Promise.resolve(),
    stop: vi.fn(),
  };
  vi.mocked(command)
    .mockReturnValueOnce(result(JSON.stringify(valid)))
    .mockReturnValueOnce(download);
  vi.mocked(decode).mockReturnValue(decoded);
  const signal = new AbortController().signal;
  const source = await new NiconicoAdapter().open(url, signal);
  await source.done;
  expect(source.metadata).toEqual({
    id: valid.id,
    title: valid.title,
    duration: 120,
    url,
  });
  expect(source.stream).toBe(decoded.stream);
  expect(decode).toHaveBeenCalledWith(download.child.stdout, signal);
  for (const [, args] of vi.mocked(command).mock.calls) {
    expect(args).toEqual(
      expect.arrayContaining([
        "-f",
        "bestaudio[vcodec=none][acodec!=none]",
        "--ignore-config",
        "--no-plugin-dirs",
      ]),
    );
    expect(args).not.toContain("--cookies");
    expect(args).not.toContain("--js-runtimes");
    expect(args).not.toContain("--extractor-args");
    expect(args.join(" ")).not.toContain("never-use-this-secret");
  }
  expect(vi.mocked(command).mock.calls[1]![1]).toEqual(
    expect.arrayContaining(["-o", "-"]),
  );
  source.stop();
  expect(download.stop).toHaveBeenCalledOnce();
  expect(decoded.stop).toHaveBeenCalledOnce();
});

it.each([
  { vcodec: "h264" },
  { vcodec: undefined },
  { acodec: "none" },
  { availability: "premium_only" },
  { availability: "private" },
  { availability: "subscriber_only" },
  { availability: undefined },
  { is_live: true },
  { has_drm: true },
  { live_status: "was_live" },
  { _type: "playlist" },
  { duration: 0 },
  { duration: 7201 },
])("does not fall back to video or restricted media: %j", async (changes) => {
  vi.mocked(command).mockReturnValue(
    result(JSON.stringify({ ...valid, ...changes })),
  );
  await expect(
    new NiconicoAdapter().open(url, new AbortController().signal),
  ).rejects.toThrow();
  expect(command).toHaveBeenCalledOnce();
  expect(decode).not.toHaveBeenCalled();
});

it.each([
  "null",
  "[]",
  "{bad signature=secret",
  '{"id":"sm1"}',
  JSON.stringify({ ...valid, id: "https://evil/" }),
  JSON.stringify({ ...valid, title: " " }),
])("rejects malformed metadata without exposing it", async (json) => {
  vi.mocked(command).mockReturnValue(result(json));
  const failure = await new NiconicoAdapter()
    .open(url, new AbortController().signal)
    .catch((error) => error);
  expect(failure).toMatchObject({
    details: { classification: "invalid_metadata", stage: "metadata" },
  });
  expect(JSON.stringify(failure)).not.toContain("secret");
});

it.each([
  ["Premium members only", "provider_restriction"],
  ["Sensitive content, login required", "provider_restriction"],
  ["Video unavailable, set to private", "provider_restriction"],
  ["Video unavailable, may not exist or was deleted", "media_unavailable"],
  ["Removed by rights-holder request", "media_unavailable"],
])("classifies site errors safely: %s", async (message, classification) => {
  vi.mocked(command).mockImplementationOnce((_exe, _args, _signal, context) => {
    context?.observeStderr?.(
      `${message} https://media.invalid/?sig=secret Cookie=secret`,
    );
    const proc = result();
    proc.done = Promise.reject(
      new ProcessFailure({
        stage: "metadata",
        tool: "yt-dlp",
        classification: "process_exit",
        exitCode: 1,
        signal: null,
      }),
    );
    return proc;
  });
  const error = await new NiconicoAdapter()
    .open(url, new AbortController().signal)
    .catch((error) => error);
  expect(error).toMatchObject({
    details: { stage: "metadata", exitCode: 1, classification },
  });
  expect(JSON.stringify(error)).not.toContain("secret");
  expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("secret");
});

it("stops the download when decoder initialization fails", async () => {
  const download = result();
  vi.mocked(command)
    .mockReturnValueOnce(result(JSON.stringify(valid)))
    .mockReturnValueOnce(download);
  vi.mocked(decode).mockImplementationOnce(() => {
    throw new Error("decoder init");
  });
  await expect(
    new NiconicoAdapter().open(url, new AbortController().signal),
  ).rejects.toThrow("decoder init");
  expect(download.stop).toHaveBeenCalledOnce();
});

it.each(["download", "decode"] as const)(
  "reports %s failure and stops the companion process",
  async (stage) => {
    const failure = new ProcessFailure({
      stage,
      tool: stage === "download" ? "yt-dlp" : "ffmpeg",
      classification: stage === "download" ? "http_403" : "invalid_media",
      exitCode: 1,
      signal: null,
    });
    const failed = Promise.reject(failure);
    void failed.catch(() => {});
    const download = result();
    download.done = stage === "download" ? failed : new Promise(() => {});
    const decoded = {
      stream: new PassThrough(),
      done: stage === "decode" ? failed : new Promise<void>(() => {}),
      stop: vi.fn(),
    };
    vi.mocked(command)
      .mockReturnValueOnce(result(JSON.stringify(valid)))
      .mockReturnValueOnce(download);
    vi.mocked(decode).mockReturnValueOnce(decoded);
    const source = await new NiconicoAdapter().open(
      url,
      new AbortController().signal,
    );
    await expect(source.done).rejects.toBe(failure);
    if (stage === "download") expect(decoded.stop).toHaveBeenCalledOnce();
    else expect(download.stop).toHaveBeenCalledOnce();
    source.stop();
  },
);

it("reports upstream HTTP 403 rather than secondary FFmpeg invalid input", async () => {
  const upstream = new ProcessFailure({
    stage: "download",
    tool: "yt-dlp",
    classification: "http_403",
    exitCode: 1,
    signal: null,
  });
  const downstream = new ProcessFailure({
    stage: "decode",
    tool: "ffmpeg",
    classification: "invalid_media",
    exitCode: 1,
    signal: null,
  });
  const download = result();
  download.done = Promise.reject(upstream);
  void download.done.catch(() => {});
  const decoded = {
    stream: new PassThrough(),
    done: Promise.reject(downstream),
    stop: vi.fn(),
  };
  void decoded.done.catch(() => {});
  vi.mocked(command)
    .mockReturnValueOnce(result(JSON.stringify(valid)))
    .mockReturnValueOnce(download);
  vi.mocked(decode).mockReturnValueOnce(decoded);
  const source = await new NiconicoAdapter().open(
    url,
    new AbortController().signal,
  );
  expect(await source.resolveFailure!(downstream)).toBeInstanceOf(
    ProcessFailure,
  );
  expect(await source.resolveFailure!(downstream)).toMatchObject({
    details: { stage: "download", classification: "http_403" },
  });
  source.stop();
});

it("limits metadata size and stops the process", async () => {
  const info = result("x".repeat(4 * 1024 * 1024 + 1));
  vi.mocked(command).mockReturnValueOnce(info);
  await expect(
    new NiconicoAdapter().metadata(url, new AbortController().signal),
  ).rejects.toMatchObject({
    details: { classification: "metadata_too_large" },
  });
  expect(info.stop).toHaveBeenCalledOnce();
});

it("bounds metadata requests and forwards cancellation to the child", async () => {
  vi.useFakeTimers();
  let childSignal!: AbortSignal;
  vi.mocked(command).mockImplementationOnce((_exe, _args, signal) => {
    childSignal = signal;
    const info = result();
    info.done = new Promise((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () =>
          reject(
            new ProcessFailure({
              stage: "metadata",
              tool: "yt-dlp",
              classification: "timeout",
              exitCode: null,
              signal: "SIGTERM",
            }),
          ),
        { once: true },
      ),
    );
    return info;
  });
  const pending = new NiconicoAdapter().metadata(
    url,
    new AbortController().signal,
    10,
  );
  const checked = expect(pending).rejects.toMatchObject({
    details: { classification: "timeout" },
  });
  // AbortSignal.timeout uses real time, independent of Vitest's fake timers.
  vi.useRealTimers();
  await checked;
  expect(childSignal.aborted).toBe(true);
});
