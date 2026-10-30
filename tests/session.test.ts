import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  events: new Map<string, (...args: unknown[]) => void>(),
  audioConstruct: vi.fn(),
  audioStop: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  connection: undefined as unknown,
}));
vi.mock("discord.js", () => ({
  Client: class {
    channels = { cache: new Map() };
    on(name: string, fn: (...args: unknown[]) => void) {
      state.events.set(name, fn);
    }
    once() {}
    login() {
      return Promise.resolve("token");
    }
    destroy() {}
    isReady() {
      return true;
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
  joinVoiceChannel: () => state.connection,
  entersState: () => Promise.resolve(),
}));
vi.mock("../src/config.js", () => ({
  config: {
    token: "fake",
    dictionary: "assets/dictionary.json",
    sound: "sound",
    mode: "external",
  },
}));
vi.mock("../src/audio.js", () => ({
  AudioOutput: class {
    constructor() {
      state.audioConstruct();
    }
    play() {
      return Promise.resolve();
    }
    stop() {
      state.audioStop();
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
  state.audioStop.mockReset();
  state.events.get("interactionCreate")?.(interaction("leave"));
  await tick();
  for (const [name, previous] of oldListeners)
    for (const listener of process.listeners(name))
      if (!previous.includes(listener)) process.removeListener(name, listener);
});
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
  const add = interaction("add");
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
