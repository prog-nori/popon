import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const cookieState = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("../src/media/cookies.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/media/cookies.js")
  >("../src/media/cookies.js");
  return { ...actual, youtubeCookies: { acquire: cookieState.acquire } };
});
vi.mock("../src/audio/process.js", () => ({
  command: vi.fn(),
  decode: vi.fn(),
}));
vi.mock("../src/log.js", () => ({ log: vi.fn() }));
import { command, decode } from "../src/audio/process.js";
import { ProcessFailure } from "../src/audio/failure.js";
import { log } from "../src/log.js";
import { YoutubeAdapter } from "../src/media/youtube.js";

const url = "https://www.youtube.com/watch?v=lxk1UcXcLc8";
const metadata =
  '{"duration":30,"live_status":"not_live","availability":"public"}';
function lease() {
  const value = {
    path: "/tmp/mock-private-directory/cookies.txt",
    holdUntil: vi.fn(),
    release: vi.fn(async () => {}),
  };
  cookieState.acquire.mockResolvedValue(value);
  return value;
}
function result(text: string, context: Parameters<typeof command>[3]) {
  const stdout = new PassThrough();
  context?.observeStderr?.(
    "[debug] PO Token Providers: bgutil:http-2.0.2 (external)\n[debug] Found YouTube account cookies\n",
  );
  const done = new Promise<void>((resolve) =>
    queueMicrotask(() => {
      stdout.end(text);
      resolve();
    }),
  );
  return {
    child: { stdin: new PassThrough(), stdout, exitCode: 0, signalCode: null },
    done,
    stop: vi.fn(),
  } as unknown as ReturnType<typeof command>;
}
function commands() {
  vi.mocked(command).mockImplementationOnce((_exe, _args, _signal, context) =>
    result(metadata, context),
  );
  vi.mocked(command).mockImplementationOnce((_exe, _args, _signal, context) =>
    result("mock-audio", context),
  );
  vi.mocked(decode).mockReturnValue({
    stream: new PassThrough(),
    done: Promise.resolve(),
    stop: vi.fn(),
  });
}
afterEach(() => {
  expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(
    "MOCK_COOKIE_VALUE",
  );
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "preserves extraction/decode with cookies=%s and PO=%s",
  async (cookies, pot) => {
    vi.stubEnv("YOUTUBE_COOKIES_ENABLED", String(cookies));
    vi.stubEnv("YOUTUBE_COOKIE_SECRET_ID", "/discord-bot/prod/youtube-cookies");
    vi.stubEnv("YOUTUBE_POT_ENABLED", String(pot));
    vi.stubEnv("YOUTUBE_POT_BASE_URL", "http://pot-provider:4416");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"version":"2.0.2"}')),
    );
    const jar = lease();
    commands();
    const source = await new YoutubeAdapter().open(
      url,
      new AbortController().signal,
    );
    await source.done;
    expect(cookieState.acquire.mock.calls.length).toBe(cookies ? 1 : 0);
    for (const [, args] of vi.mocked(command).mock.calls) {
      expect(args.includes("--cookies")).toBe(cookies);
      if (cookies) expect(args[args.indexOf("--cookies") + 1]).toBe(jar.path);
      expect(args).toContain("--js-runtimes");
      expect(args).toContain(`node:${process.execPath}`);
      expect(args).toEqual(
        expect.arrayContaining(["--socket-timeout", "15", "--retries", "2"]),
      );
      expect(args.includes("youtube:player_client=mweb;fetch_pot=always")).toBe(
        pot,
      );
      expect(
        args.includes(
          "youtubepot-bgutilhttp:base_url=http://pot-provider:4416",
        ),
      ).toBe(pot);
      expect(args.includes("--no-plugin-dirs")).toBe(!pot);
      expect(args.join(" ")).not.toContain("MOCK_COOKIE_VALUE");
    }
    expect(vi.mocked(command).mock.calls[0]![1]).toContain("--skip-download");
    expect(vi.mocked(command).mock.calls[1]![1]).toEqual(
      expect.arrayContaining(["-f", "bestaudio", "-o", "-"]),
    );
    expect(decode).toHaveBeenCalledWith(
      expect.any(PassThrough),
      expect.any(AbortSignal),
    );
    expect(jar.holdUntil.mock.calls.length).toBe(cookies ? 2 : 0);
    expect(jar.release.mock.calls.length).toBe(cookies ? 1 : 0);
  },
);

it("does not start yt-dlp when the secret cannot be retrieved", async () => {
  vi.stubEnv("YOUTUBE_COOKIES_ENABLED", "true");
  vi.stubEnv("YOUTUBE_COOKIE_SECRET_ID", "/discord-bot/prod/youtube-cookies");
  cookieState.acquire.mockRejectedValue(
    new ProcessFailure({
      stage: "cookies",
      tool: "secrets-manager",
      classification: "cookie_secret_access_denied",
      exitCode: null,
      signal: null,
    }),
  );
  await expect(
    new YoutubeAdapter().open(url, new AbortController().signal),
  ).rejects.toMatchObject({
    details: { classification: "cookie_secret_access_denied" },
  });
  expect(command).not.toHaveBeenCalled();
  expect(decode).not.toHaveBeenCalled();
});

