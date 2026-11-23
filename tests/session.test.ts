import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { Client } from "discord.js";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandConsumer } from "../src/sqs.js";
import { createSqsDispatcher } from "../src/sqs-dispatch.js";
import { log } from "../src/log.js";
const state = vi.hoisted(() => ({
  events: new Map<string, (...args: unknown[]) => void>(),
  audioConstruct: vi.fn(),
  audioStop: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  connection: undefined as unknown,
  joinVoice: vi.fn(),
  enterState: vi.fn(),
  playMedia: vi.fn(),
  sqsSend: vi.fn(),
  ecsSend: vi.fn(),
  ready: true,
  guilds: new Map<string, unknown>(),
  channels: new Map<string, unknown>(),
  destination: undefined as unknown,
  config: {
    token: "fake",
    dictionary: "assets/dictionary.json",
    sound: "sound",
    mode: "external",
    sqsQueueUrl: "",
    commandTtlMs: 300000,
    autoStop: false,
    autoStopIdleMs: 60000,
    awsRegion: "ap-northeast-1",
    ecsCluster: "discord-bot-cluster",
    ecsService: "discord-bot-service",
    autoLeave: false,
    autoLeaveMs: 60000,
    ecsCluster: "discord-bot-cluster",
    ecsService: "discord-bot-service",
  },
}));
vi.mock("@aws-sdk/client-ecs", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-ecs")>()),
  ECSClient: class {
    send = state.ecsSend;
  },
}));
vi.mock("@aws-sdk/client-sqs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-sqs")>()),
  SQSClient: class {
    send = state.sqsSend;
  },
}));
vi.mock("discord.js", () => ({
  Client: class {
    channels = { cache: state.channels, fetch: async () => state.destination };
    guilds = { cache: state.guilds };
    user = { id: "bot" };
    on(name: string, fn: (...args: unknown[]) => void) {
      state.events.set(name, fn);
    }
    once(name: string, fn: (...args: unknown[]) => void) {
      state.events.set(name, fn);
    }
    login() {
      return Promise.resolve("token");
    }
    destroy() {}
    isReady() {
      return state.ready;
    }
  },
  GatewayIntentBits: {},
  MessageFlags: { Ephemeral: 64 },
  ChannelType: { GuildVoice: 2 },
}));
vi.mock("@discordjs/voice", () => ({
  VoiceConnectionStatus: {
    Ready: "ready",
    Destroyed: "destroyed",
    Disconnected: "disconnected",
  },
  joinVoiceChannel: (...args: unknown[]) => {
    state.joinVoice(...args);
    return state.connection;
  },
  entersState: (...args: unknown[]) => state.enterState(...args),
}));
vi.mock("../src/config.js", () => ({
  config: state.config,
}));
vi.mock("../src/audio.js", () => ({
  AudioOutput: class {
    mixer = { setMediaPaused() {} };
    constructor() {
      state.audioConstruct();
    }
    play() {
      return Promise.resolve();
    }
    stop() {
      state.audioStop();
    }
    async playMedia(stream: unknown, signal: unknown, onStart?: () => void) {
      state.playMedia(stream, signal);
      onStart?.();
    }
  },
}));
vi.mock("../src/tts.js", () => ({
  VoicevoxProvider: class {},
  ProcessEngine: class {},
  TTSLifecycleManager: class {
    acquire() {
      return state.acquire();
    }
    release() {
      state.release();
    }
    stop() {
      return Promise.resolve();
    }
  },
}));
vi.mock("node:http", () => ({
  createServer: () => ({
    listen() {
      return this;
    },
    close() {},
  }),
}));
vi.mock("../src/log.js", () => ({
  log: vi.fn(),
  errorText: (error: unknown) => String(error),
}));
let connection: EventEmitter & {
  state: { status: string };
  destroy: ReturnType<typeof vi.fn>;
};
let oldListeners: Map<NodeJS.Signals, ReturnType<typeof process.listeners>>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function interaction(commandName: string) {
  return {
    commandName,
    guildId: "guild",
    guild: { voiceAdapterCreator: {} },
    member: { voice: { channel: { id: "vc", type: 2 } } },
    isChatInputCommand: () => true,
    inCachedGuild: () => true,
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    options: { getString: () => "https://youtu.be/abcdefghijk" },
  };
}
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.events.clear();
  state.guilds.clear();
  state.channels.clear();
  state.config.autoStop = false;
  state.config.autoLeave = false;
  state.ready = true;
  state.config.sqsQueueUrl = "";
  state.joinVoice.mockReset();
  state.enterState.mockReset().mockResolvedValue(undefined);
  state.playMedia.mockReset();
  state.sqsSend.mockReset();
  state.ecsSend.mockReset().mockResolvedValue({});
  state.audioConstruct.mockReset();
  state.audioStop.mockReset();
  state.acquire.mockReset();
  state.acquire.mockResolvedValue(undefined);
  connection = Object.assign(new EventEmitter(), {
    state: { status: "ready" },
    destroy: vi.fn(() => {
      connection.state.status = "destroyed";
      connection.emit("destroyed");
    }),
  });
  state.connection = connection;
  oldListeners = new Map(
    (["SIGINT", "SIGTERM"] as NodeJS.Signals[]).map((name) => [
      name,
      process.listeners(name),
    ]),
  );
  await import("../src/index.js");
});
afterEach(async () => {
  vi.useRealTimers();
  state.audioStop.mockReset();
  state.events.get("interactionCreate")?.(interaction("leave"));
  await tick();
  // Also stop the real receive loop and numeric-guild sessions used below.
  for (const listener of process.listeners("SIGTERM"))
    if (!oldListeners.get("SIGTERM")!.includes(listener)) listener();
  await tick();
  for (const [name, previous] of oldListeners)
    for (const listener of process.listeners(name))
      if (!previous.includes(listener)) process.removeListener(name, listener);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function queuedFixture() {
  const send = vi.fn(async () => {});
  const voiceStates = new Map<
    string,
    {
      channel: { id: string; type: number };
      channelId?: string;
      member?: { user: { bot: boolean } };
    }
  >([
    [
      "789",
      {
        channel: { id: "vc", type: 2 },
        channelId: "vc",
        member: { user: { bot: false } },
      },
    ],
    [
      "bot",
      {
        channel: { id: "vc", type: 2 },
        channelId: "vc",
        member: { user: { bot: true } },
      },
    ],
  ]);
  state.channels.set("vc", { isVoiceBased: () => true });
  state.guilds.set("456", {
    id: "456",
    available: true,
    voiceAdapterCreator: {},
    voiceStates: { cache: voiceStates },
  });
  state.destination = { guildId: "456", isSendable: () => true, send };
  const message = (id: string, command = "join") => ({
    Body: JSON.stringify({
      interaction_id: id,
      guild_id: "456",
      user_id: "789",
      channel_id: "101",
      command,
      options:
        command === "play"
          ? [{ name: "url", type: 3, value: "https://youtu.be/abcdefghijk" }]
          : [],
      created_at: Math.floor(Date.now() / 1000),
    }),
    ReceiptHandle: `receipt-${id}`,
    Attributes: { MessageGroupId: "456" },
  });
  return { send, voiceStates, message };
}

async function queuedConsumer() {
  const { executeCommand } = await import("../src/index.js");
  const send = vi.fn(async () => ({}));
  const consumer = new CommandConsumer({ send } as unknown as SQSClient, {
    queueUrl: "queue-url",
    ttlMs: 300000,
    handle: createSqsDispatcher(
      {
        isReady: () => true,
        guilds: { cache: state.guilds },
        channels: { fetch: async () => state.destination },
      } as unknown as Client,
      executeCommand,
    ),
  });
  const { MediaQueue } = await import("../src/media/queue.js");
  return { consumer, send, MediaQueue };
}

it.each([false, true])(
  "auto-joins for SQS play and waits for preparation (preceding join=%s)",
  async (precedingJoin) => {
    const f = queuedFixture();
    const { consumer, send, MediaQueue } = await queuedConsumer();
    const push = vi.spyOn(MediaQueue.prototype, "push").mockReturnValue(1);
    let ready!: () => void;
    state.acquire.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    if (precedingJoin) await consumer.process(f.message("120", "join"));
    send.mockClear();
    const pending = consumer.process(f.message("123", "play"));
    await vi.waitFor(() => expect(state.acquire).toHaveBeenCalledOnce());
    expect(push).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    ready();
    await pending;
    expect(push).toHaveBeenCalledExactlyOnceWith(
      "https://www.youtube.com/watch?v=abcdefghijk",
      expect.any(Function),
    );
    expect(send.mock.lastCall?.[0]).toBeInstanceOf(DeleteMessageCommand);
    await consumer.process(f.message("123", "play"));
    expect(push).toHaveBeenCalledOnce();
    expect(state.joinVoice).toHaveBeenCalledOnce();
    await consumer.stop();
  },
);

it("auto-joins and starts the existing MediaQueue playback after readiness", async () => {
  const f = queuedFixture();
  const { consumer } = await queuedConsumer();
  const { YoutubeAdapter } = await import("../src/media/youtube.js");
  const open = vi.spyOn(YoutubeAdapter.prototype, "open").mockResolvedValue({
    stream: Readable.from([Buffer.alloc(3840)]),
    done: Promise.resolve(),
    stop() {},
  });
  await consumer.process(f.message("123", "play"));
  await vi.waitFor(() => expect(state.playMedia).toHaveBeenCalledOnce());
  expect(open).toHaveBeenCalledWith(
    "https://www.youtube.com/watch?v=abcdefghijk",
    expect.any(AbortSignal),
  );
  expect(log).toHaveBeenCalledWith("media_started", expect.any(Object));
  expect(f.send).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining("動画を受け付けました"),
    }),
  );
  await consumer.stop();
});

