import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "./config.js";
if (!config.token || !config.applicationId)
  throw new Error("DISCORD_TOKEN と DISCORD_APPLICATION_ID を設定してください");
const body = [
  new SlashCommandBuilder()
    .setName("add")
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
