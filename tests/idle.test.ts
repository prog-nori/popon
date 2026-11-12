import { expect, it, vi } from "vitest";
import { IdleStopper } from "../src/idle.js";

function fixture(coordinated = true) {
  let now = 0;
  let busy = false;
  const scale = vi.fn(async (count: number) => {
    void count;
  });
  const queueEmpty = vi.fn(async () => true);
  const stopped = vi.fn();
  const idle = new IdleStopper({
    enabled: true,
    coordinated,
    idleMs: 300000,
    now: () => now,
    busy: () => busy,
    scale,
    queueEmpty,
    stopped,
  });
  return {
    idle,
    scale,
    queueEmpty,
    stopped,
    time: (value: number) => {
      now = value;
    },
    busy: (value: boolean) => {
      busy = value;
    },
  };
}

it("refuses scale-in without external coordination", async () => {
  const f = fixture(false);
  f.time(900000);
  await f.idle.check();
  expect(f.queueEmpty).not.toHaveBeenCalled();
  expect(f.scale).not.toHaveBeenCalled();
});
it("waits five full minutes after playback/paused music/speech/preparation becomes idle", async () => {
  const f = fixture();
  f.busy(true);
  f.time(300000);
  await f.idle.check();
  f.busy(false);
  f.time(320000);
  await f.idle.check();
  f.time(619999);
  await f.idle.check();
  expect(f.scale).not.toHaveBeenCalled();
  f.time(620000);
  await f.idle.check();
  expect(f.scale).toHaveBeenCalledExactlyOnceWith(0);
  expect(f.stopped).toHaveBeenCalledOnce();
});
it("cancels a pending stop if a command arrives during the queue check", async () => {
  const f = fixture();
  f.time(300000);
  f.queueEmpty.mockImplementation(async () => {
    f.idle.touch();
    return true;
  });
  await f.idle.check();
  expect(f.scale).not.toHaveBeenCalled();
});
it("restores desiredCount=1 if activity arrives during scale-in", async () => {
  const f = fixture();
  f.time(300000);
  f.scale.mockImplementation(async (count) => {
    if (count === 0) f.idle.touch();
  });
  await f.idle.check();
  expect(f.scale.mock.calls.map(([count]) => count)).toEqual([0, 1]);
  expect(f.stopped).not.toHaveBeenCalled();
});
it("does not stop on nonempty or unreadable queues", async () => {
  const f = fixture();
  f.time(300000);
  f.queueEmpty.mockResolvedValue(false);
  await f.idle.check();
  expect(f.scale).not.toHaveBeenCalled();
  f.time(600000);
  f.queueEmpty.mockRejectedValue(new Error("denied"));
  await f.idle.check();
  expect(f.scale).not.toHaveBeenCalled();
});
it("keeps running and restores service after an uncertain scale-in failure", async () => {
  const f = fixture();
  f.time(300000);
  f.scale.mockRejectedValueOnce(new Error("network timeout"));
  await f.idle.check();
  expect(f.scale.mock.calls.map(([count]) => count)).toEqual([0, 1]);
  expect(f.stopped).not.toHaveBeenCalled();
});
