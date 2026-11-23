# Fargate起動環境の調査（2026-11-04）

## 確認結果

AWSは読み取り専用で確認し、設定・リソース・シークレットを変更していません。
ローカル`.env`とSSMのトークン値は読み取っていません。

- `discord-bot-task:2`はLinux/X86_64、Botコンテナ1つ、イメージは`discord-bot:v2`。
- entryPoint・command・workingDirectoryの上書きはありません。Dockerfileの`WORKDIR /app`と`node dist/main.js`が使われます。
- 明示設定の環境変数名は`SQS_QUEUE_URL`と`AWS_DEFAULT_REGION`、シークレット名は`DISCORD_TOKEN`でした。値は取得・表示していません。
- 停止済みの2タスクでBotの終了コード1を確認。アプリの具体的な例外はECSの停止理由に含まれていませんでした。
- 使用イメージのダイジェストは前回ローカルでビルド・検証したイメージと一致しました。
- 同イメージをネットワーク無効・ダミートークンで動かし、3項目だけで`config`を読み込めること、辞書・効果音が存在すること、`.env`がイメージにないことを確認しました。
  これは設定の検証であり、実トークンでのDiscordログイン成功を検証したものではありません。

追加のApplication IDやECSサービス名の不足は、通常起動の失敗原因にはなりません。
実際の終了原因は未確定です。SSMに保存された値が有効なBotトークンか、DiscordへのHTTPS/WSS接続が可能か、
そのトークンのアプリでMessage Content Intentが許可されているかが次の確認対象です。

## 起動順序と終了コード1

1. `src/main.ts`から`src/index.ts`を読み込む。
2. `src/config.ts`で全設定を読み込む。省略項目は既定値を使う。
3. `DISCORD_TOKEN`が空なら例外。辞書ファイルを読み、JSONと辞書の値の型を検証。
4. VOICEVOXクライアント・Discordクライアント・ヘルスチェックを用意。ここではEngineへの接続やFFmpeg実行は行わない。
5. `client.login(config.token)`。失敗時は`loginOrShutdown`が終了処理を呼び、`index.ts`が`process.exitCode=1`にする。
6. `clientReady`で`bot_ready`を出力。`SQS_QUEUE_URL`が非空ならSQS受信ループを開始。
7. SQSのAPIエラーはループ内で捕捉し、1～30秒の待機で再試行。通常はこれだけではプロセスを終了しない。
8. `/join`後にVC・VOICEVOX・効果音を準備する。Engineへの接続失敗はSessionを閉じるが、Botプロセス自体は継続する。

`main.ts`は起動時の例外を捕捉し、終了コード1を設定します。設定値が明示されている場合、数値の不正、
TTS_MODEの不正、VOICEVOX_ARGSのJSON/配列不正でも読み込み時に例外になります。
「省略」と「空文字の設定」は同じではありません。特にVOICEVOX_ARGSの空文字、TTS_MODEの空文字、
最小値のある数値設定の空文字は、起動失敗の原因になります。今回の3項目だけの定義にはこれらの上書きはありません。

辞書ファイルの不在・不正JSON・読み込み権限不足、モジュール不在なども起動例外になります。
SSM取得権限や取得時のネットワーク障害は通常ResourceInitializationErrorとして扱われ、
起動済みアプリの終了コード1とは切り分けて確認します。

## 環境変数一覧

「不要」は省略可能という意味です。明示した値が不正な場合まで許容するわけではありません。

