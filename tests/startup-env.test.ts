import { afterEach, expect, it, vi } from "vitest";

const keys = [
  "DISCORD_TOKEN",
  "DISCORD_APPLICATION_ID",
  "DISCORD_GUILD_ID",
  "SQS_QUEUE_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "ECS_CLUSTER",
  "ECS_SERVICE",
  "ECS_STOP_ON_FATAL",
  "VOICEVOX_URL",
  "VOICEVOX_SPEAKER",
  "VOICEVOX_SPEED",
  "VOICEVOX_VOLUME",
  "TTS_MODE",
  "VOICEVOX_EXECUTABLE",
  "VOICEVOX_ARGS",
  "TTS_IDLE_MS",
  "TTS_START_TIMEOUT_MS",
  "AUTO_LEAVE",
  "AUTO_LEAVE_MS",
  "READY_SOUND_PATH",
  "DICTIONARY_PATH",
  "COMMAND_TTL_MS",
  "BOT_IDLE_MS",
  "AUTO_STOP_ENABLED",
  "AUTO_STOP_COORDINATED",
];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("loads the ECS configuration with only the reported three variables", async () => {
  for (const key of keys) vi.stubEnv(key, undefined);
  vi.stubEnv("DISCORD_TOKEN", "diagnostic-placeholder");
  vi.stubEnv(
    "SQS_QUEUE_URL",
    "https://sqs.ap-northeast-1.amazonaws.com/161063896786/discord-commands.fifo",
  );
  vi.stubEnv("AWS_DEFAULT_REGION", "ap-northeast-1");
  vi.resetModules();
  const { config } = await import("../src/config.js");
  expect(Boolean(config.token)).toBe(true);
  expect(config.sqsQueueUrl).toBeTruthy();
  expect(config.awsRegion).toBe("ap-northeast-1");
  expect(config.applicationId).toBe("");
  expect(config.guildId).toBe("");
  expect(config.ecsCluster).toBe("");
  expect(config.ecsService).toBe("");
  expect(config.autoStop).toBe(false);
  expect(config.mode).toBe("external");
  expect(config.ttsUrl).toBe("http://127.0.0.1:50021");
});

it.each([
  ["COMMAND_TTL_MS", ""],
  ["VOICEVOX_SPEED", "invalid"],
  ["TTS_MODE", "invalid"],
  ["VOICEVOX_ARGS", "invalid-json"],
  ["VOICEVOX_ARGS", "{}"],
])(
  "rejects malformed optional settings when explicitly provided: %s",
  async (key, value) => {
    for (const name of keys) vi.stubEnv(name, undefined);
    vi.stubEnv(key, value);
    vi.resetModules();
    await expect(import("../src/config.js")).rejects.toThrow();
  },
);
