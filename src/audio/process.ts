import { spawn } from "node:child_process";
import { PassThrough, Readable } from "node:stream";

// Each process is owned by a track. No shell, bounded stderr, forced kill fallback.
export function command(
  executable: string,
  args: string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const child = spawn(executable, args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });
  let stderr = "";
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
    }
  };
  const stop = () => {
    child.stdin.destroy();
    child.stdout.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 2000);
    }
  };
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  // Errors are forwarded via completion; stdin EPIPE is covered by exit status.
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(killTimer);
      if (process.platform !== "win32") kill("SIGKILL");
      signal.removeEventListener("abort", stop);
      if (code === 0 && !signal.aborted) resolve();
      else
        reject(
          new Error(`${executable} の処理に失敗しました (${code}): ${stderr}`),
        );
    });
  });
  void done.catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return { child, done, stop };
}

export function decode(input: Buffer | string | Readable, signal: AbortSignal) {
  const process = command(
    processEnvFFmpeg(),
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      typeof input === "string" ? input : "pipe:0",
      "-vn",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    signal,
  );
  if (typeof input !== "string") {
    const source = Buffer.isBuffer(input) ? Readable.from(input) : input;
    source.on("error", () => process.stop());
    source.pipe(process.child.stdin);
    process.child.once("close", () => source.destroy());
  } else process.child.stdin.end();
  // ChildProcess resumes stdout automatically on exit. Reading stdout with
  // read(n) directly would then discard buffered PCM without a data listener.
  // Keep a pipe consumer attached and let the mixer drain this bounded buffer.
  const stream = new PassThrough({ highWaterMark: 3840 });
  stream.on("error", () => {});
  process.child.stdout.on("error", (error) => stream.destroy(error));
  process.child.stdout.pipe(stream);
  void process.done.catch((error: Error) => stream.destroy(error));
  const stop = () => {
    stream.destroy();
    process.stop();
  };
  signal.addEventListener("abort", stop, { once: true });
  stream.once("close", () => signal.removeEventListener("abort", stop));
  if (signal.aborted) stop();
  return { stream, done: process.done, stop };
}
function processEnvFFmpeg(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}
