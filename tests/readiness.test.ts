import { describe, expect, it, vi } from "vitest";
import { announceReady } from "../src/readiness.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("join後の準備完了音", () => {
  it("VC接続とウォームアップの両方を待ち、効果音の後にキューを解放", async () => {
    const voice = deferred(),
      tts = deferred(),
      sound = deferred();
    const order: string[] = [];
    const ready = announceReady(
      [voice.promise, tts.promise],
      new AbortController().signal,
      async () => {
        order.push("sound");
        await sound.promise;
      },
      () => {},
      () => {
        order.push("speech");
      },
    );
    voice.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);
    tts.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["sound"]);
    sound.resolve();
    await ready;
    expect(order).toEqual(["sound", "speech"]);
  });
  it("準備中に退出したら効果音も読み上げも始めない", async () => {
    const controller = new AbortController();
    controller.abort();
    const sound = vi.fn();
    const speech = vi.fn();
    await expect(
      announceReady(
        [Promise.resolve()],
        controller.signal,
        sound,
        () => {},
        speech,
      ),
    ).rejects.toThrow();
    expect(sound).not.toHaveBeenCalled();
    expect(speech).not.toHaveBeenCalled();
  });
  it("効果音ファイルが壊れていても読み上げを継続", async () => {
    const speech = vi.fn(),
      error = vi.fn();
    await announceReady(
      [],
      new AbortController().signal,
      async () => {
        throw new Error("file");
      },
      error,
      speech,
    );
    expect(error).toHaveBeenCalled();
    expect(speech).toHaveBeenCalledOnce();
  });
});

it("exits immediately when leaving during an unfinished prerequisite", async () => {
  const controller = new AbortController();
  const sound = vi.fn(),
    queue = vi.fn();
  const pending = announceReady(
    [new Promise(() => {})],
    controller.signal,
    sound,
    vi.fn(),
    queue,
  );
  const result = expect(pending).rejects.toThrow();
  controller.abort();
  await result;
  expect(sound).not.toHaveBeenCalled();
  expect(queue).not.toHaveBeenCalled();
});
