# 設定ガイド

[README](../README.md) · [利用ガイド](usage.md) · [ローカルでの動作確認](local-development.md)

## Discordアプリ

1. [Developer Portal](https://discord.com/developers/applications)でアプリを作成します。
2. Botトークンを `.env` の `DISCORD_TOKEN`、Application IDを `DISCORD_APPLICATION_ID` に設定します。
3. **Bot → Privileged Gateway Intents → Message Content Intent** を有効にして保存します。Server Members IntentとPresence Intentは不要です。
4. OAuth2の `bot` と `applications.commands` スコープで招待します。権限は View Channels / Send Messages / Connect / Speak を設定し、VC付属チャットも閲覧・送信できるようにします。
5. テスト先のサーバーIDを `DISCORD_GUILD_ID` に設定し、`npm run register` を実行します。空の場合はグローバル登録です。

登録は指定したスコープのアプリのコマンド一覧を置換します。Botの起動とは別の操作です。複数サーバーへの登録方法は[ローカル手順](local-development.md#コマンド登録)を参照してください。

## 環境変数

|名前|既定値 / 用途|
|---|---|
|DISCORD_TOKEN|Botトークン、必須|
|DISCORD_APPLICATION_ID|コマンド登録用アプリID|
|DISCORD_GUILD_ID|開発用サーバーID、空でグローバル|
|VOICEVOX_URL|`http://127.0.0.1:50021`、公開しない|
|VOICEVOX_SPEAKER|`3`（ずんだもん・ノーマル）|
|VOICEVOX_SPEED / VOICEVOX_VOLUME|`1.0` / `1.0`|
|TTS_MODE|`external` または `process`|
|VOICEVOX_EXECUTABLE / VOICEVOX_ARGS|実行ファイルの絶対パス / 引数JSON配列|
|TTS_IDLE_MS|`600000`、全ギルド退出後の停止猶予|
|TTS_START_TIMEOUT_MS|`180000`、ウォームアップ期限|
|AUTO_LEAVE / AUTO_LEAVE_MS|`true` / `60000`|
|READY_SOUND_PATH|`assets/sounds/meet_style.wav`|
|DICTIONARY_PATH|`assets/dictionary.json`、文字列から読みへの辞書|
|FFMPEG_PATH|FFmpegの実行ファイル。空ならPATHから検索|
|YT_DLP_PATH|yt-dlpの実行ファイル。空なら専用環境、PATHの順に検索|

`.env` はGit管理対象外です。トークンをログやチャットに貼らないでください。

## VOICEVOXの起動方式

- `external`：別途起動したEngineへ接続します。BotはEngineの起動・停止を行いません。
- `process`：設定したEngineを子プロセスとして起動します。全サーバーの退出後、既定10分で停止します。猶予中の再参加では再利用します。

`process` を使う場合は[公式Engineリリース](https://github.com/VOICEVOX/voicevox_engine/releases)から環境に合う配布物を展開し、実行ファイルの位置に合わせて設定します。

```dotenv
TTS_MODE=process
VOICEVOX_EXECUTABLE=/path/to/VOICEVOX_ENGINE/run
VOICEVOX_ARGS=["--host","127.0.0.1","--port","50021"]
```

引数はJSON配列で指定し、シェルとしては解釈しません。同じポートで別のEngineを起動しないでください。

## FFmpeg・yt-dlp

FFmpegは読み上げにも必要です。PATHへ配置するか `FFMPEG_PATH` に実行ファイルを指定します。

動画取得の依存関係は、Python 3.10以上を用意してリポジトリのルートで導入します。

```bash
npm run setup:media
```

`.tools/media` の専用仮想環境を作り直し、yt-dlpとEJSを導入します。Botは `YT_DLP_PATH` → 専用環境 → PATH の順でyt-dlpを検索します。既に対応版を導入している場合はこの操作を省略できます。

YouTube取得には実行中BotのNode.jsを使い、yt-dlpの外部設定ファイルやCookieは読み込みません。[yt-dlpの依存関係](https://github.com/yt-dlp/yt-dlp#dependencies)と[EJS手順](https://github.com/yt-dlp/yt-dlp/wiki/EJS)も参照してください。

Dockerでは検証したyt-dlpの版をビルド引数で固定できます。

```bash
docker build --build-arg 'YT_DLP_SPEC=yt-dlp[default]==<検証したバージョン>' .
```