it("does not join or queue SQS play when the user has no voice state", async () => {
  const f = queuedFixture();
  f.voiceStates.clear();
  const { consumer, MediaQueue } = await queuedConsumer();
  const push = vi.spyOn(MediaQueue.prototype, "push");
  await consumer.process(f.message("123", "play"));
  expect(state.joinVoice).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining("ボイスチャンネルに参加して"),
    }),
  );
  await consumer.stop();
});

it.each(["connect", "readiness", "voicevox"])(
  "does not play after a %s failure",
  async (stage) => {
    const f = queuedFixture();
    const { consumer, MediaQueue } = await queuedConsumer();
    const push = vi.spyOn(MediaQueue.prototype, "push");
    if (stage === "connect")
      state.joinVoice.mockImplementation(() => {
        throw new Error("connect failed");
      });
    else if (stage === "readiness")
      state.enterState.mockRejectedValue(new Error("voice timed out"));
    else state.acquire.mockRejectedValue(new Error("voicevox unavailable"));
    await consumer.process(f.message("123", "play"));
    expect(push).not.toHaveBeenCalled();
    expect(state.playMedia).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/できませんでした/),
      }),
    );
    await consumer.stop();
  },
);

it("reuses an existing session and refuses to move it to another VC for play", async () => {
  const f = queuedFixture();
  const { consumer, MediaQueue } = await queuedConsumer();
  const push = vi.spyOn(MediaQueue.prototype, "push").mockReturnValue(1);
  await consumer.process(f.message("120", "join"));
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith("join_ready", expect.any(Object)),
  );
  f.voiceStates.set("789", { channel: { id: "another-vc", type: 2 } });
  await consumer.process(f.message("123", "play"));
  expect(state.joinVoice).toHaveBeenCalledOnce();
  expect(push).not.toHaveBeenCalled();
  await consumer.stop();
});

