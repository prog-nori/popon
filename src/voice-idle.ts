import type { Client } from "discord.js";
import { log } from "./log.js";

export type Occupancy = "empty" | "occupied" | "unknown";

/** Missing member/self voice state is unknown, never proof of an empty VC. */
export function voiceOccupancy(
  client: Client,
  guildId: string,
  channelId: string,
  requireBot = true,
): Occupancy {
  if (!client.isReady() || !client.user) return "unknown";
  const guild = client.guilds.cache.get(guildId);
  const channel = client.channels.cache.get(channelId);
  if (
    !guild?.available ||
    !channel?.isVoiceBased() ||
    (requireBot &&
      guild.voiceStates.cache.get(client.user.id)?.channelId !== channelId)
  )
    return "unknown";
  for (const state of guild.voiceStates.cache.values()) {
    if (state.channelId !== channelId) continue;
    if (typeof state.member?.user?.bot !== "boolean") return "unknown";
    if (!state.member.user.bot) return "occupied";
  }
  return "empty";
}

export class EmptyVoiceTimer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private options: {
      idleMs: number;
      observe: (guildId: string) => Occupancy;
      expired: (guildId: string) => void;
    },
  ) {}
  cancel(guildId: string, cause: string): void {
    const timer = this.timers.get(guildId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(guildId);
    log("auto_stop_cancelled", { reason: "voice_empty", guildId, cause });
  }
  clear(cause: string): void {
    for (const guildId of this.timers.keys()) this.cancel(guildId, cause);
  }
  update(guildId: string): void {
    const state = this.options.observe(guildId);
    if (state !== "empty") {
      this.cancel(
        guildId,
        state === "occupied" ? "human_returned" : "voice_state_unknown",
      );
      return;
    }
    if (this.timers.has(guildId)) return;
    const timer = setTimeout(() => {
      if (this.timers.get(guildId) !== timer) return;
      this.timers.delete(guildId);
      const empty = this.options.observe(guildId) === "empty";
      log("auto_stop_condition_checked", {
        reason: "voice_empty",
        guildId,
        safe: empty,
        phase: "timer",
      });
      if (empty) this.options.expired(guildId);
      else
        log("auto_stop_cancelled", {
          reason: "voice_empty",
          guildId,
          cause: "voice_state_changed",
        });
    }, this.options.idleMs);
    this.timers.set(guildId, timer);
    log("auto_stop_timer_started", {
      reason: "voice_empty",
      guildId,
      idleMs: this.options.idleMs,
    });
  }
}
