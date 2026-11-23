import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/audio/process.js", () => ({
  command: vi.fn(),
  decode: vi.fn(),
}));
vi.mock("../src/log.js", () => ({ log: vi.fn() }));
import { command, decode } from "../src/audio/process.js";
import { YoutubeAdapter } from "../src/media/youtube.js";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function processResult(json: string, args: Parameters<typeof command>[3]) {
  const stdout = new PassThrough();
  args?.observeStderr?.(
    "[debug] [youtube] [pot] PO Token Providers: bgutil:http-2.0.2 (external)\n",
  );
  const done = new Promise<void>((resolve) =>
    queueMicrotask(() => {
      stdout.end(json);
      resolve();
    }),
  );
  return {
    child: { stdin: new PassThrough(), stdout, exitCode: 0, signalCode: null },
    done,
    stop: vi.fn(),
  } as unknown as ReturnType<typeof command>;
}

it.each([false, true])(
  "keeps metadata, bestaudio streaming and decode path with PO enabled=%s",
  async (enabled) => {
    vi.stubEnv("YOUTUBE_POT_ENABLED", String(enabled));
    vi.stubEnv("YOUTUBE_POT_BASE_URL", "http://pot-provider:4416");
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"version":"2.0.2"}'));
    vi.stubGlobal("fetch", fetch);
    vi.mocked(command).mockImplementationOnce((_exe, _args, _signal, context) =>
      processResult(
        '{"duration":30,"live_status":"not_live","availability":"public"}',
        context,
      ),
    );
    vi.mocked(command).mockImplementationOnce((_exe, _args, _signal, context) =>
      processResult("audio-placeholder", context),
    );
    const stream = new PassThrough();
    vi.mocked(decode).mockReturnValue({
      stream,
      done: Promise.resolve(),
      stop: vi.fn(),
    });
    const source = await new YoutubeAdapter().open(
      "https://www.youtube.com/watch?v=lxk1UcXcLc8",
      new AbortController().signal,
    );
    await source.done;
    const calls = vi.mocked(command).mock.calls;
    expect(calls[0]![1]).toContain("--dump-single-json");
    expect(calls[1]![1]).toEqual(
      expect.arrayContaining(["-f", "bestaudio", "-o", "-"]),
    );
    expect(
      calls[0]![1].includes("youtube:player_client=mweb;fetch_pot=always"),
    ).toBe(enabled);
    expect(
      calls[1]![1].includes("youtube:player_client=mweb;fetch_pot=always"),
    ).toBe(enabled);
    expect(calls[0]![1].includes("--no-plugin-dirs")).toBe(!enabled);
    expect(vi.mocked(decode)).toHaveBeenCalledWith(
      expect.any(PassThrough),
      expect.any(AbortSignal),
    );
    expect(fetch.mock.calls.length).toBe(enabled ? 1 : 0);
    source.stop();
  },
);

it("does not start extraction when the opted-in provider is unavailable", async () => {
  vi.stubEnv("YOUTUBE_POT_ENABLED", "true");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("token=secret")));
  await expect(
    new YoutubeAdapter().open(
      "https://www.youtube.com/watch?v=lxk1UcXcLc8",
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    details: { classification: "pot_provider_unavailable" },
  });
  expect(command).not.toHaveBeenCalled();
  expect(decode).not.toHaveBeenCalled();
});
