import { describe, expect, it } from "vitest";
import {
  ExpiredCommand,
  InvalidCommand,
  parseQueuedCommand,
} from "../src/commands.js";

const now = 1800000000000;
const input = {
  interaction_id: "123456789012345678",
  guild_id: "123456789012345670",
  user_id: "123456789012345671",
  channel_id: "123456789012345672",
  command: "join",
  options: [],
  created_at: now / 1000,
};
const parse = (overrides = {}) =>
  parseQueuedCommand(JSON.stringify({ ...input, ...overrides }), now, 300000);

describe("Lambda command envelope", () => {
  it("converts seconds and IDs without treating the text channel as the VC", () => {
    expect(parse()).toMatchObject({
      name: "join",
      guildId: input.guild_id,
      userId: input.user_id,
      channelId: input.channel_id,
      createdAt: now / 1000,
    });
  });
  it("preserves the registered commands and normalizes queue to list", () => {
    for (const command of [
      "join",
      "leave",
      "play",
      "pause",
      "resume",
      "skip",
      "list",
      "help",
      "stop",
      "queue",
    ]) {
      const options =
        command === "play"
          ? [{ name: "url", type: 3, value: "https://youtu.be/abcdefghijk" }]
          : [];
      expect(parse({ command, options }).name).toBe(
        command === "queue" ? "list" : command,
      );
    }
  });
  it("extracts a typed /play URL", () => {
    expect(
      parse({
        command: "play",
        options: [
          { name: "url", type: 3, value: "https://youtu.be/abcdefghijk" },
        ],
      }).url,
    ).toBe("https://youtu.be/abcdefghijk");
  });
  it.each([
    { guild_id: 123 },
    { channel_id: "" },
    { command: "delete" },
    { options: null },
    { created_at: "1800000000" },
    { created_at: now / 1000 + 61 },
    { command: "play" },
    { command: "play", options: [{ name: "url", type: 4, value: 123 }] },
  ])("rejects malformed messages: %j", (overrides) => {
    expect(() => parse(overrides)).toThrow(InvalidCommand);
  });
  it("rejects expired commands and timestamp unit mistakes", () => {
    expect(() => parse({ created_at: now / 1000 - 300 })).toThrow(
      ExpiredCommand,
    );
    expect(() => parse({ created_at: now })).toThrow(InvalidCommand);
    expect(() => parseQueuedCommand("null", now, 300000)).toThrow(
      InvalidCommand,
    );
    expect(() => parseQueuedCommand("{", now, 300000)).toThrow(InvalidCommand);
  });
});
