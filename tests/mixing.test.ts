import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Mixer, FRAME_BYTES } from "../src/audio/mixer.js";
import { MediaQueue } from "../src/media/queue.js";
import { youtubeURL } from "../src/media/youtube.js";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function pcm(value: number, frames = 1) {
  const buffer = Buffer.alloc(FRAME_BYTES * frames);
  for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(value, i);
  return buffer;
}
function input(value: number, frames = 10) {
  const stream = new PassThrough();
  stream.write(pcm(value, frames));
  return stream;
}
describe("PCM mix", () => {
  it("ducks only audible speech with a fade and continues consuming media", async () => {
    const mixer = new Mixer();
    const media = input(10000, 20);
    const speech = new PassThrough();
    const controller = new AbortController();
    const a = mixer.play("media", media, controller.signal).catch(() => {});
    const b = mixer.play("speech", speech, controller.signal).catch(() => {});
    expect(mixer.render().readInt16LE(0)).toBe(1250);
    speech.write(pcm(1000, 3));
    const first = mixer.render();
    expect(first.readInt16LE(0)).toBeGreaterThan(1250);
    mixer.render();
    expect(mixer.render().readInt16LE(FRAME_BYTES - 2)).toBe(1188);
    expect(media.readableLength).toBe(16 * FRAME_BYTES);
    for (let i = 0; i < 3; i++) mixer.render();
    expect(mixer.render().readInt16LE(0)).toBe(1250);
    controller.abort();
    mixer.close();
    await Promise.all([a, b]);
  });
  it("eases both directions and reverses an interrupted fade without a gain jump", async () => {
    const mixer = new Mixer();
    const controller = new AbortController();
    const speech = new PassThrough();
    const jobs = [
      mixer.play("media", input(16000, 20), controller.signal).catch(() => {}),
      mixer.play("speech", speech, controller.signal).catch(() => {}),
    ];
    speech.write(pcm(1000, 3));
    const down = Buffer.concat([mixer.render(), mixer.render(), mixer.render()]);
    const sample = (buffer: Buffer, n: number) => buffer.readInt16LE(n * 4);
    // At 25% time smoothstep has covered 15.625% of the gain change.
    expect(sample(down, 719)).toBe(2734);
    expect(sample(down, 1439)).toBe(2150);
    expect(sample(down, 2159)).toBe(1566);
    expect(sample(down, 2879)).toBe(1300);
    const up = Buffer.concat([mixer.render(), mixer.render(), mixer.render()]);
    expect(sample(up, 719)).toBe(566);
    expect(sample(up, 1439)).toBe(1150);
    expect(sample(up, 2159)).toBe(1734);
    expect(sample(up, 2879)).toBe(2000);
    speech.write(pcm(1000));
    const interrupted = mixer.render();
    const recovery = mixer.render();
    expect(Math.abs(sample(recovery, 0) - (sample(interrupted, 959) - 1000))).toBeLessThanOrEqual(1);
    mixer.render();
    expect(sample(mixer.render(), 959)).toBe(2000);
    controller.abort();
    mixer.close();
    await Promise.all(jobs);
  });
  it.each(["abort", "error"])(
    "restores gain after speech %s without stopping media",
    async (mode) => {
      const mixer = new Mixer();
      const signal = new AbortController();
      const speechSignal = new AbortController();
      const media = mixer
        .play("media", input(10000), signal.signal)
        .catch(() => {});
      const speech = input(1000);
      const done = mixer
        .play("speech", speech, speechSignal.signal)
        .catch(() => {});
      for (let i = 0; i < 3; i++) mixer.render();
      if (mode === "abort") speechSignal.abort();
      else speech.destroy(new Error("decode"));
      await tick();
      for (let i = 0; i < 3; i++) mixer.render();
      expect(mixer.render().readInt16LE(0)).toBe(1250);
      mixer.close();
      await Promise.all([done, media]);
    },
  );
  it("waits for transport acknowledgement, handles short tails, and reports start", async () => {
    const mixer = new Mixer();
    const started = vi.fn();
    let ended = false;
    const done = mixer
      .play(
        "speech",
        Readable.from([Buffer.alloc(4, 1)]),
        new AbortController().signal,
        started,
      )
      .then(() => {
        ended = true;
      });
    mixer.render();
    await tick();
    mixer.render();
    await tick();
    expect(started).not.toHaveBeenCalled();
    expect(ended).toBe(false);
    mixer.acknowledge(2);
    await done;
    expect(started).toHaveBeenCalledOnce();
    expect(ended).toBe(true);
    mixer.close();
  });
  it("clips safely, isolates sessions, and rejects pending tracks on close", async () => {
    const one = new Mixer();
    const two = new Mixer();
    const a = one
      .play("speech", input(30000), new AbortController().signal)
      .catch(() => {});
    const b = one
      .play("media", input(30000), new AbortController().signal)
      .catch(() => {});
    expect(one.render().readInt16LE(0)).toBe(32767);
    expect(two.render().every((value) => value === 0)).toBe(true);
    one.close();
    two.close();
    await Promise.all([a, b]);
  });
});
describe("video queue", () => {
  it("preserves order through failures, waits for output, and cancels resources", async () => {
    const opened: string[] = [];
    const stops = vi.fn();
    const notify = vi.fn(async () => {});
    let finish!: () => void;
    const play = vi.fn(
      (_stream: Readable, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          signal.addEventListener("abort", () => reject(new Error("abort")), {
            once: true,
          });
        }),
    );
    const queue = new MediaQueue(
      {
        async open(url) {
          opened.push(url);
          if (url === "bad") throw new Error("fetch");
          return {
            stream: new PassThrough(),
            done: Promise.resolve(),
            stop: stops,
          };
        },
      },
      play,
    );
    queue.push("first", notify);
    queue.push("bad", notify);
    queue.push("last", notify);
    expect(opened).toEqual([]);
    queue.start();
    await tick();
    expect(opened).toEqual(["first"]);
    finish();
    await tick();
    expect(opened).toEqual(["first", "bad", "last"]);
    expect(notify).toHaveBeenCalledOnce();
    queue.close();
    await tick();
    expect(stops).toHaveBeenCalledTimes(2);
    expect(() => queue.push("closed", notify)).toThrow();
  });
  it("limits queue and validates canonical YouTube URLs", () => {
    const queue = new MediaQueue({ open: vi.fn() }, vi.fn());
    for (let i = 0; i < 20; i++) queue.push("url", async () => {});
    expect(() => queue.push("url", async () => {})).toThrow();
    queue.close();
    expect(youtubeURL("https://youtu.be/abcdefghijk?t=1")).toBe(
      "https://www.youtube.com/watch?v=abcdefghijk",
    );
    for (const url of [
      "http://youtube.com/watch?v=abcdefghijk",
      "https://youtube.com.evil/watch?v=abcdefghijk",
      "https://youtube.com/playlist?list=foo",
      "https://youtube.com/live/abcdefghijk",
      "file:///tmp/a",
      "https://u:p@youtube.com/watch?v=abcdefghijk",
    ])
      expect(() => youtubeURL(url)).toThrow();
  });
});

