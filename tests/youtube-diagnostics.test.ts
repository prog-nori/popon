import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/audio/process.js", () => ({
  command: vi.fn(),
  decode: vi.fn(),
}));
import { command, decode } from "../src/audio/process.js";
import { ProcessFailure } from "../src/audio/failure.js";
import { YoutubeAdapter } from "../src/media/youtube.js";

afterEach(() => vi.resetAllMocks());

function metadata(value: string) {
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

it("rejects malformed metadata without forwarding JSON containing signed URLs", async () => {
  vi.mocked(command).mockReturnValueOnce(
    metadata('{"url":"https://media.invalid/?signature=secret"'),
  );
  const error = await new YoutubeAdapter()
    .open(
      "https://www.youtube.com/watch?v=ez8Uv-pi0Jg",
      new AbortController().signal,
    )
    .catch((error: unknown) => error);
  expect(error).toMatchObject({
    details: { stage: "metadata", classification: "invalid_metadata" },
  });
  expect(String(error)).not.toContain("secret");
  expect(vi.mocked(decode)).not.toHaveBeenCalled();
});

it.each(["http_403", "process_exit"] as const)(
  "selects the root cause without hiding a decode failure: upstream %s",
  async (classification) => {
    const upstream = new ProcessFailure({
      stage: "download",
      tool: "yt-dlp",
      exitCode: 1,
      signal: null,
      classification,
    });
    const downstream = new ProcessFailure({
      stage: "decode",
      tool: "ffmpeg",
      exitCode: 1,
      signal: null,
      classification: "invalid_media",
    });
    const download = metadata("");
    download.done = Promise.reject(upstream);
    void download.done.catch(() => {});
    vi.mocked(command)
      .mockReturnValueOnce(
        metadata(
          JSON.stringify({
            duration: 200,
            live_status: "not_live",
            availability: "public",
          }),
        ),
      )
      .mockReturnValueOnce(download);
    const decoded = {
      stream: new PassThrough(),
      done: Promise.reject(downstream),
      stop: vi.fn(),
    };
    void decoded.done.catch(() => {});
    vi.mocked(decode).mockReturnValueOnce(decoded);
    const source = await new YoutubeAdapter().open(
      "https://www.youtube.com/watch?v=ez8Uv-pi0Jg",
      new AbortController().signal,
    );
    void source.done.catch(() => {});
    expect(await source.resolveFailure!(downstream)).toBe(
      classification === "http_403" ? upstream : downstream,
    );
    const args = vi.mocked(command).mock.calls[0]![1];
    expect(args).toContain("--js-runtimes");
    expect(args).toContain(`node:${process.execPath}`);
    source.stop();
    expect(download.stop).toHaveBeenCalledOnce();
    expect(decoded.stop).toHaveBeenCalledOnce();
  },
);
