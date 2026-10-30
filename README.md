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

## 動画音声と読み上げのミックス

`/join` の「準備できました」通知後、ぽぽんと同じVCから `/add url:https://www.youtube.com/watch?v=...`
で動画音声を追加できます。コマンド追加後は `npm run register` を実行してください。
映像は送信せず、通常の読み上げと動画音声を一つのストリームへ混ぜます。
動画を使わない場合も既存の辞書・整形・読み上げ順序を維持します。

初期版の判断は次のとおりです。

- 通常の公開動画、1本2時間以内。ライブ（終了済みライブを含む）、プレイリスト全体の追加、認証が必要な動画は対象外です。動画IDがあるURLに付いた `list` / `index` / `start_radio` などは取り除き、その動画1本だけを追加します。
- サーバー別に再生中1件＋待ち20件。取得は先頭から行い、取得・デコードだけでなく出力末尾の送信位置を待って次へ進みます。DB・永続化はありません。
- 同じVCの利用者が追加できます。`/skip`、`/queue`、`/stop` は未実装です。既存の `/leave` と無人退出で全処理を停止します。
- 動画の通常ゲインは元音声の0.125倍（前設定の半分）です。読み上げ音量は常時100%を維持し、読み上げPCMがある間は動画を通常音量の15%（元音声の0.01875倍）へ60msのease-in-out（smoothstep）でフェードし、終了・エラー・キャンセル・入力途切れ時は同じカーブで復帰します。フェード途中で切り替わった場合は、その時点のゲインから遷移します。動画位置は進み続けます。60msは初期値で、VCでの聴感調整は未実施です。
- 加算後の16bit範囲を超える信号はクリップします。オーバーフローを防ぎますが、音源によって歪みは残ります。音量の自動正規化や高度なリミッターは未実装です。
- 取得失敗はVCのテキストチャットへ通知して後続を処理します。Botにはそのチャンネルへの送信権限が必要です。

### 必要な外部コマンドと利用条件

