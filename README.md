# ぽぽん（popon-discord-bot）

DiscordのVCに付属するテキストチャットを「表示名 発話内容」で読み上げるBotです。無料のローカルVOICEVOX Engineを使い、有料API・DB・LLMは使いません。

## 仕様

- `/join` を実行した人の通常VCに接続。VC接続とVOICEVOX準備を並列実行します。
- 選択話者でのウォームアップ合成が成功し、VC接続も完了したら、`assets/sounds/meet_style.wav` を一度再生します。投稿が待機中でもこの準備完了音を再生します。投稿時の効果音はありません。
- その後、サーバー内表示名（ニックネーム優先）と本文を読み上げます。例：`きし やあ`。
- 効果音はユーザー提供の原本そのまま（1.6秒）。`READY_SOUND_PATH` で交換できます。
- 1ギルド1VC。ギルドごとにFIFOで待機20件、本文200文字、URL解析3件。起動中も投稿を保持し、順次合成・再生します。満杯の場合は再投稿を案内します。
- Bot投稿・直近1000件の重複IDを無視。読み上げ失敗はログに記録して次へ進みます。再起動をまたぐ永続保存はありません。
- `/leave` は同じVCの利用者が実行でき、再生と待機キューを破棄します。人がゼロになった場合も既定60秒で退出します。
- プロセス管理モードでは、全ギルド退出後10分でVOICEVOXを停止。猶予中の再joinは再利用します。

## Macで開始

Node.js 22.12以上（24系推奨）とFFmpegが必要です。npmは11.21.1で依存更新を検証しています。採用版は discord.js 14.27.0 / @discordjs/voice 0.19.2。DAVE対応ライブラリは後者の依存に含まれ、lockfileに固定しています。開発ブランチのドキュメントと公開リリースではNode要件が異なるため、公開版の `engines` を基準にしています。

```bash
npm ci
# 初回のみ。入力済みの .env は上書きしません。
cp -n .env.example .env
npm run check
npm run build
```

`.env` の認証情報を設定してから：

```bash
npm run register
npm run dev
```

ビルドした版は `npm start`。`.env` はGit対象外です。トークンをチャットやログへ貼らないでください。

### Discord側の設定

