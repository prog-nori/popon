import { expect, it } from "vitest";
import { command, decode } from "../src/audio/process.js";
import {
  classifyProcessFailure,
  failureDetails,
  ProcessFailure,
} from "../src/audio/failure.js";

it.each([
  ["ERROR: HTTP Error 403: Forbidden", "http_403"],
  ["HTTP error 429 Too Many Requests", "http_429"],
  ["Sign in to confirm you're not a bot", "provider_restriction"],
  ["Temporary failure in name resolution", "dns"],
  ["Connection reset by peer", "network"],
  ["The read operation timed out", "timeout"],
  ["n challenge solving failed", "javascript_challenge"],
  ["Requested format is not available", "format_unavailable"],
  ["pipe:0: Invalid data found when processing input", "invalid_media"],
])("classifies stderr without returning it: %s", (stderr, expected) => {
  expect(classifyProcessFailure(stderr)).toBe(expected);
});

it("records the process stage and exit status, discarding secrets in stderr and argv", async () => {
  const secret =
    "Cookie=secret https://media.invalid/?sig=secret discord_token=secret";
  const proc = command(
    process.execPath,
    [
      "-e",
      "process.stderr.write(process.argv[1]);process.exitCode=1",
      `HTTP Error 403: Forbidden ${secret}`,
    ],
    new AbortController().signal,
    { stage: "download", tool: "yt-dlp" },
  );
  proc.child.stdin.end();
  const error = await proc.done.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ProcessFailure);
  expect(failureDetails(error)).toMatchObject({
    stage: "download",
    tool: "yt-dlp",
    classification: "http_403",
    exitCode: 1,
    signal: null,
  });
  expect(String(error)).not.toContain("secret");
  expect(JSON.stringify(error)).not.toContain("secret");
});

it.skipIf(process.platform === "win32")(
  "distinguishes SIGKILL from a regular nonzero exit without claiming OOM",
  async () => {
    const proc = command(
      process.execPath,
      ["-e", 'process.kill(process.pid,"SIGKILL")'],
      new AbortController().signal,
    );
    proc.child.stdin.end();
    await expect(proc.done).rejects.toMatchObject({
      details: { exitCode: null, signal: "SIGKILL", classification: "killed" },
    });
  },
);

it("retains a timeout reason when killing a process", async () => {
  const proc = command(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    AbortSignal.timeout(50),
  );
  await expect(proc.done).rejects.toMatchObject({
    details: { classification: "timeout" },
  });
});

it("reports a missing executable safely", async () => {
  const proc = command(
    "/missing/private-path/yt-dlp",
    [],
    new AbortController().signal,
    { stage: "metadata", tool: "yt-dlp" },
  );
  await expect(proc.done).rejects.toMatchObject({
    details: { classification: "missing_executable", stage: "metadata" },
  });
});

it("reports invalid input as a decode failure and keeps raw stderr private", async () => {
  const proc = decode(
    Buffer.from("not audio; https://media.invalid/?sig=secret"),
    new AbortController().signal,
  );
  proc.stream.resume();
  const error = await proc.done.catch((error: unknown) => error);
  expect(failureDetails(error)).toMatchObject({
    stage: "decode",
    tool: "ffmpeg",
    classification: "invalid_media",
  });
  expect(JSON.stringify(error)).not.toContain("secret");
});

it("discards unknown playback exception text", () => {
  expect(
    JSON.stringify(failureDetails(new Error("token=secret"))),
  ).not.toContain("secret");
});

it("recognizes a timeout even when an aborted stream reports only premature close", () => {
  const controller = new AbortController();
  controller.abort(new DOMException("sensitive", "TimeoutError"));
  expect(
    failureDetails(new Error("premature close"), "decode", controller.signal)
      .classification,
  ).toBe("timeout");
});