ローカル実行では `ffmpeg` をPATHに配置し、このディレクトリで `npm run setup:media` を実行してください。
このコマンドは `.tools/media` 専用の仮想環境を作り直し、対応版のyt-dlpとEJSを導入します。
Python 3.10以上が必要です（macOS標準の3.9だった場合、インストール済みの新しいPythonを探します）。
Botは `YT_DLP_PATH` → この専用環境 → PATH の順でyt-dlpを探します。
既にPATH上へyt-dlpを導入している場合は専用環境の作成を省略できます。
別の場所なら `.env` の `FFMPEG_PATH` / `YT_DLP_PATH` に実行ファイルを指定します。
ffmpegは読み上げだけの利用でも必要です。
YouTube取得にはNode.jsと、yt-dlpのEJS依存関係も必要です。
Pythonの仮想環境なら `python -m pip install 'yt-dlp[default]>=2025.11.12'` で導入できます。
本実装は 実行中BotのNode.jsの絶対パスを `--js-runtimes node:<path>` に指定し、外部設定ファイル・Cookie・認証は読み込みません。
[yt-dlp公式README](https://github.com/yt-dlp/yt-dlp#dependencies) と
[EJS手順](https://github.com/yt-dlp/yt-dlp/wiki/EJS) を参照してください。

Dockerfileにはこれらの導入を追加していますが、この変更でのDockerビルドは未検証です。
既定ではビルド時の安定版を取得します。運用では検証したバージョンを
`docker build --build-arg 'YT_DLP_SPEC=yt-dlp[default]==<検証したバージョン>' .`
で固定してください。サイト側の変更、地域制限、レート制限、Bot判定などで公開動画でも取得に失敗します。
全動画の再生を保証するものではありません。

公開動画であることと、取得・Discordへの配信が許可されることは別です。
[YouTube利用規約](https://www.youtube.com/static?template=terms) と権利者の条件を確認し、
必要な許可を得たコンテンツに限って利用してください。制限の回避は実装していません。

### 構成・障害処理

パッケージ移動による変更を避け、単一Bot内で内部モジュールへ分離しました。
`src/index.ts` がサーバー別Sessionを所有し、既存の `queue.ts` / `tts.ts` が読み上げ、
`src/media/` が動画キューと交換可能な取得アダプター、`src/audio/mixer.ts` がPCMミックス、
`src/audio.ts` がDiscord送信を担当します。

PCMは48kHz・ステレオ・signed 16bit LE、20ms単位です。動画全体は保持せず、
子プロセスのパイプとReadableのバックプレッシャーで流します。
エンコード先読みは最大5フレーム（100ms）に制限します。
開始通知とキュー完了はAudioResourceの再生位置から1パケット分遅らせた位置で判定します。
これはBot送信側の位置であり、Discord受信端末の再生完了を保証するACKではありません。

元の60秒タイムアウトは読み上げにのみ維持します。動画にはメタデータ取得30秒、
PCM入力停止30秒、1ジョブ全体125分の上限を置きます。
退出時はキューを閉じ、取得・デコードを中断し、ストリームとタイマーを解放します。
macOS/Linuxでは外部プロセスをグループ単位で終了し、2秒で終了しなければ強制終了します。
Windowsの子孫プロセス終了は未検証です。

共有プレイヤー・接続の致命的障害では、そのサーバーのSessionを終了します。
接続切断には従来の再接続待ち（接続開始5秒＋Ready20秒）を維持し、失敗時は退出します。
再接続中の出力停止では先読み上限で入力を抑制します。自動再参加・キュー復元はありません。
再利用には `/join` が必要です。他サーバーのSessionには影響させません。

### 検証範囲

`npm run check` で型・lint・既存45テストと追加テストを実行します。
追加テストはゲイン・フェード、読み上げ失敗/キャンセル後の復帰、動画位置の継続、
短い末尾、出力完了待ち、クリップ、Session間分離、動画キュー順序・失敗・中断・上限、
URL検証、外部プロセス失敗・中断を対象とします。
ffmpegがあれば既存の準備音WAVを実デコードし、2トラックをミックスしてDiscord用Opusリソースの末尾まで消費する統合テストも実行します（なければスキップ）。
今回の環境ではスキップなしで81テスト成功、型チェック・lint・ビルド・差分の空白チェックも成功しました。

Discord VC、実VOICEVOX合成との同時再生、実Discord上での動画全編再生、長時間負荷、ネットワーク切断からの復帰は未検証です。
実機では次を確認してください。

1. `/join` 後、動画なしで辞書を含む複数投稿が順番に読まれる。
2. 許可された通常動画を2本追加し、再生中に投稿する。動画が進みながら読み上げ中だけ減衰し、終了後に復帰する。
3. 取得不能な動画の後ろへ正常動画を追加し、失敗通知と後続再生、読み上げ継続を確認する。
4. 再生・取得・読み上げの各タイミングで `/leave` / 無人退出し、子プロセスが残らない。
5. 2サーバーで同時利用し、一方の退出や失敗が他方へ影響しない。

本番デプロイ・コマンドの実登録はこの開発作業では実施していません。


### `/join` が準備失敗・無音になる場合

`TTS_MODE=external` の `npm run dev` はVOICEVOXを自動起動しません。
先にDocker Desktopが起動済みであることを確認し、このディレクトリで実行してください。

```sh
docker compose --env-file /dev/null -p popon-local -f compose.local.yaml up -d voicevox
curl --fail http://127.0.0.1:50021/version
npm run dev
```

`curl` がバージョンを返してから `/join` を実行し、「準備できました」を待ってください。
Docker接続エラーなら、まずDocker Desktopの起動状態と `docker context ls` を確認します。

外部モードでは `/join` 時に接続先を最大5秒で検査し、接続不能なら具体的な案内を返して退出します。
HTTP接続成功後も音声合成のウォームアップ完了を待ちます。
ログは `tts_state: STARTING` → `WARMING` → `tts_ready` → `join_ready` の順です。
`tts_warmup_error` があれば合成側のエラー、`connection_error` はVC側、
`audio_output_error` は共有音声出力側の問題です。

準備中は `/add` を受け付けず、音声出力も開始しません（読み上げ投稿は従来どおり待機します）。
準備中の `/leave` は待機を即時中断し、古い `/join` から遅れて失敗通知を出しません。
VOICEVOXの起動待ちは最後の利用サーバーが退出した時だけ中断し、他サーバーの準備は継続します。
初期化例外・後片付けの例外があってもVC切断とTTS利用解除を試みます。

実AudioPlayerで接続待ちから再生を開始し、送信パケットをOpusデコードして無音でないことを検証済みです。
実VOICEVOXとの同時再生と実Discord VCでの聴感確認は、引き続き手動検証が必要です。


`media_error` が `spawn yt-dlp ENOENT` の場合は動画条件ではなく、yt-dlpが未導入または見つからない状態です。
`npm run setup:media` 後にBotを再起動してください。明示的な `YT_DLP_PATH` がある場合はそのパスが優先されます。
この場合のDiscord通知は導入手順を示すよう変更済みです。YouTube側の拒否やデコード失敗は別の通知になり、詳細はログに残します。

2026-10-26の取得確認では、Python 3.11の専用環境にyt-dlp 2026.10.21とEJS 0.8.0を導入し、
`aRiVUVNUhIs` と `QMOtcx_yBt0` の両方で先頭約3秒（各578,592バイト）のPCM取得・デコードに成功しました。
音声が無音でないことも確認済みです。この検証ではDiscordへの配信や動画全編の再生は行っていません。


### 動画の終了後に次へ進まない場合

キュー進行はミキサーの出力完了を基準にします。取得・デコードのエラーは監視しますが、
出力完了後に残った外部プロセスの終了待ちで次の動画を止めず、そのプロセスを中断・解放します。
取得プロセスが先に正常終了しても、出力が終わるまでは次へ進みません。
後片付けで例外が出ても後続動画の処理は継続します。

動画ごとに `media_queued` → `media_fetching` → `media_started` → `media_finished` が記録されます。
`media_started` は先頭音声の送信位置到達時、`media_finished` は末尾の出力完了時です。
`media_finished` の後に次の `media_fetching` があればキューは進んでいます。
問題が続く場合は、これらと `media_error` / `audio_output_error` のログで停止箇所を確認してください。

回帰テストは、外部プロセスの完了待ちが残るケース、出力中の取得失敗、後片付けの例外、
2本連続＋完了後に追加する3本目を実AudioPlayerで送信し、各音源のOpusデコード結果が無音でないことを検証します。

2026-10-27には、指定の2動画をローカルで末尾まで取得・デコードし、連続出力を確認しました。
実AudioPlayerの20ms周期を使った正常系も2本とも完了しています（Discordのネットワーク接続部分は代替）。
実環境で報告された停止はこの正常系では再現しなかったため、外部プロセスの完了待ちを残す条件を注入して停止を再現し、修正後の進行を確認しました。
実Discord VCでの解消確認はまだ必要です。


2026-10-30の修正で、ミックス再生から共有した `youtu.be/<動画ID>?list=RD...` も単体動画として受け付けます。
動画IDのない `/playlist?list=...` は引き続き対象外です。
読み上げが名前付近で途切れる問題は、ffmpeg終了時にNode.jsが標準出力の残りを流し捨てる動作による音声欠落を再現して修正しました。
標準出力を有限サイズの中継バッファに受け、ミキサーが末尾まで読み切ります。
実再生速度で読み取ったPCMが、WAV全体のデコード結果とバイト単位で一致する回帰テストを追加しています。