|キー|用途・既定値|値の取得元／AWSでの設定|起動時の必須性|
|---|---|---|---|
|`DISCORD_TOKEN`|Discord認証|Parameter Storeの`/discord-bot/prod/bot-token`をsecretsとして注入。有効なBotトークンそのものが必要|必須|
|`SQS_QUEUE_URL`|SQSモード有効化|作成済み`discord-commands.fifo`のキューURL|AWSのコマンド受信に必須。未設定でもBotは起動する|
|`AWS_DEFAULT_REGION`|AWS APIのリージョン|`ap-northeast-1`|明示推奨。コードにも同じ既定値あり|
|`AWS_REGION`|上記より優先するリージョン|ECS実行環境が設定する値|通常は手動設定不要|
|`DISCORD_APPLICATION_ID`|スラッシュコマンド登録|Discord Developer PortalのApplication ID|通常起動は不要。`register`時のみ必要|
|`DISCORD_GUILD_ID`|コマンド登録の対象サーバー|DiscordのサーバーID|不要。未指定でグローバル登録。Botの参加先選択には使わない|
|`TTS_MODE`|Engine制御。既定`external`|Fargateの別コンテナ構成なら`external`|省略可能|
|`VOICEVOX_URL`|Engine API。既定`http://127.0.0.1:50021`|同一タスクのEngineなら既定値。別タスクなら実際に到達できるURL|起動には不要。join成功には接続先Engineが必要|
|`VOICEVOX_SPEAKER`|話者。既定`3`|利用するVOICEVOX話者ID|不要|
|`VOICEVOX_SPEED`|速度。既定`1.0`|運用設定。最小`0.1`|不要|
|`VOICEVOX_VOLUME`|音量。既定`1.0`|運用設定|不要|
|`VOICEVOX_EXECUTABLE`|Engine子プロセスの実行ファイル|コンテナ内のEngine実行ファイル|`process`モードでjoinする場合のみ必要|
|`VOICEVOX_ARGS`|Engineの起動引数。既定`[]`|文字列のJSON配列|不要。ただし明示値の検証は起動時に実行|
|`TTS_IDLE_MS`|Engine解放猶予。既定`600000`|運用設定|不要|
|`TTS_START_TIMEOUT_MS`|Engine準備期限。既定`180000`|運用設定。最小`1`|不要|
|`AUTO_LEAVE`|VC無人時退出。既定`true`|無効にする場合のみ`false`|不要|
|`AUTO_LEAVE_MS`|VC無人時の猶予。既定`60000`|運用設定|不要|
|`FFMPEG_PATH`|FFmpeg実行ファイル|省略推奨。イメージ内PATHの`ffmpeg`を使用|不要。音声処理時に使用|
|`YT_DLP_PATH`|yt-dlp実行ファイル|省略推奨。イメージ内PATHの`yt-dlp`を使用|不要。動画取得時に使用|
|`DICTIONARY_PATH`|辞書。既定`assets/dictionary.json`|イメージの`/app/assets/dictionary.json`|変数は不要。指すファイル自体は起動時に必須|
|`READY_SOUND_PATH`|効果音。既定`assets/sounds/meet_style.wav`|イメージ内の同梱ファイル|不要。join時に使用|
|`ECS_CLUSTER`|希望タスク数変更の対象|`discord-bot-cluster`|通常起動は不要。自動停止／致命的起動失敗時の停止を使う場合に必要|
|`ECS_SERVICE`|希望タスク数変更の対象|`discord-bot-service`|上記と同じ|
|`COMMAND_TTL_MS`|コマンド受理期限。既定`300000`|運用設定。最小`1000`|不要|
|`BOT_IDLE_MS`|Botのアイドル時間。既定`300000`|運用設定。最小`1000`|不要|
|`AUTO_STOP_ENABLED`|自動停止の有効化。既定`false`|現在はfalseのまま|不要|
|`AUTO_STOP_COORDINATED`|停止の外部調停が存在することの確認。既定`false`|現在はfalseのまま。この変数自体は調停ではない|不要|
|`ECS_STOP_ON_FATAL`|起動失敗時に希望数0を要求。既定`false`|必要な運用・権限を確認してから明示的に有効化|不要|

`ECS_CLUSTER`と`ECS_SERVICE`が空でも、起動時にはスケール変更用の関数を作るだけです。
値の検証とAPI実行はその関数を実際に呼んだ時です。自動停止の既定値はfalseなので通常起動に影響しません。

## Fargate固有の注意

- `/Users/...`や`/opt/homebrew/...`等のMac用パスを移さない。コンテナ内のファイル・PATHを使う。
- 現在のタスク定義にVOICEVOXコンテナはない。別途到達可能なEngineがなければjoinの準備に失敗する。
  ただしVOICEVOXの通信は起動時にはしないため、これだけでは起動直後の終了コード1を説明できない。
- localhostはローカルPCではない。同じFargateタスク内のEngineならlocalhostで通信できる。
- Dockerfileは`.env`を除外し、環境変数をECSから受け取る。`node dist/main.js`で起動するので`.env`は不要。
- 一方、`npm start`は`node --env-file=.env dist/index.js`なので、イメージ内に`.env`がなければNodeが失敗する。
  今回のタスク定義にはコマンド上書きがないため、これは今回の原因ではない。ECSでnpm startへ変更しない。

## 最小修正と検証

以前は`main.ts`がすべての起動例外を`bot_startup_failed`だけに置き換えていた。
`src/startup.ts`に固定コードへの分類を追加し、mainとログイン失敗時に利用するよう変更した。
トークン・生の例外文・スタック・環境変数の値は診断コードに含めない。音楽処理・AWS設定・依存関係は変更しない。

主なコードは`DISCORD_TOKEN_MISSING`、`DISCORD_TOKEN_INVALID`、`DISCORD_INTENTS_DISALLOWED`、
`STARTUP_DNS_FAILED`、`STARTUP_CONNECTION_TIMEOUT`、`STARTUP_FILE_MISSING`、`CONFIG_INVALID_NUMBER`。
分類できない例外は`STARTUP_FAILURE_UNCLASSIFIED`とする。コードは標準エラー／標準出力への出力だけで、
CloudWatch等の転送設定やAWSへのデプロイを自動追加しない。AWSイメージは未更新。

ネットワーク無効のDocker内で型チェック・Lint・148テスト（スキップなし）・TypeScriptビルドが成功。
実トークンでのログインやAWS上での再実行は行っていないため、実際の終了原因が確定したわけではない。

公式資料:

- [ECS環境変数](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-environment-variables.html)
- [ECS ResourceInitializationError](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/resource-initialization-error.html)
- [Node.jsの環境ファイル](https://nodejs.org/api/cli.html#--env-filefile)