it("rechecks the user's voice state after play's connection preparation", async () => {
  const f = queuedFixture();
  const { consumer, MediaQueue } = await queuedConsumer();
  const push = vi.spyOn(MediaQueue.prototype, "push");
  let ready!: () => void;
  state.acquire.mockReturnValue(
    new Promise<void>((resolve) => {
      ready = resolve;
    }),
  );
  const pending = consumer.process(f.message("123", "play"));
  await vi.waitFor(() => expect(state.acquire).toHaveBeenCalledOnce());
  f.voiceStates.clear();
  ready();
  await pending;
  expect(push).not.toHaveBeenCalled();
  await consumer.stop();
});

it("expires a play that used up its TTL while waiting for preparation", async () => {
  const f = queuedFixture();
  const { consumer, MediaQueue } = await queuedConsumer();
  const push = vi.spyOn(MediaQueue.prototype, "push");
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let ready!: () => void;
  state.acquire.mockReturnValue(
    new Promise<void>((resolve) => {
      ready = resolve;
    }),
  );
  const pending = consumer.process(f.message("123", "play"));
  await vi.waitFor(() => expect(state.acquire).toHaveBeenCalledOnce());
  now += 300000;
  ready();
  await pending;
  expect(push).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining("有効期限が切れました"),
    }),
  );
  await consumer.stop();
});

