import type { Client } from "discord.js";
import {
  InvalidCommand,
  type CommandContext,
  type QueuedCommand,
} from "./commands.js";
import { log } from "./log.js";

/** Keep the Gateway connection for voice states and voiceAdapterCreator. */
export function createSqsDispatcher(
  client: Client,
  execute: (command: CommandContext) => Promise<void>,
) {
  return async (command: QueuedCommand): Promise<void> => {
    if (!client.isReady()) throw new Error("discord_not_ready");
    const guild = client.guilds.cache.get(command.guildId);
    if (!guild || !guild.available) throw new Error("guild_not_ready");
    let channel;
    try {
      channel = await client.channels.fetch(command.channelId);
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 10003 || code === 50001 || code === 50013)
        throw new InvalidCommand("notification_channel_unavailable");
      throw error;
    }
    if (
      !channel ||
      !("guildId" in channel) ||
      channel.guildId !== guild.id ||
      !channel.isSendable()
    )
      throw new InvalidCommand("invalid_notification_channel");
    const destination = channel;
    await execute({
      name: command.name,
      guildId: command.guildId,
      guild,
      // channel_id describes where the slash command was used, not the user's VC.
      voiceChannel:
        guild.voiceStates.cache.get(command.userId)?.channel ?? null,
      url: command.url,
      backgroundJoin: true,
      reply: async (message) => {
        try {
          await destination.send({
            ...(typeof message === "string" ? { content: message } : message),
            allowedMentions: { parse: [] },
          });
        } catch {
          // A failed notification must never cause /play or /skip to run twice.
          log("command_notification_failed", {
            id: command.id,
            channelId: command.channelId,
          });
        }
      },
    });
  };
}
