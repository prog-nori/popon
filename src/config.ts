function number(name: string, fallback: number, min = 0): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min)
    throw new Error(`${name} の値が不正です`);
  return value;
}
export const config = {
  token: process.env.DISCORD_TOKEN ?? "",
  applicationId: process.env.DISCORD_APPLICATION_ID ?? "",
  guildId: process.env.DISCORD_GUILD_ID ?? "",
  ttsUrl: process.env.VOICEVOX_URL ?? "http://127.0.0.1:50021",
  speaker: number("VOICEVOX_SPEAKER", 3),
  speed: number("VOICEVOX_SPEED", 1, 0.1),
  volume: number("VOICEVOX_VOLUME", 1),
  mode: process.env.TTS_MODE ?? "external",
  executable: process.env.VOICEVOX_EXECUTABLE ?? "",
  args: JSON.parse(process.env.VOICEVOX_ARGS ?? "[]") as string[],
  idleMs: number("TTS_IDLE_MS", 600000),
  startMs: number("TTS_START_TIMEOUT_MS", 180000, 1),
  autoLeave: process.env.AUTO_LEAVE !== "false",
  autoLeaveMs: number("AUTO_LEAVE_MS", 60000),
  sound: process.env.READY_SOUND_PATH ?? "assets/sounds/meet_style.wav",
  dictionary: process.env.DICTIONARY_PATH ?? "assets/dictionary.json",
};
if (!["external", "process"].includes(config.mode))
  throw new Error("TTS_MODE は external または process を指定してください");
if (
  !Array.isArray(config.args) ||
  config.args.some((x) => typeof x !== "string")
)
  throw new Error("VOICEVOX_ARGS は文字列のJSON配列です");