it("preserves successive play order without reconnecting and ignores a duplicate play", async () => {
  const f = queuedFixture();
  const { consumer, MediaQueue } = await queuedConsumer();
  const push = vi.spyOn(MediaQueue.prototype, "push").mockReturnValue(1);
  await consumer.process(f.message("123", "play"));
  const second = f.message("124", "play");
  const data = JSON.parse(second.Body);
  data.options[0].value = "https://youtu.be/lmnopqrstuv";
  second.Body = JSON.stringify(data);
  await consumer.process(second);
  await consumer.process(second);
  expect(push.mock.calls.map(([url]) => url)).toEqual([
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/watch?v=lmnopqrstuv",
  ]);
  expect(state.joinVoice).toHaveBeenCalledOnce();
  await consumer.stop();
});

it("does not connect for an invalid SQS play URL", async () => {
  const f = queuedFixture();
  const { consumer, MediaQueue } = await queuedConsumer();
  const push = vi.spyOn(MediaQueue.prototype, "push");
  const message = f.message("123", "play");
  const data = JSON.parse(message.Body);
  data.options[0].value = "https://example.com/not-youtube";
  message.Body = JSON.stringify(data);
  await consumer.process(message);
  expect(state.joinVoice).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  await consumer.stop();
});

it("does not resurrect playback when the preparing VC connection is destroyed", async () => {
  const f = queuedFixture();
  const { consumer, MediaQueue } = await queuedConsumer();
  const push = vi.spyOn(MediaQueue.prototype, "push");
  let ready!: () => void;
  state.acquire.mockReturnValue(
    new Promise<void>((resolve) => {
      ready = resolve;
    }),
  );
  const pending = consumer.process(f.message("123", "play"));
  await vi.waitFor(() => expect(state.acquire).toHaveBeenCalledOnce());
  connection.destroy();
  await pending;
  ready();
  await tick();
  expect(push).not.toHaveBeenCalled();
  expect(state.joinVoice).toHaveBeenCalledOnce();
  await consumer.stop();
});

it("starts SQS only after clientReady, then joins the user's VC without a Gateway interaction", async () => {
  const f = queuedFixture();
  state.config.sqsQueueUrl = "https://sqs.example/commands.fifo";
  let delivered = false;
  state.sqsSend.mockImplementation(async (command, options) => {
    if (command instanceof DeleteMessageCommand) return {};
    expect(command).toBeInstanceOf(ReceiveMessageCommand);
    if (!delivered) {
      delivered = true;
      return { Messages: [f.message("123")] };
    }
    return new Promise((_, reject) => {
      options.abortSignal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
  });
  await tick();
  expect(state.sqsSend).not.toHaveBeenCalled();
  state.events.get("clientReady")!();
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith("join_ready", expect.any(Object)),
  );
  expect(state.joinVoice).toHaveBeenCalledWith(
    expect.objectContaining({ guildId: "456", channelId: "vc" }),
  );
  expect(
    state.sqsSend.mock.calls.some(
      ([command]) => command instanceof DeleteMessageCommand,
    ),
  ).toBe(true);
  expect(f.send).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining("準備できました"),
    }),
  );
});

it("runs join/play/skip/leave through the FIFO consumer and never repeats a duplicate play", async () => {
  const f = queuedFixture();
  const { executeCommand } = await import("../src/index.js");
  const { MediaQueue } = await import("../src/media/queue.js");
  const push = vi.spyOn(MediaQueue.prototype, "push").mockReturnValue(1);
  const skip = vi.spyOn(MediaQueue.prototype, "skip").mockReturnValue(true);
  const send = vi.fn(async () => ({}));
  const consumer = new CommandConsumer({ send } as unknown as SQSClient, {
    queueUrl: "queue-url",
    ttlMs: 300000,
    handle: createSqsDispatcher(
      {
        isReady: () => true,
        guilds: { cache: state.guilds },
        channels: { fetch: async () => state.destination },
      } as unknown as Client,
      executeCommand,
    ),
  });
  try {
    await consumer.process(f.message("123"));
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith("join_ready", expect.any(Object)),
    );
    await consumer.process(f.message("124", "play"));
    await consumer.process(f.message("124", "play"));
    expect(push).toHaveBeenCalledExactlyOnceWith(
      "https://www.youtube.com/watch?v=abcdefghijk",
      expect.any(Function),
    );
    await consumer.process(f.message("125", "skip"));
    expect(skip).toHaveBeenCalledOnce();
    await consumer.process(f.message("126", "leave"));
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(5);
  } finally {
    await consumer.stop();
    push.mockRestore();
    skip.mockRestore();
  }
});

