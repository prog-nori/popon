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
import { commandName, type CommandContext } from "./commands.js";
import { SQSClient } from "@aws-sdk/client-sqs";
import { CommandConsumer } from "./sqs.js";
import { createSqsDispatcher } from "./sqs-dispatch.js";
import { IdleStopper } from "./idle.js";
import { serviceScaler, queueAppearsEmpty } from "./aws-service.js";
import { announceReady } from "./readiness.js";
import { AudioOutput } from "./audio.js";
import { mediaLink } from "./media/list.js";
import { MediaQueue } from "./media/queue.js";
import { YoutubeAdapter, youtubeURL } from "./media/youtube.js";
import { SpeechQueue } from "./queue.js";
import { speechText } from "./text.js";
import { VoicevoxProvider, TTSLifecycleManager, ProcessEngine } from "./tts.js";
import { log, errorText } from "./log.js";
import { loginOrShutdown } from "./startup.js";
if (!config.token) throw new Error("DISCORD_TOKEN が環境変数に設定されていません");
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
    : { start: () => provider.checkAvailability(), async stop() {} },
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
  media: MediaQueue;
  controller: AbortController;
  ready: boolean;
  idle?: ReturnType<typeof setTimeout>;
}
const sessions = new Map<string, Session>();
function leave(guildId: string): void {
  const session = sessions.get(guildId);
  if (!session) return;
  sessions.delete(guildId);
  clearTimeout(session.idle);
  // One failed cleanup must never prevent disconnecting or releasing TTS.
  for (const cleanup of [
    () => session.controller.abort(),
    () => session.queue.close(),
    () => session.media.close(),
    () => session.audio.stop(),
    () => {
      if (session.connection.state.status !== VoiceConnectionStatus.Destroyed)
        session.connection.destroy();
    },
    () => lifecycle.release(guildId),
  ]) {
    try {
      cleanup();
    } catch (error) {
      log("session_cleanup_error", { guildId, error: errorText(error) });
    }
  }
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
const preparations = new Set<Promise<void>>();
let activeCommands = 0;
let stopping = false;
let shutdownTask: Promise<void> | undefined;
let consumer: CommandConsumer | undefined;
let idle: IdleStopper | undefined;

function trackPreparation(task: Promise<void>): void {
  preparations.add(task);
  void task
    .catch((error) => log("join_background_error", { error: errorText(error) }))
    .finally(() => preparations.delete(task));
}

export async function executeCommand(command: CommandContext): Promise<void> {
  if (stopping) throw new Error("bot_stopping");
  activeCommands++;
  idle?.touch();
  // Notification failures must not roll back a successful music operation.
  const reply: CommandContext["reply"] = async (message) => {
    try {
      return await command.reply(message);
    } catch {
      log("command_notification_failed", { guildId: command.guildId });
    }
  };
  try {
    if (command.name === "help") {
      await reply({
        embeds: [
          {
            title: "ぽぽんのコマンド",
            description: [
              "/join: VCに参加してメッセージ読み上げを開始します。",
              "/leave: VCから退出し、すべての再生と待ちリストを終了します。",
              "/play <url>: YouTube動画を追加し、順番に音声を再生します。",
              "/pause: 動画を一時停止します（読み上げは続きます）。",
              "/resume: 一時停止した動画を再開します。",
              "/skip: 現在の動画を放棄し、次の動画へ進みます。",
              "/stop: 音楽と再生待ちを停止します（読み上げは継続）。",
              "/queue: /list と同じ再生リストを表示します。",
              "/list: 再生中の動画と再生待ちを最大20件表示します。",
              "/help: この使い方を表示します。",
            ].join("\n"),
            footer: {
              text: "動画操作は /join 完了後、ぽぽんと同じVCから実行してください。",
            },
          },
        ],
      });
      return;
    }
    const channel = command.voiceChannel;
    const current = sessions.get(command.guildId);
    if (
      ["play", "pause", "resume", "skip", "list", "stop"].includes(command.name)
    ) {
      if (!current || channel?.id !== current.channelId) {
        await reply("/join 後、ぽぽんと同じVCから実行してください。");
        return;
      }
      if (!current.ready) {
        await reply(
          "まだVC・VOICEVOXの準備中です。/join の準備完了通知後に /play を実行してください。",
        );
        return;
      }
      if (command.name === "stop") {
        await reply(
          current.media.stop()
            ? "音楽と再生待ちを停止しました。読み上げは継続します。"
            : "停止する音楽はありません。",
        );
        return;
      }
      if (command.name === "list") {
        const state = await current.media.list();
        await reply({
          embeds: [
            {
              title: state.paused ? "動画リスト（一時停止中）" : "動画リスト",
              description: [
                state.current
                  ? `再生中・取得中: ${mediaLink(state.current)}`
                  : "再生中の動画はありません。",
                ...state.waiting.map(
                  (item, i) => `${i + 1}. ${mediaLink(item)}`,
                ),
                ...(state.waiting.length ? [] : ["再生待ちはありません。"]),
              ].join("\n"),
            },
          ],
        });
        return;
      }
      if (command.name === "pause") {
        await reply(
          current.media.pause()
            ? "動画を一時停止しました。読み上げは継続します。"
            : "再生中の動画がないか、すでに一時停止中です。",
        );
        return;
      }
      if (command.name === "resume") {
        await reply(
          current.media.resume()
            ? "動画の再生を再開しました。"
            : "一時停止中の動画はありません。",
        );
        return;
      }
      if (command.name === "skip") {
        await reply(
          current.media.skip()
            ? "現在の動画をスキップしました。後続の動画があれば再生します。"
            : "スキップできる動画はありません。",
        );
        return;
      }
      try {
        const url = youtubeURL(command.url ?? "");
        const position = current.media.push(url, async (content) => {
          if (channel?.isTextBased())
            await channel.send({ content, allowedMentions: { parse: [] } });
        });
        await reply(
          `動画を受け付けました（待ち順 ${position}）。再生時に対応可否を確認します。`,
        );
      } catch (error) {
        await reply(errorText(error));
      }
      return;
    }
    if (command.name === "leave") {
      if (current && channel?.id !== current.channelId) {
        await reply("ぽぽんと同じVCから実行してください。");
        return;
      }
      leave(command.guildId);
      await reply("退出しました。");
      return;
    }
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      await reply("通常のボイスチャンネルに参加してから呼んでください。");
      return;
    }
    if (current) {
      await reply(
        current.channelId === channel.id
          ? "このVCで準備中、または読み上げ中です。"
          : "別のVCで使用中です。先に /leave してください。",
      );
      return;
    }
    const began = performance.now();
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: command.guildId,
      adapterCreator: command.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    let audio: AudioOutput;
    try {
      audio = new AudioOutput(connection, (error) => {
        log("audio_output_error", { error: errorText(error) });
        if (sessions.get(command.guildId)?.audio === audio)
          leave(command.guildId);
      });
    } catch (error) {
      connection.destroy();
      log("join_error", { phase: "audio_init", error: errorText(error) });
      await reply(
        "準備できませんでした。音声出力の初期化に失敗したため退出しました。依存ライブラリとログを確認してください。",
      );
      return;
    }
    const media = new MediaQueue(
      new YoutubeAdapter(),
      (stream, signal, onStart) => audio.playMedia(stream, signal, onStart),
      (paused) => audio.mixer.setMediaPaused(paused),
    );
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
          guildId: command.guildId,
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
      media,
      controller,
      ready: false,
    };
    sessions.set(command.guildId, session);
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (sessions.get(command.guildId) === session) leave(command.guildId);
    });
    connection.on("error", (e) => {
      log("connection_error", { error: errorText(e) });
      if (sessions.get(command.guildId) === session) leave(command.guildId);
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
          if (sessions.get(command.guildId) === session) leave(command.guildId);
        }
      })();
    });
    const prepare = async () => {
      try {
        await reply("ぽぽんを準備しています。投稿は準備中も受け付けます。");
        controller.signal.throwIfAborted();
        await announceReady(
          [
            entersState(
              connection,
              VoiceConnectionStatus.Ready,
              AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
            ).catch((error) => {
              throw new Error(
                "VC接続に失敗しました。接続権限・ネットワーク・ログを確認してください。",
                { cause: error },
              );
            }),
            lifecycle.acquire(command.guildId),
          ],
          controller.signal,
          () => audio.play(config.sound, controller.signal),
          (e) => log("ready_sound_error", { error: errorText(e) }),
          () => {
            session.ready = true;
            queue.start();
            media.start();
          },
        );
        checkEmpty(command.guildId);
        log("join_ready", {
          guildId: command.guildId,
          durationMs: Math.round(performance.now() - began),
        });
        await reply("準備できました。「表示名 発話内容」の順で読み上げます。");
      } catch (e) {
        if (
          sessions.get(command.guildId) !== session ||
          controller.signal.aborted
        ) {
          log("join_cancelled", { guildId: command.guildId });
          await reply("参加準備を中止しました（退出・接続終了）。");
          return;
        }
        leave(command.guildId);
        log("join_error", { guildId: command.guildId, error: errorText(e) });
        await reply(
          `準備できませんでした。VCから退出しました。${errorText(e)} /join を再実行してください。`,
        );
      }
    };
    if (command.backgroundJoin) trackPreparation(prepare());
    else await prepare();
  } finally {
    activeCommands--;
    idle?.touch();
  }
}