it("bounds output prefetch when the transport stops consuming", async () => {
  const mixer = new Mixer();
  let frames = 0;
  mixer.on("data", () => {
    frames++;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(frames).toBe(5);
  mixer.acknowledge(3);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(frames).toBe(8);
  mixer.close();
});

it("advances on output completion even if process cleanup has not finished", async () => {
  const opened: string[] = [];
  const stopped: string[] = [];
  let finishOutput!: () => void;
  const queue = new MediaQueue(
    {
      async open(url) {
        opened.push(url);
        return {
          stream: new PassThrough(),
          done: new Promise<void>(() => {}),
          stop() {
            stopped.push(url);
          },
        };
      },
    },
    () =>
      new Promise<void>((resolve) => {
        finishOutput = resolve;
      }),
  );
  const notify = vi.fn(async () => {});
  try {
    queue.push("first", notify);
    queue.push("second", notify);
    queue.start();
    await tick();
    expect(opened).toEqual(["first"]);
    finishOutput();
    await tick();
    expect(opened).toEqual(["first", "second"]);
    expect(stopped).toEqual(["first"]);
    expect(notify).not.toHaveBeenCalled();
  } finally {
    queue.close();
  }
});

it("continues after acquisition fails during playback without waiting for its stalled player", async () => {
  const opened: string[] = [];
  let fail!: (error: Error) => void;
  const notify = vi.fn(async () => {});
  const queue = new MediaQueue(
    {
      async open(url) {
        opened.push(url);
        return {
          stream: new PassThrough(),
          done: new Promise<void>((_, reject) => {
            fail = reject;
          }),
          stop() {},
        };
      },
    },
    () => new Promise<void>(() => {}),
  );
  queue.push("broken", notify);
  queue.push("next", notify);
  queue.start();
  await tick();
  fail(new Error("download failed"));
  await tick();
  expect(opened).toEqual(["broken", "next"]);
  expect(notify).toHaveBeenCalledOnce();
  queue.close();
  await tick();
});

it("closes promptly and keeps draining after a cleanup error", async () => {
  const stopped: string[] = [];
  const queue = new MediaQueue(
    {
      async open(url) {
        return {
          stream: new PassThrough(),
          done: new Promise<void>(() => {}),
          stop() {
            stopped.push(url);
            if (url === "first") throw new Error("cleanup");
          },
        };
      },
    },
    () =>
      stopped.length === 0 ? Promise.resolve() : new Promise<void>(() => {}),
  );
  queue.push("first", async () => {});
  queue.push("second", async () => {});
  queue.start();
  await tick();
  expect(stopped).toEqual(["first"]);
  queue.close();
  await tick();
  expect(stopped).toEqual(["first", "second"]);
});

it.each([
  "https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk&index=2",
  "https://youtu.be/abcdefghijk?list=PLexample&index=3&si=shared",
  "https://www.youtube.com/watch?v=abcdefghijk&start_radio=1&t=42",
])("accepts the individual video from a mix or playlist context: %s", (url) => {
  expect(youtubeURL(url)).toBe("https://www.youtube.com/watch?v=abcdefghijk");
  expect(youtubeURL(url)).toBe("https://www.youtube.com/watch?v=abcdefghijk");
});

it("accepts the reported shared mix URL as a single video", () => {
  expect(
    youtubeURL("https://youtu.be/qP-7GNoDJ5c?list=RDqP-7GNoDJ5c,\u00a0"),
  ).toBe("https://www.youtube.com/watch?v=qP-7GNoDJ5c");
});