it("records a user leaving VC before the queued join executes", async () => {
  const f = queuedFixture();
  f.voiceStates.clear();
  const { executeCommand } = await import("../src/index.js");
  await createSqsDispatcher(
    {
      isReady: () => true,
      guilds: { cache: state.guilds },
      channels: { fetch: async () => state.destination },
    } as unknown as Client,
    executeCommand,
  )({
    id: "123",
    guildId: "456",
    userId: "789",
    channelId: "101",
    name: "join",
    createdAt: Math.floor(Date.now() / 1000),
  });
  expect(state.joinVoice).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("join_rejected", {
    guildId: "456",
    reason: "user_not_in_supported_voice_channel",
  });
});

it("reports a synchronous voice connection failure without repeatedly creating sessions", async () => {
  state.joinVoice.mockImplementation(() => {
    throw new Error("sensitive upstream details");
  });
  const join = interaction("join");
  state.events.get("interactionCreate")!(join);
  await tick();
  expect(log).toHaveBeenCalledWith("join_error", {
    guildId: "guild",
    phase: "voice_connect",
  });
  expect(join.editReply).toHaveBeenCalledWith(
    expect.stringContaining("VCに参加できませんでした"),
  );
  expect(state.audioConstruct).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(
    "sensitive upstream details",
  );
});
it.each(["false", "true"])(
  "initializes the Bot with PO enabled=%s (Discord login mocked)",
  async (enabled) => {
    vi.stubEnv("YOUTUBE_POT_ENABLED", enabled);
    vi.resetModules();
    await import("../src/index.js");
    expect(log).toHaveBeenCalledWith("youtube_pot_mode", {
      enabled: enabled === "true",
    });
    expect(state.events.has("interactionCreate")).toBe(true);
  },
);
it("rolls back the VC when audio initialization fails", async () => {
  state.audioConstruct.mockImplementation(() => {
    throw new Error("encoder unavailable");
  });
  const join = interaction("join");
  state.events.get("interactionCreate")!(join);
  await tick();
  expect(connection.destroy).toHaveBeenCalledOnce();
  expect(join.editReply).toHaveBeenLastCalledWith(
    expect.stringContaining("準備できませんでした"),
  );
});
it("disconnects even when stopping the audio output throws", async () => {
  state.acquire.mockRejectedValue(new Error("VOICEVOX unavailable"));
  state.audioStop.mockImplementation(() => {
    throw new Error("encoder cleanup");
  });
  const join = interaction("join");
  state.events.get("interactionCreate")!(join);
  await tick();
  expect(connection.destroy).toHaveBeenCalledOnce();
  expect(state.release).toHaveBeenCalledOnce();
  expect(join.editReply).toHaveBeenLastCalledWith(
    expect.stringContaining("準備できませんでした"),
  );
});
it("does not create two sessions for concurrent joins", async () => {
  state.events.get("interactionCreate")!(interaction("join"));
  state.events.get("interactionCreate")!(interaction("join"));
  await tick();
  expect(state.audioConstruct).toHaveBeenCalledOnce();
});
it("rejects media while TTS initialization is pending", async () => {
  state.acquire.mockReturnValue(new Promise(() => {}));
  state.events.get("interactionCreate")!(interaction("join"));
  await tick();
  const add = interaction("play");
  state.events.get("interactionCreate")!(add);
  await tick();
  expect(add.editReply).toHaveBeenLastCalledWith(
    expect.stringContaining("準備中"),
  );
});

