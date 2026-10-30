import { it, expect } from "vitest";
import { command, decode } from "../src/audio/process.js";
import { spawnSync } from "node:child_process";

it("reports subprocess failures and safely passes argument strings", async () => {
  const value = "$(touch /tmp/popon-should-not-exist); 'quoted'";
  const proc = command(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1]); process.exitCode=3", value],
    new AbortController().signal,
  );
  let output = "";
  proc.child.stdout.on("data", (data) => {
    output += data;
  });
  proc.child.stdin.end();
  await expect(proc.done).rejects.toThrow("処理に失敗");
  expect(output).toBe(value);
});
it("terminates a running subprocess on cancellation", async () => {
  const controller = new AbortController();
  const proc = command(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    controller.signal,
  );
  controller.abort();
  await expect(proc.done).rejects.toThrow();
  expect(proc.child.signalCode).not.toBeNull();
});
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
it.skipIf(spawnSync(ffmpeg, ["-version"]).status !== 0)(
  "normalizes local WAV to stereo PCM and closes the decoder",
  async () => {
    const decoded = decode(
      "assets/sounds/meet_style.wav",
      new AbortController().signal,
    );
    let bytes = 0;
    for await (const chunk of decoded.stream) bytes += (chunk as Buffer).length;
    await decoded.done;
    expect(bytes).toBeGreaterThan(3840);
    expect(bytes % 4).toBe(0);
    decoded.stop();
  },
);

it.skipIf(spawnSync(ffmpeg, ["-version"]).status !== 0)(
  "mixes two real decoders through the Discord Opus resource to output completion",
  async () => {
    const { Mixer } = await import("../src/audio/mixer.js");
    const { createAudioResource, StreamType } =
      await import("@discordjs/voice");
    const mixer = new Mixer();
    const resource = createAudioResource(mixer, { inputType: StreamType.Raw });
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(10000),
    ]);
    const media = decode("assets/sounds/meet_style.wav", signal);
    const speech = decode("assets/sounds/meet_style.wav", signal);
    let packets = 0;
    const timer = setInterval(() => {
      if (resource.readable && resource.read()) packets++;
      mixer.acknowledge(Math.max(0, resource.playbackDuration / 20 - 1));
    }, 20);
    try {
      await Promise.all([
        mixer.play("media", media.stream, signal),
        mixer.play("speech", speech.stream, signal),
        media.done,
        speech.done,
      ]);
      expect(packets).toBeGreaterThan(5);
    } finally {
      controller.abort();
      clearInterval(timer);
      mixer.close();
      resource.playStream.destroy();
      media.stop();
      speech.stop();
    }
  },
  15000,
);

it.skipIf(spawnSync(ffmpeg, ["-version"]).status !== 0)(
  "keeps the full WAV including its tail when PCM is read at playback speed",
  async () => {
    const { readFile } = await import("node:fs/promises");
    const wav = await readFile("assets/sounds/meet_style.wav");
    const expected = spawnSync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1",
      ],
      { input: wav },
    ).stdout;
    const decoded = decode(wav, new AbortController().signal);
    const chunks: Buffer[] = [];
    try {
      while (!decoded.stream.readableEnded) {
        const data = decoded.stream.read(3840) as Buffer | null;
        if (data) chunks.push(data);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await decoded.done;
      expect(Buffer.concat(chunks).length).toBe(expected.length);
      expect(Buffer.concat(chunks)).toEqual(expected);
    } finally {
      decoded.stop();
    }
  },
  10000,
);
