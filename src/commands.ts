import type { APIEmbed, Guild, VoiceBasedChannel } from "discord.js";

export const commandNames = [
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
] as const;
export type CommandName = Exclude<(typeof commandNames)[number], "queue">;
export type CommandReply = string | { embeds: APIEmbed[] };

/** Transport-independent input to the existing session/music implementation. */
export interface CommandContext {
  name: CommandName;
  guildId: string;
  guild: Guild;
  voiceChannel: VoiceBasedChannel | null;
  url?: string;
  reply: (message: CommandReply) => Promise<unknown>;
  backgroundJoin?: boolean;
}

export interface QueuedCommand {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  name: CommandName;
  createdAt: number;
  url?: string;
}

/** Permanent input failures must not block a FIFO message group forever. */
export class InvalidCommand extends Error {}
export class ExpiredCommand extends InvalidCommand {}

export function commandName(value: unknown): CommandName | undefined {
  if (!commandNames.includes(value as (typeof commandNames)[number])) return;
  return value === "queue" ? "list" : (value as CommandName);
}

export function parseQueuedCommand(
  body: string,
  now: number,
  ttlMs: number,
): QueuedCommand {
  let data: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    data = value as Record<string, unknown>;
  } catch {
    throw new InvalidCommand("invalid_json");
  }
  for (const key of ["interaction_id", "guild_id", "user_id", "channel_id"]) {
    if (typeof data[key] !== "string" || !/^\d{1,20}$/.test(data[key]))
      throw new InvalidCommand(`invalid_${key}`);
  }
  const name = commandName(data.command);
  if (!name || !Array.isArray(data.options) || data.options.length > 25)
    throw new InvalidCommand("invalid_command_or_options");
  if (
    typeof data.created_at !== "number" ||
    !Number.isSafeInteger(data.created_at) ||
    data.created_at <= 0
  )
    throw new InvalidCommand("invalid_created_at");
  const createdAt = data.created_at;
  if (createdAt * 1000 > now + 60000)
    throw new InvalidCommand("future_command");
  if (now - createdAt * 1000 >= ttlMs)
    throw new ExpiredCommand("expired_command");
  let url: string | undefined;
  if (name === "play") {
    const options = data.options.filter(
      (value): value is Record<string, unknown> =>
        !!value && typeof value === "object" && !Array.isArray(value),
    );
    const urls = options.filter((option) => option.name === "url");
    if (
      urls.length !== 1 ||
      urls[0]!.type !== 3 ||
      typeof urls[0]!.value !== "string" ||
      !urls[0]!.value.length ||
      urls[0]!.value.length > 2048
    )
      throw new InvalidCommand("invalid_url_option");
    url = urls[0]!.value;
  }
  return {
    id: data.interaction_id as string,
    guildId: data.guild_id as string,
    userId: data.user_id as string,
    channelId: data.channel_id as string,
    name,
    createdAt,
    url,
  };
}
