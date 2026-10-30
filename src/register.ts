import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "./config.js";
if (!config.token || !config.applicationId)
  throw new Error("DISCORD_TOKEN と DISCORD_APPLICATION_ID を設定してください");
const body = [
  ...[
    ["pause", "動画を一時停止します（読み上げは継続）"],
    ["resume", "動画の再生を再開します"],
    ["skip", "現在の動画をスキップします"],
    ["list", "再生中・再生待ちの動画を表示します"],
    ["help", "コマンドの使い方を表示します"],
  ].map(([name, description]) =>
    new SlashCommandBuilder().setName(name!).setDescription(description!),
  ),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("YouTube動画の音声を再生待ちに追加します")
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("YouTube動画のURL")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("ぽぽんをVCに呼び、チャットを読み上げます"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("ぽぽんがVCから退出します"),
].map((c) => c.toJSON());
const route = config.guildId
  ? Routes.applicationGuildCommands(config.applicationId, config.guildId)
  : Routes.applicationCommands(config.applicationId);
await new REST({ version: "10" }).setToken(config.token).put(route, { body });
console.log("ぽぽんのコマンドを登録しました");
