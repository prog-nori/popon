import type { Client } from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  EmptyVoiceTimer,
  voiceOccupancy,
  type Occupancy,
} from "../src/voice-idle.js";
import { log } from "../src/log.js";
vi.mock("../src/log.js", () => ({ log: vi.fn() }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
function fixture() {
  let occupancy: Occupancy = "empty";
  const expired = vi.fn();
  const timer = new EmptyVoiceTimer({
    idleMs: 60000,
    observe: () => occupancy,
    expired,
  });
  return {
    timer,
    expired,
    state: (value: Occupancy) => {
      occupancy = value;
    },
  };
}
it("starts once and rechecks after sixty seconds", async () => {
  const f = fixture();
  f.timer.update("guild");
  await vi.advanceTimersByTimeAsync(30000);
  f.timer.update("guild");
  await vi.advanceTimersByTimeAsync(29999);
  expect(f.expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.expired).toHaveBeenCalledExactlyOnceWith("guild");
  expect(log).toHaveBeenCalledWith("auto_stop_timer_started", {
    reason: "voice_empty",
    guildId: "guild",
    idleMs: 60000,
  });
});
it("cancels when humans return and starts a new full interval on their next departure", async () => {
  const f = fixture();
  f.timer.update("guild");
  await vi.advanceTimersByTimeAsync(30000);
  f.state("occupied");
  f.timer.update("guild");
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.expired).not.toHaveBeenCalled();
  f.state("empty");
  f.timer.update("guild");
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.expired).toHaveBeenCalledOnce();
});
it.each(["occupied", "unknown"] as const)(
  "does not stop if the final observation is %s even without an event",
  async (state) => {
    const f = fixture();
    f.timer.update("guild");
    f.state(state);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.expired).not.toHaveBeenCalled();
  },
);
it("cancels all timers during reconnect or shutdown", async () => {
  const f = fixture();
  f.timer.update("a");
  f.timer.update("b");
  f.timer.clear("gateway_unavailable");
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.expired).not.toHaveBeenCalled();
});
function clientFixture() {
  const states = new Map<
    string,
    { channelId: string; member?: { user: { bot: boolean } } }
  >([
    ["bot", { channelId: "vc", member: { user: { bot: true } } }],
    ["other-bot", { channelId: "vc", member: { user: { bot: true } } }],
  ]);
  const guild = { available: true, voiceStates: { cache: states } };
  const client = {
    isReady: () => true,
    user: { id: "bot" },
    guilds: { cache: new Map([["guild", guild]]) },
    channels: { cache: new Map([["vc", { isVoiceBased: () => true }]]) },
  };
  return { states, guild, client: client as unknown as Client };
}
it("counts humans, excludes all bots, and observes only the connected VC", () => {
  const f = clientFixture();
  expect(voiceOccupancy(f.client, "guild", "vc")).toBe("empty");
  f.states.set("human", {
    channelId: "other-vc",
    member: { user: { bot: false } },
  });
  expect(voiceOccupancy(f.client, "guild", "vc")).toBe("empty");
  f.states.set("human", { channelId: "vc", member: { user: { bot: false } } });
  expect(voiceOccupancy(f.client, "guild", "vc")).toBe("occupied");
});
it("treats unavailable guilds, missing member data and lost self voice state as unknown", () => {
  const f = clientFixture();
  f.guild.available = false;
  expect(voiceOccupancy(f.client, "guild", "vc")).toBe("unknown");
  f.guild.available = true;
  f.states.set("unknown", { channelId: "vc" });
  expect(voiceOccupancy(f.client, "guild", "vc")).toBe("unknown");
  f.states.delete("unknown");
  f.states.delete("bot");
  expect(voiceOccupancy(f.client, "guild", "vc")).toBe("unknown");
  expect(voiceOccupancy(f.client, "guild", "vc", false)).toBe("empty");
});
