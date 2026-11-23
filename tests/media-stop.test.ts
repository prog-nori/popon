import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { MediaQueue } from "../src/media/queue.js";

it("stops paused music, clears waiting tracks, and permits new playback", async () => {
  const stopped: string[] = [];
  const played: string[] = [];
  const sources = new Map<Readable, string>();
  const paused = vi.fn();
  const queue = new MediaQueue(
    {
      async open(url) {
        const stream = new Readable({ read() {} });
        sources.set(stream, url);
        return {
          stream,
          done: Promise.resolve(),
          stop: () => {
            stopped.push(url);
          },
        };
      },
    },
    (stream, signal) => {
      played.push(sources.get(stream)!);
      return new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    },
    paused,
  );
  queue.start();
  queue.push("first", async () => {});
  queue.push("discarded", async () => {});
  await vi.waitFor(() => expect(played).toEqual(["first"]));
  expect(queue.pause()).toBe(true);
  expect(queue.isBusy).toBe(true);
  expect(queue.stop()).toBe(true);
  await vi.waitFor(() => expect(queue.isBusy).toBe(false));
  expect(queue.snapshot()).toEqual({
    current: undefined,
    paused: false,
    waiting: [],
  });
  expect(stopped).toEqual(["first"]);
  queue.push("new", async () => {});
  await vi.waitFor(() => expect(played).toEqual(["first", "new"]));
  expect(paused).toHaveBeenLastCalledWith(false);
  queue.close();
  await vi.waitFor(() => expect(queue.isBusy).toBe(false));
});