it("cancels an old join promptly after leave and never reports a late failure", async () => {
  let fail!: (error: Error) => void;
  state.acquire.mockReturnValue(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );
  const join = interaction("join");
  state.events.get("interactionCreate")!(join);
  await tick();
  state.events.get("interactionCreate")!(interaction("leave"));
  await tick();
  expect(join.editReply).toHaveBeenLastCalledWith(
    expect.stringContaining("中止"),
  );
  state.acquire.mockResolvedValue(undefined);
  const newer = interaction("join");
  state.events.get("interactionCreate")!(newer);
  await tick();
  fail(new Error("old timeout"));
  await tick();
  expect(join.editReply).toHaveBeenLastCalledWith(
    expect.stringContaining("中止"),
  );
  expect(newer.editReply).toHaveBeenLastCalledWith(
    expect.stringContaining("準備できました"),
  );
  expect(connection.destroy).toHaveBeenCalledOnce();
});

it("does not reacquire TTS when leaving before the preparing reply completes", async () => {
  let finish!: () => void;
  const join = interaction("join");
  join.editReply.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  state.events.get("interactionCreate")!(join);
  await tick();
  state.events.get("interactionCreate")!(interaction("leave"));
  await tick();
  finish();
  await tick();
  expect(state.acquire).not.toHaveBeenCalled();
  expect(join.editReply).toHaveBeenLastCalledWith(
    expect.stringContaining("中止"),
  );
});

it("shows Japanese embed help without joining a voice channel", async () => {
  const help = interaction("help");
  state.events.get("interactionCreate")!(help);
  await tick();
  expect(help.editReply).toHaveBeenCalledWith({
    embeds: [
      expect.objectContaining({
        description: expect.stringContaining("/play <url>:"),
      }),
    ],
  });
  expect(state.audioConstruct).not.toHaveBeenCalled();
});

it.each(["play", "pause", "resume", "skip", "list"])(
  "requires a joined session for /%s",
  async (name) => {
    const command = interaction(name);
    state.events.get("interactionCreate")!(command);
    await tick();
    expect(command.editReply).toHaveBeenCalledWith(
      expect.stringContaining("同じVC"),
    );
  },
);

it("joins from SQS without waiting for TTS and accepts leave while preparation is pending", async () => {
  state.acquire.mockReturnValue(new Promise(() => {}));
  const send = vi.fn(async () => {});
  const guild = {
    id: "guild",
    available: true,
    voiceAdapterCreator: {},
    voiceStates: {
      cache: new Map([["user", { channel: { id: "vc", type: 2 } }]]),
    },
  };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([["guild", guild]]) },
    channels: {
      fetch: async () => ({ guildId: "guild", isSendable: () => true, send }),
    },
  } as unknown as Client;
  const { executeCommand } = await import("../src/index.js");
  const dispatch = createSqsDispatcher(client, executeCommand);
  const command = {
    id: "id",
    guildId: "guild",
    userId: "user",
    channelId: "text-channel",
    name: "join" as const,
    createdAt: Date.now() / 1000,
  };
  await dispatch(command);
  await tick();
  expect(state.audioConstruct).toHaveBeenCalledOnce();
  expect(state.acquire).toHaveBeenCalledWith();
  await dispatch({ ...command, id: "leave-id", name: "leave" });
  await tick();
  expect(connection.destroy).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringContaining("退出") }),
  );
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringContaining("中止") }),
  );
});

