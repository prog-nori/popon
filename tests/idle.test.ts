import { afterEach, expect, it, vi } from "vitest";
import { AutoStopper } from "../src/idle.js";
import { log } from "../src/log.js";
vi.mock("../src/log.js", () => ({ log: vi.fn() }));
afterEach(() => vi.clearAllMocks());
function fixture(enabled = true) {
  let safe = true;
  let valid = true;
  const stop = vi.fn(async () => {});
  const queueEmpty = vi.fn(async () => true);
  const control = new AutoStopper({
    enabled,
    safe: () => safe,
    queueEmpty,
    stop,
  });
  control.request("leave", "guild", () => valid);
  return {
    control,
    stop,
    queueEmpty,
    busy: () => {
      safe = false;
    },
    invalidate: () => {
      valid = false;
    },
  };
}
it("requests stop only after local and queue evidence, with no scale-up or process exit", async () => {
  const f = fixture();
  expect(f.stop).not.toHaveBeenCalled();
  await f.control.check();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.control.isStopping).toBe(true);
  expect(log).toHaveBeenCalledWith("auto_stop_requested", {
    reason: "leave",
    guildId: "guild",
  });
  await f.control.check();
  expect(f.stop).toHaveBeenCalledOnce();
});
it("preserves existing operation when automatic stop is disabled", async () => {
  const f = fixture(false);
  await f.control.check();
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.queueEmpty).not.toHaveBeenCalled();
});
it("blocks for other sessions, unacknowledged messages, preparation or unavailable Gateway", async () => {
  const f = fixture();
  f.busy();
  await f.control.check();
  expect(f.queueEmpty).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
});
it("blocks a queued command even if local processing has completed", async () => {
  const f = fixture();
  f.queueEmpty.mockResolvedValue(false);
  await f.control.check();
  expect(f.stop).not.toHaveBeenCalled();
});
it("cancels a /join arriving during the pre-stop queue check", async () => {
  const f = fixture();
  f.queueEmpty.mockImplementation(async () => {
    f.control.cancel("sqs_command_received");
    return true;
  });
  await f.control.check();
  expect(f.stop).not.toHaveBeenCalled();
});
it("rechecks local state after the remote queue lookup", async () => {
  const f = fixture();
  f.queueEmpty.mockImplementation(async () => {
    f.busy();
    return true;
  });
  await f.control.check();
  expect(f.stop).not.toHaveBeenCalled();
});
it("does not pretend a request already sent to ECS can be cancelled atomically", async () => {
  const f = fixture();
  f.stop.mockImplementation(async () => {
    f.control.cancel("new_start_after_api_sent");
  });
  await f.control.check();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.control.isStopping).toBe(true);
  expect(log).toHaveBeenCalledWith(
    "auto_stop_cancelled",
    expect.objectContaining({ requestInFlight: true }),
  );
});
it("cancels when a human returns after the VC-empty timeout", async () => {
  const f = fixture();
  f.invalidate();
  f.control.revalidate();
  await f.control.check();
  expect(f.stop).not.toHaveBeenCalled();
});
it.each(["queue", "update"])(
  "keeps the process running and does not repeatedly retry a failed %s API",
  async (stage) => {
    const f = fixture();
    if (stage === "queue")
      f.queueEmpty.mockRejectedValue(new Error("sensitive details"));
    else f.stop.mockRejectedValue(new Error("AccessDenied"));
    await f.control.check();
    await f.control.check();
    expect(f.control.isStopping).toBe(false);
    expect(f.queueEmpty).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("auto_stop_failed", {
      reason: "leave",
      guildId: "guild",
    });
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(
      "sensitive details",
    );
  },
);
it("reports the unavoidable race after UpdateService was already sent without issuing desiredCount=1", async () => {
  const f = fixture();
  f.stop.mockImplementation(async () => {
    f.control.cancel("new_command");
  });
  await f.control.check();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.control.isStopping).toBe(true);
  expect(log).toHaveBeenCalledWith(
    "auto_stop_cancelled",
    expect.objectContaining({ requestInFlight: true }),
  );
});
