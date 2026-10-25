import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  ChannelType,
} from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import { config } from "./config.js";
import { announceReady } from "./readiness.js";
import { AudioOutput } from "./audio.js";
import { SpeechQueue } from "./queue.js";
import { speechText } from "./text.js";
import { VoicevoxProvider, TTSLifecycleManager, ProcessEngine } from "./tts.js";
import { log, errorText } from "./log.js";
import { loginOrShutdown } from "./startup.js";
if (!config.token) throw new Error("DISCORD_TOKEN を .env に設定してください");
const dictionary = JSON.parse(
  await readFile(config.dictionary, "utf8"),
) as Record<string, string>;
if (Object.values(dictionary).some((value) => typeof value !== "string"))
  throw new Error("辞書の値は文字列で指定してください");
const provider = new VoicevoxProvider(
  config.ttsUrl,
  config.speaker,
  config.speed,
  config.volume,
);
const lifecycle = new TTSLifecycleManager(
  provider,
  config.mode === "process"
    ? new ProcessEngine(config.executable, config.args)
    : { async start() {}, async stop() {} },
  config.idleMs,
  config.startMs,
);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
interface Session {
  channelId: string;
  connection: VoiceConnection;
  audio: AudioOutput;
  queue: SpeechQueue;
  controller: AbortController;
  idle?: ReturnType<typeof setTimeout>;
}
const sessions = new Map<string, Session>();
function leave(guildId: string): void {
  const session = sessions.get(guildId);
  if (!session) return;
  sessions.delete(guildId);
  clearTimeout(session.idle);
  session.controller.abort();
  session.queue.close();
  session.audio.stop();
  if (session.connection.state.status !== VoiceConnectionStatus.Destroyed)
    session.connection.destroy();
  lifecycle.release(guildId);
  log("vc_left", { guildId });
}
function checkEmpty(guildId: string): void {
  const session = sessions.get(guildId);
  if (!session || !config.autoLeave) return;
  const channel = client.channels.cache.get(session.channelId);
  if (!channel || !channel.isVoiceBased()) return;
  const empty = channel.members.filter((m) => !m.user.bot).size === 0;
  if (!empty) {
    clearTimeout(session.idle);
    session.idle = undefined;
  } else if (!session.idle)
    session.idle = setTimeout(() => leave(guildId), config.autoLeaveMs);
}
client.on("interactionCreate", (interaction) => {
  void (async () => {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild())
      return;
    if (!["join", "leave"].includes(interaction.commandName)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.member.voice.channel;
    const current = sessions.get(interaction.guildId);
    if (interaction.commandName === "leave") {
      if (current && channel?.id !== current.channelId) {
        await interaction.editReply("ぽぽんと同じVCから実行してください。");
        return;
      }
      leave(interaction.guildId);
      await interaction.editReply("退出しました。");
      return;
    }
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      await interaction.editReply(
        "通常のボイスチャンネルに参加してから呼んでください。",
      );
      return;
    }
    if (current) {
      await interaction.editReply(
        current.channelId === channel.id
          ? "このVCで準備中、または読み上げ中です。"
          : "別のVCで使用中です。先に /leave してください。",
      );
      return;
    }
    await interaction.editReply(
      "ぽぽんを準備しています。投稿は準備中も受け付けます。",
    );
    const began = performance.now();
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    const audio = new AudioOutput(connection);
    const controller = new AbortController();
    const queue = new SpeechQueue(async (job, signal) => {
      const text = await speechText(
        job.name,
        job.content,
        job.attachments,
        dictionary,
        signal,
      );
      if (!text) return;
      signal.throwIfAborted();
      const wav = await provider.synthesize(text, signal);
      signal.throwIfAborted();
      const start = performance.now();
      await audio.play(wav, signal, () =>
        log("speech_started", {
          guildId: interaction.guildId,
          messageId: job.id,
          postToSpeechMs: Date.now() - job.receivedAt,
        }),
      );
      log("playback", { durationMs: Math.round(performance.now() - start) });
    });
    const session: Session = {
      channelId: channel.id,
      connection,
      audio,
      queue,
      controller,
    };
    sessions.set(interaction.guildId, session);
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (sessions.get(interaction.guildId) === session)
        leave(interaction.guildId);
    });
    connection.on("error", (e) => {
      log("connection_error", { error: errorText(e) });
      if (sessions.get(interaction.guildId) === session)
        leave(interaction.guildId);
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void (async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
          await entersState(connection, VoiceConnectionStatus.Ready, 20000);
        } catch {
          if (sessions.get(interaction.guildId) === session)
            leave(interaction.guildId);
        }
      })();
    });
    try {
      await announceReady(
        [
          entersState(connection, VoiceConnectionStatus.Ready, 30000),
          lifecycle.acquire(interaction.guildId),
        ],
        controller.signal,
        () => audio.play(config.sound, controller.signal),
        (e) => log("ready_sound_error", { error: errorText(e) }),
        () => queue.start(),
      );
      checkEmpty(interaction.guildId);
      log("join_ready", {
        guildId: interaction.guildId,
        durationMs: Math.round(performance.now() - began),
      });
      await interaction.editReply(
        "準備できました。「表示名 発話内容」の順で読み上げます。",
      );
    } catch (e) {
      if (sessions.get(interaction.guildId) === session)
        leave(interaction.guildId);
      log("join_error", { error: errorText(e) });
      await interaction.editReply(
        "準備できませんでした。設定・VOICEVOXを確認して /join を再実行してください。",
      );
    }
  })().catch((e) => log("interaction_error", { error: errorText(e) }));
});
client.on("messageCreate", (message) => {
  if (message.author.bot || !message.guildId) return;
  const session = sessions.get(message.guildId);
  if (!session || session.channelId !== message.channelId) return;
  const result = session.queue.push({
    id: message.id,
    name:
      message.member?.displayName ??
      message.author.globalName ??
      message.author.username,
    content: message.cleanContent.slice(0, 4000),
    attachments: [...message.attachments.values()].map(
      (a) => a.contentType ?? "",
    ),
    receivedAt: message.createdTimestamp,
  });
  if (result === "full")
    void message
      .reply({
        content:
          "読み上げ待ちが20件に達しています。少し待って再投稿してください。",
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch((e) => log("notification_error", { error: errorText(e) }));
});
client.on("voiceStateUpdate", (_old, state) => checkEmpty(state.guild.id));
client.once("clientReady", () => log("bot_ready", { name: "ぽぽん" }));
client.on("error", (e) => log("client_error", { error: errorText(e) }));
const health = createServer((_req, res) => {
  res.writeHead(client.isReady() ? 200 : 503);
  res.end(client.isReady() ? "ready" : "starting");
}).listen(3000, "0.0.0.0");
async function shutdown() {
  for (const id of sessions.keys()) leave(id);
  client.destroy();
  health.close();
  await lifecycle.stop();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void shutdown().catch((e) => {
      log("shutdown_error", { error: errorText(e) });
      process.exitCode = 1;
    });
  });
const loggedIn = await loginOrShutdown(
  () => client.login(config.token),
  shutdown,
  (message) => log("startup_error", { message }),
);
if (!loggedIn) process.exitCode = 1;