/** Drive real consumer receive/delete callbacks without contacting SQS. */
function stoppingDriver(f: ReturnType<typeof queuedFixture>) {
  const waiting: ((value: {
    Messages: ReturnType<typeof f.message>[];
  }) => void)[] = [];
  const deleted = vi.fn(async () => ({}));
  const attributes = vi.fn(async () => ({
    Attributes: {
      ApproximateNumberOfMessages: "0",
      ApproximateNumberOfMessagesNotVisible: "0",
      ApproximateNumberOfMessagesDelayed: "0",
    },
  }));
  state.sqsSend.mockImplementation(async (command, options) => {
    if (command instanceof DeleteMessageCommand) return deleted();
    if (command instanceof GetQueueAttributesCommand) return attributes();
    expect(command).toBeInstanceOf(ReceiveMessageCommand);
    return new Promise((resolve, reject) => {
      const signal = options.abortSignal as AbortSignal;
      const abort = () => reject(new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      waiting.push((response) => {
        signal.removeEventListener("abort", abort);
        resolve(response);
      });
    });
  });
  state.events.get("clientReady")!();
  return {
    deleted,
    attributes,
    async poll(messages: ReturnType<typeof f.message>[] = []) {
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      waiting.shift()!({ Messages: messages });
      await tick();
    },
  };
}

it.each([false, true])(
  "closes /leave normally and only requests ECS stop when enabled=%s",
  async (enabled) => {
    const f = queuedFixture();
    state.config.autoStop = enabled;
    state.config.sqsQueueUrl = "queue-url";
    const d = stoppingDriver(f);
    await d.poll([f.message("120", "join")]);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith("join_ready", expect.any(Object)),
    );
    const order: string[] = [];
    state.audioStop.mockImplementation(() => {
      order.push("audio-stop");
    });
    f.send.mockImplementation(async (message?: unknown) => {
      if ((message as { content?: string })?.content === "退出しました。")
        order.push("notification");
    });
    let finishDelete!: () => void;
    d.deleted.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDelete = () => {
            order.push("delete-complete");
            resolve({});
          };
        }),
    );
    state.ecsSend.mockImplementation(async () => {
      order.push("ecs-stop");
      return {};
    });
    await d.poll([f.message("121", "leave")]);
    expect(state.audioStop).toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(state.ecsSend).not.toHaveBeenCalled();
    finishDelete();
    await d.poll();
    if (enabled) {
      await vi.waitFor(() => expect(state.ecsSend).toHaveBeenCalledOnce());
      expect(order).toEqual([
        "audio-stop",
        "notification",
        "delete-complete",
        "ecs-stop",
      ]);
      expect(state.ecsSend.mock.calls[0]?.[0]).toMatchObject({
        input: { desiredCount: 0 },
      });
    } else expect(state.ecsSend).not.toHaveBeenCalled();
  },
);

it("does not stop after /leave if the queue contains a new startup request", async () => {
  const f = queuedFixture();
  state.config.autoStop = true;
  state.config.sqsQueueUrl = "queue-url";
  const d = stoppingDriver(f);
  await d.poll([f.message("120", "join")]);
  await d.poll([f.message("121", "leave")]);
  d.attributes.mockResolvedValueOnce({
    Attributes: {
      ApproximateNumberOfMessages: "1",
      ApproximateNumberOfMessagesNotVisible: "0",
      ApproximateNumberOfMessagesDelayed: "0",
    },
  });
  await d.poll();
  expect(state.ecsSend).not.toHaveBeenCalled();
  await d.poll([f.message("122", "join")]);
  await d.poll();
  expect(state.ecsSend).not.toHaveBeenCalled();
});

it("does not stop another Guild's active VC session", async () => {
  const f = queuedFixture();
  state.config.autoStop = true;
  state.config.sqsQueueUrl = "queue-url";
  const d = stoppingDriver(f);
  await d.poll([f.message("120", "join")]);
  const other = Object.assign(new EventEmitter(), {
    state: { status: "ready" },
    destroy: vi.fn(),
  });
  state.connection = other;
  state.events.get("interactionCreate")!(interaction("join"));
  await tick();
  await d.poll([f.message("121", "leave")]);
  await d.poll();
  expect(state.ecsSend).not.toHaveBeenCalled();
  expect(other.destroy).not.toHaveBeenCalled();
});

it("does not request stop if the /leave notification failed", async () => {
  const f = queuedFixture();
  state.config.autoStop = true;
  state.config.sqsQueueUrl = "queue-url";
  const d = stoppingDriver(f);
  await d.poll([f.message("120", "join")]);
  f.send.mockRejectedValue(new Error("permission denied"));
  await d.poll([f.message("121", "leave")]);
  await d.poll();
  expect(state.ecsSend).not.toHaveBeenCalled();
});

it("keeps the Bot alive on an ECS permissions error without a stop retry loop", async () => {
  const f = queuedFixture();
  state.config.autoStop = true;
  state.config.sqsQueueUrl = "queue-url";
  const d = stoppingDriver(f);
  await d.poll([f.message("120", "join")]);
  await d.poll([f.message("121", "leave")]);
  state.ecsSend.mockRejectedValue(
    Object.assign(new Error("do not log this"), {
      name: "AccessDeniedException",
    }),
  );
  await d.poll();
  await d.poll();
  expect(state.ecsSend).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith("auto_stop_failed", {
    reason: "leave",
    guildId: "456",
  });
  expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(
    "do not log this",
  );
});