it("cleans up and reports continued LOGIN_REQUIRED after cookie preparation", async () => {
  vi.stubEnv("YOUTUBE_COOKIES_ENABLED", "true");
  vi.stubEnv("YOUTUBE_COOKIE_SECRET_ID", "/discord-bot/prod/youtube-cookies");
  const jar = lease();
  vi.mocked(command).mockImplementationOnce((_exe, _args, _signal, context) => {
    const process = result("", context);
    context?.observeStderr?.(
      "[debug] mweb player response playability status: LOGIN_REQUIRED\nCookie: MOCK_COOKIE_VALUE\n",
    );
    process.done = Promise.reject(
      new ProcessFailure({
        stage: "metadata",
        tool: "yt-dlp",
        classification: "youtube_login_required",
        exitCode: 1,
        signal: null,
      }),
    );
    return process;
  });
  await expect(
    new YoutubeAdapter().open(url, new AbortController().signal),
  ).rejects.toMatchObject({
    details: { classification: "youtube_login_required" },
  });
  expect(jar.release).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(
    "youtube_cookie_auth_result",
    expect.objectContaining({
      stage: "metadata",
      outcome: "login_required",
      loginAcceptance: "rejected",
    }),
  );
  expect(decode).not.toHaveBeenCalled();
});

it("releases the jar on provider failure without changing the provider configuration", async () => {
  vi.stubEnv("YOUTUBE_COOKIES_ENABLED", "true");
  vi.stubEnv("YOUTUBE_COOKIE_SECRET_ID", "/discord-bot/prod/youtube-cookies");
  vi.stubEnv("YOUTUBE_POT_ENABLED", "true");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("MOCK_COOKIE_VALUE")),
  );
  const jar = lease();
  await expect(
    new YoutubeAdapter().open(url, new AbortController().signal),
  ).rejects.toMatchObject({
    details: { classification: "pot_provider_unavailable" },
  });
  expect(jar.release).toHaveBeenCalledOnce();
  expect(command).not.toHaveBeenCalled();
});

it("distinguishes GVS HTTP 403 after cookie-enabled metadata succeeded", async () => {
  vi.stubEnv("YOUTUBE_COOKIES_ENABLED", "true");
  vi.stubEnv("YOUTUBE_COOKIE_SECRET_ID", "/discord-bot/prod/youtube-cookies");
  const jar = lease();
  vi.mocked(command).mockImplementationOnce((_exe, _args, _signal, context) =>
    result(metadata, context),
  );
  const upstream = new ProcessFailure({
    stage: "download",
    tool: "yt-dlp",
    classification: "http_403",
    exitCode: 1,
    signal: null,
  });
  vi.mocked(command).mockImplementationOnce((_exe, _args, _signal, context) => {
    const process = result("", context);
    context?.observeStderr?.(
      "HTTP Error 403: Forbidden\nhttps://media.invalid/?sig=MOCK_COOKIE_VALUE\n",
    );
    process.done = Promise.reject(upstream);
    return process;
  });
  vi.mocked(decode).mockReturnValue({
    stream: new PassThrough(),
    done: Promise.resolve(),
    stop: vi.fn(),
  });
  const source = await new YoutubeAdapter().open(
    url,
    new AbortController().signal,
  );
  await expect(source.done).rejects.toBe(upstream);
  await vi.waitFor(() => expect(jar.release).toHaveBeenCalledOnce());
  expect(log).toHaveBeenCalledWith(
    "youtube_cookie_auth_result",
    expect.objectContaining({
      stage: "metadata",
      outcome: "metadata_ok",
      loginAcceptance: "unverified",
    }),
  );
  expect(log).toHaveBeenCalledWith(
    "youtube_media_result",
    expect.objectContaining({ stage: "download", classification: "http_403" }),
  );
  source.stop();
});

it("releases the jar on malformed metadata containing a signed URL", async () => {
  vi.stubEnv("YOUTUBE_COOKIES_ENABLED", "true");
  vi.stubEnv("YOUTUBE_COOKIE_SECRET_ID", "/discord-bot/prod/youtube-cookies");
  const jar = lease();
  vi.mocked(command).mockImplementationOnce((_exe, _args, _signal, context) =>
    result('{"url":"https://media.invalid/?sig=MOCK_COOKIE_VALUE"', context),
  );
  const error = await new YoutubeAdapter()
    .open(url, new AbortController().signal)
    .catch((e: unknown) => e);
  expect(error).toMatchObject({
    details: { classification: "invalid_metadata" },
  });
  expect(JSON.stringify(error)).not.toContain("MOCK_COOKIE_VALUE");
  expect(jar.release).toHaveBeenCalledOnce();
});

it("waits for subprocess shutdown before cleanup on cancellation", async () => {
  vi.stubEnv("YOUTUBE_COOKIES_ENABLED", "true");
  vi.stubEnv("YOUTUBE_COOKIE_SECRET_ID", "/discord-bot/prod/youtube-cookies");
  const jar = lease();
  vi.mocked(command).mockImplementationOnce((_exe, _args, _signal, context) =>
    result(metadata, context),
  );
  let finishDownload!: () => void;
  let finishDecode!: () => void;
  const download = result("", undefined);
  download.done = new Promise<void>((resolve) => {
    finishDownload = resolve;
  });
  vi.mocked(command).mockReturnValueOnce(download);
  vi.mocked(decode).mockReturnValue({
    stream: new PassThrough(),
    done: new Promise<void>((resolve) => {
      finishDecode = resolve;
    }),
    stop: vi.fn(),
  });
  const source = await new YoutubeAdapter().open(
    url,
    new AbortController().signal,
  );
  source.stop();
  expect(download.stop).toHaveBeenCalledOnce();
  expect(jar.release).not.toHaveBeenCalled();
  finishDownload();
  await Promise.resolve();
  expect(jar.release).not.toHaveBeenCalled();
  finishDecode();
  await source.done;
  expect(jar.release).toHaveBeenCalledOnce();
});