1. [Developer Portal](https://discord.com/developers/applications)でアプリを作成し、Bot名を「ぽぽん」に設定します。
2. Botページでトークンを発行し、`.env` の `DISCORD_TOKEN` に保存します。Application IDを `DISCORD_APPLICATION_ID` に設定します。
3. 左メニューの **Bot** を開き、**Privileged Gateway Intents** の **Message Content Intent** をONにします。変更後は **Save Changes** を押してください。ぽぽんが要求する特権Intentはこれだけです。Server Members IntentとPresence Intentは不要です。
4. OAuth2招待では `bot` と `applications.commands` を選択。権限は View Channels / Send Messages / Connect / Speak。管理者権限は不要です。VC付属チャットの閲覧・送信権限も確認します。
5. 開発中はサーバーIDを `DISCORD_GUILD_ID` に指定し、`npm run register` でそのサーバーへコマンド登録します。空ならグローバル登録です。このアプリのコマンド一覧を置換します。
6. 通常のVCへ参加し `/join` → 準備完了音 → VC付属チャットに「やあ」→「あなたの表示名 やあ」→ `/leave` を確認します。

使用Gateway Intentsは Guilds / GuildVoiceStates / GuildMessages / MessageContent。ステージチャンネルはMVP対象外です。

`npm run register` はコマンドを登録して終了する操作です。Botをオンラインにするには、続けて `npm run dev`（`nr` を利用している場合は `nr dev`）を実行し、ターミナルを開いたままにしてください。ログに `"event":"bot_ready"` が出ればDiscordへの接続成功です。VOICEVOXの準備は `/join` 時に行うため、この時点でVOICEVOXが未起動でもBot自体はオンラインになります。

### VOICEVOXをDockerで動かす（サーバーと揃える場合の推奨）

ローカルは **VOICEVOXをDocker、BotをMacのNode.js** で動かします。サーバー用 `compose.yaml` とローカル用 `compose.local.yaml` は、同じ `compose.voicevox.yaml` を共有します。公式CPU版 **VOICEVOX 0.26.0 / Ubuntu 24.04** のマルチアーキテクチャmanifestをdigestで固定しているため、`latest` の更新で環境がずれることはありません。

Intel MacはLinux AMD64、Apple SiliconとOCI Ampere A1はLinux ARM64のイメージを自動選択します。Engineの版とコンテナ内OSを揃えますが、CPU・メモリ・Docker仮想化の違いがあるため、速度や完全な実行環境の一致は保証しません。Intel MacでARM64を強制するエミュレーションは通常の開発では使いません。

1. Docker Desktopを起動します。次の両方が成功することを確認してください。`docker version` はClientだけでなくServer情報も必要です。

   ```bash
   docker version
   docker compose version
   ```

   `Cannot connect to the Docker daemon` の場合はDocker Desktopの起動完了を待ちます。イメージ取得自体が `unsupported manifest media type` で失敗する場合はDocker Desktopを更新してください。このMacではCLI 20.10.14 / Compose 2.5.1でも、Docker Desktop起動後のコンテナ取得・起動・API合成は成功しました（`docker manifest inspect` 単独では形式エラーが出るため、起動可否と区別します）。

2. プロジェクトフォルダでVOICEVOXを起動します。初回は大きなイメージのダウンロードに時間がかかります。この手順は `.env` を読み込みません。

   ```bash
   cd /Users/kishinoriki/develop/apps/popon
   docker compose --env-file /dev/null -p popon-local -f compose.local.yaml pull
   docker compose --env-file /dev/null -p popon-local -f compose.local.yaml up -d
   docker compose --env-file /dev/null -p popon-local -f compose.local.yaml ps
   curl --fail http://127.0.0.1:50021/version
   ```

   `ps` のVOICEVOXが `healthy`、`/version` が `"0.26.0"` を返すことを確認します。起動直後にcurlが失敗した場合は少し待って再実行してください。ログ確認：

   ```bash
   docker compose --env-file /dev/null -p popon-local -f compose.local.yaml logs --tail=100 voicevox
   ```

3. Botを起動します。次の環境変数をコマンドで上書きするため、既存の `.env` を編集する必要はありません。**Bot自身は認証情報を使うため `.env` を読み込みます**。Docker側にはトークンを渡しません。

   ```bash
   TTS_MODE=external VOICEVOX_URL=http://127.0.0.1:50021 npm run dev
   ```

   `nr` 利用時は末尾を `nr dev` に置き換えられます。`bot_ready` を確認し、Discordで `/join` → 準備完了音 → VCチャットに「やあ」→「表示名 やあ」を確認します。HTTPのhealthyだけで発話準備完了とはせず、Botがjoin時にウォームアップ合成します。

4. 終了時はBotのターミナルでCtrl+C、VOICEVOXは次で停止・コンテナ削除します（ダウンロード済みイメージは残ります）。

   ```bash
   docker compose --env-file /dev/null -p popon-local -f compose.local.yaml down
   ```

この構成は `external` モードなので、`/leave` 後の10分自動停止は行いません。停止状態からの `/join` によるコンテナ自動起動も未実装です。Engineの動作確認とオンデマンド起動の確認は別です。MacのVOICEVOXアプリなどが50021を使用している場合は、先にそちらを終了してください。APIは `127.0.0.1` にだけ公開します。

### Dockerを使わない場合

**最初の確認（external）**：公式VOICEVOXアプリまたはEngineを別途起動し、`http://127.0.0.1:50021/version` が応答する状態にします。`.env` は `TTS_MODE=external` のままです。このモードではBotはEngineを起動・停止しません。READY判定用の合成は行います。

**オンデマンド起動（process）**：[公式Engineリリース](https://github.com/VOICEVOX/voicevox_engine/releases)からMacのCPUアーキテクチャに合うEngineを展開し、次を設定します。

```dotenv
TTS_MODE=process
VOICEVOX_EXECUTABLE=/絶対パス/VOICEVOX_ENGINE/run
VOICEVOX_ARGS=["--host","127.0.0.1","--port","50021"]
```

実行ファイルの位置は配布物に合わせて変更してください。Botはシェルを使わず、設定された実行ファイルだけを子プロセスとして起動・停止します。同じポートで別のVOICEVOXを動かさないでください。

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

URLはHTTP(S)・標準ポートのみ。全DNS応答の公開IP判定、解決IPへの接続固定、実接続先照合、リダイレクトごとの再検証、3秒・1MBの上限を適用します。画像は画像通知、取得できないURLはリンク通知に置換します。OGサイト名と既知ドメイン辞書を使い、不明タイトルを区切り文字だけで推測しません。

[今回の検証記録](docs/validation.md)に実施済み・未検証の範囲を記載しています。

## テスト・実機測定

```bash
npm run check
npm run build
```

自動テストは表示名、添付、文字数、SSRF、サイト名、FIFO、重複・上限、キャンセル、TTS共有起動・停止・再join・起動失敗回復を検証します。実際のDiscord・VOICEVOX性能は別途確認が必要です。

ログはJSONで、投稿本文やトークンを出力しません。

- `tts_ready.durationMs`：Engine起動からウォームアップ合成成功まで。
- `join_ready.durationMs`：VC接続開始から準備完了音終了まで。
- `speech_started.postToSpeechMs`：Discord投稿時刻からAudioPlayerのPlayingまで。実際の受聴時刻との差はネットワーク・Discord側遅延です。
- `synthesis.durationMs` / `playback.durationMs`：合成 / 再生所要時間。

停止状態から `/join` →「やあ」投稿 → 実際の受聴をストップウォッチで測り、入力時間込み10秒を目標にします。READY後の投稿は2秒を努力目標とします。起動中投稿、連続投稿、退出途中、再join、人がゼロ、接続切断も確認してください。コールド起動が遅い場合は停止猶予延長・事前起動を先に検討し、その後軽量エンジンを比較します。

## トラブルシュート

### 起動時に `Used disallowed intents` が出る

Discordが要求された特権Intentを許可していない場合のエラーです。ぽぽんでは **Message Content Intent** が該当します。

1. [Developer Portal](https://discord.com/developers/applications)で、実行するBotのアプリを選択します。
2. **Bot → Privileged Gateway Intents → Message Content Intent** をONにします。
3. **Save Changes** を押し、`npm run dev`（または `nr dev`）で再起動します。
4. `"event":"bot_ready"` が表示されることを確認します。

この対処のために `.env` の変更、トークンの再発行、Botの再招待、コマンドの再登録は必要ありません。設定済みでも続く場合は、トークンを発行したアプリと設定変更したアプリが同じかをPortal上で確認してください。Discordから特権Intentの審査を求められているアプリは、許可状況も確認してください。

根拠：[Discord公式のPrivileged Intents案内](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx)。コードで要求した特権Intentが未設定・未承認の場合、Gateway接続は4014で閉じられます。

### その他の症状

- コマンドが見えない：アプリID・サーバーID・招待スコープを確認し再登録。
- 投稿を拾わない：Message Content Intent、VC付属チャットか、閲覧権限を確認。
- 音が出ない：Connect/Speak権限、サーバーミュート、FFmpeg、UDP通信を確認。
- 準備失敗：VOICEVOXの起動・ポート・話者ID・実行パスを確認。`/speakers` で使用可能な話者を確認して再join。
- 合成失敗：該当投稿をスキップします。Engine障害が続く場合は退出し、Engineを復旧して再join。
- 効果音失敗：ログに残して本文読み上げは続行します。WAVパスを確認。
- Docker起動失敗：Docker Desktop/daemonとComposeプラグインを確認。

## デプロイ・クレジット

[運用手順](docs/operations.md)にCompose、OCI、systemd、復旧とバックアップの手順を記載しています。実際のクラウド構築や課金操作は行っていません。

音声合成：**VOICEVOX:ずんだもん**（既定話者）。Botプロフィールやサーバーの案内にも表記してください。話者を変更したら実際の話者にクレジットを合わせます。

[VOICEVOX利用規約](https://voicevox.hiroshiba.jp/term/)・[Q&A](https://voicevox.hiroshiba.jp/qa/)・[キャラクター利用規約](https://zunko.jp/con_ongen_kiyaku.html)を確認して使用してください。Engineのソフトウェアライセンスと音声・キャラクターの利用条件はそれぞれ適用されます。