it("leaves after sixty empty seconds and then requests service stop on an empty poll", async () => {
  const f = queuedFixture();
  state.config.autoStop = true;
  state.config.sqsQueueUrl = "queue-url";
  const d = stoppingDriver(f);
  await d.poll([f.message("120", "join")]);
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith("join_ready", expect.any(Object)),
  );
  vi.useFakeTimers();
  f.voiceStates.delete("789");
  state.events.get("voiceStateUpdate")!(null, { guild: { id: "456" } });
  await vi.advanceTimersByTimeAsync(59999);
  expect(connection.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(connection.destroy).toHaveBeenCalledOnce();
  expect(state.ecsSend).not.toHaveBeenCalled();
  vi.useRealTimers();
  await d.poll();
  expect(state.ecsSend).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith("auto_stop_requested", {
    reason: "voice_empty",
    guildId: "456",
  });
});

it.each(["human_returned", "gateway_disconnected", "voice_reconnecting"])(
  "does not leave or stop an uncertain VC: %s",
  async (cause) => {
    const f = queuedFixture();
    state.config.autoStop = true;
    state.config.sqsQueueUrl = "queue-url";
    const d = stoppingDriver(f);
    await d.poll([f.message("120", "join")]);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith("join_ready", expect.any(Object)),
    );
    const human = f.voiceStates.get("789")!;
    vi.useFakeTimers();
    f.voiceStates.delete("789");
    state.events.get("voiceStateUpdate")!(null, { guild: { id: "456" } });
    await vi.advanceTimersByTimeAsync(30000);
    if (cause === "human_returned") {
      f.voiceStates.set("789", human);
      state.events.get("voiceStateUpdate")!(null, { guild: { id: "456" } });
    } else if (cause === "gateway_disconnected") {
      state.ready = false;
      state.events.get("shardDisconnect")!();
    } else connection.state.status = "connecting";
    await vi.advanceTimersByTimeAsync(60000);
    expect(connection.destroy).not.toHaveBeenCalled();
    vi.useRealTimers();
    await d.poll();
    expect(state.ecsSend).not.toHaveBeenCalled();
  },
);

it("preserves legacy AUTO_LEAVE without stopping ECS when AUTO_STOP is off", async () => {
  const f = queuedFixture();
  state.config.autoLeave = true;
  state.config.autoStop = false;
  state.config.sqsQueueUrl = "queue-url";
  const members = new Map([
    ["human", { user: { bot: false } }],
    ["bot", { user: { bot: true } }],
  ]);
  state.channels.set("vc", {
    isVoiceBased: () => true,
    members: {
      filter: (predicate: (member: { user: { bot: boolean } }) => boolean) =>
        new Map([...members].filter(([, member]) => predicate(member))),
    },
  });
  const d = stoppingDriver(f);
  await d.poll([f.message("120", "join")]);
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith("join_ready", expect.any(Object)),
  );
  vi.useFakeTimers();
  members.delete("human");
  state.events.get("voiceStateUpdate")!(null, { guild: { id: "456" } });
  await vi.advanceTimersByTimeAsync(60000);
  expect(connection.destroy).toHaveBeenCalledOnce();
  vi.useRealTimers();
  await d.poll();
  expect(state.ecsSend).not.toHaveBeenCalled();
});

it("starts a full new sixty-second observation after a voice reconnection", async () => {
  const f = queuedFixture();
  state.config.autoStop = true;
  state.config.sqsQueueUrl = "queue-url";
  const d = stoppingDriver(f);
  await d.poll([f.message("120", "join")]);
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith("join_ready", expect.any(Object)),
  );
  vi.useFakeTimers();
  f.voiceStates.delete("789");
  state.events.get("voiceStateUpdate")!(null, { guild: { id: "456" } });
  await vi.advanceTimersByTimeAsync(30000);
  connection.state.status = "disconnected";
  connection.emit("disconnected");
  await vi.advanceTimersByTimeAsync(0);
  connection.state.status = "ready";
  connection.emit("ready");
  await vi.advanceTimersByTimeAsync(59999);
  expect(connection.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(connection.destroy).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
