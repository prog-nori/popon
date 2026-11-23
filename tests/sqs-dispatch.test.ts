import type { Client } from "discord.js";
import { expect, it, vi } from "vitest";
import { InvalidCommand, type QueuedCommand } from "../src/commands.js";
import { createSqsDispatcher } from "../src/sqs-dispatch.js";

const command: QueuedCommand = {
  id: "1",
  guildId: "2",
  userId: "3",
  channelId: "4",
  name: "join",
  createdAt: 1800000000,
};
function fixture() {
  const vc = { id: "actual-user-vc" };
  const guild = {
    id: "2",
    available: true,
    voiceStates: { cache: new Map([["3", { channel: vc }]]) },
  };
  const send = vi.fn(async (message: unknown) => {
    void message;
  });
  const destination = { guildId: "2", isSendable: () => true, send };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([["2", guild]]) },
    channels: { fetch: vi.fn(async () => destination) },
  };
  return { vc, guild, send, destination, client };
}
it("resolves the user's Gateway voice state independently of the notification channel", async () => {
  const f = fixture();
  const execute = vi.fn(async () => {});
  await createSqsDispatcher(f.client as unknown as Client, execute)(command);
  expect(f.client.channels.fetch).toHaveBeenCalledWith("4");
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      voiceChannel: f.vc,
      guild: f.guild,
      backgroundJoin: true,
    }),
  );
});
it("uses null when the user is no longer in voice, without guessing a VC", async () => {
  const f = fixture();
  f.guild.voiceStates.cache.clear();
  const execute = vi.fn(async () => {});
  await createSqsDispatcher(f.client as unknown as Client, execute)(command);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ voiceChannel: null }),
  );
});
it("retries when Gateway/guild state is not ready", async () => {
  const f = fixture();
  f.guild.available = false;
  const execute = vi.fn(async () => {});
  await expect(
    createSqsDispatcher(f.client as unknown as Client, execute)(command),
  ).rejects.toThrow("guild_not_ready");
  expect(execute).not.toHaveBeenCalled();
});
it("rejects notification channels in a different guild before executing commands", async () => {
  const f = fixture();
  f.destination.guildId = "other";
  const execute = vi.fn(async () => {});
  await expect(
    createSqsDispatcher(f.client as unknown as Client, execute)(command),
  ).rejects.toThrow(InvalidCommand);
  expect(execute).not.toHaveBeenCalled();
});
it("does not retry a successful operation when its result notification fails", async () => {
  const f = fixture();
  f.send.mockRejectedValue(new Error("missing send permission"));
  await expect(
    createSqsDispatcher(f.client as unknown as Client, async (context) => {
      await context.reply("実行完了");
    })(command),
  ).resolves.toBeUndefined();
});