client.on("interactionCreate", (interaction) => {
  void (async () => {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild())
      return;
    const name = commandName(interaction.commandName);
    if (!name) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await executeCommand({
      name,
      guildId: interaction.guildId,
      guild: interaction.guild,
      voiceChannel: interaction.member.voice.channel,
      url:
        name === "play"
          ? interaction.options.getString("url", true)
          : undefined,
      reply: (message) => interaction.editReply(message),
    });
  })().catch((error) => log("interaction_error", { error: errorText(error) }));
});
client.on("messageCreate", (message) => {
  if (message.author.bot || !message.guildId) return;
  const session = sessions.get(message.guildId);
  if (!session || session.channelId !== message.channelId) return;
  idle?.touch();
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
client.once("clientReady", () => {
  log("bot_ready", { name: "ぽぽん" });
  if (!config.sqsQueueUrl || stopping) return;
  const sqs = new SQSClient({ region: config.awsRegion, maxAttempts: 2 });
  idle = new IdleStopper({
    enabled: config.autoStop,
    coordinated: config.stopCoordinated,
    idleMs: config.botIdleMs,
    busy: () =>
      activeCommands > 0 ||
      preparations.size > 0 ||
      !!consumer?.isProcessing ||
      [...sessions.values()].some(
        (session) =>
          !session.ready || session.media.isBusy || session.queue.isBusy,
      ),
    queueEmpty: () => queueAppearsEmpty(sqs, config.sqsQueueUrl),
    scale: serviceScaler(
      config.awsRegion,
      config.ecsCluster,
      config.ecsService,
    ),
    // Do not await shutdown from the receive loop: shutdown waits for that loop.
    stopped: () => {
      void shutdown().catch(() => log("shutdown_error"));
    },
  });
  consumer = new CommandConsumer(sqs, {
    queueUrl: config.sqsQueueUrl,
    ttlMs: config.commandTtlMs,
    handle: createSqsDispatcher(client, executeCommand),
    activity: () => idle?.touch(),
    onEmpty: () => idle!.check(),
  });
  void consumer.start().catch(() => log("command_consumer_stopped"));
});
client.on("error", (e) => log("client_error", { error: errorText(e) }));
const health = createServer((_req, res) => {
  res.writeHead(client.isReady() ? 200 : 503);
  res.end(client.isReady() ? "ready" : "starting");
}).listen(3000, "0.0.0.0");
function shutdown(): Promise<void> {
  if (shutdownTask) return shutdownTask;
  stopping = true;
  idle?.close();
  // Abort sessions before waiting for the consumer/preparations to finish.
  for (const id of sessions.keys()) leave(id);
  client.destroy();
  health.close();
  shutdownTask = (async () => {
    await consumer?.stop();
    await Promise.allSettled([...preparations]);
    await lifecycle.stop();
  })();
  return shutdownTask;
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
