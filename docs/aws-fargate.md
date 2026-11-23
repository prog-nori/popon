# AWS Fargate / SQS FIFO

Lambdaソースは`lambda/discord-bot-interactions/index.mjs`にあります。
`/join`起動の調査結果、IAM、応答期限と重複防止の範囲、手動配置手順は[イベント駆動起動の確認手順](discord-interaction-startup.md)を参照してください。

既存の音声・動画キューを維持し、Lambdaの簡略化したコマンドをSQSから受信します。
AWSリソースの作成・変更はこのリポジトリから自動実行しません。

## 実装と入口

- `src/index.ts`: GatewayとSQSから共通の`executeCommand`を呼ぶ。音声・Session・キャンセル処理は既存実装を利用。
- `src/commands.ts`: Lambda本文の検証・変換。`created_at`はUnix秒。
- `src/sqs.ts`: 20秒ロングポーリング、1件ずつ受信、可視性120秒（処理中は30秒ごとに延長）、受理後の削除。
- `src/sqs-dispatch.ts`: GuildのGatewayボイスステートから実行ユーザーの現在のVCを特定。`channel_id`は通知先としてのみ使用。
- `src/idle.ts` / `src/voice-idle.ts` / `src/aws-service.ts`: leave・VC無人からの停止候補、安全条件、希望数0への変更。保証範囲は[自動停止](auto-stop.md)を参照。
- `src/main.ts`: コンテナ起動の失敗を捕捉。明示的な設定がある場合だけサービス停止を要求。

`SQS_QUEUE_URL`が空ならAWSクライアントで通信せず、既存のローカルGateway操作を維持します。
AWSモードでもボイスステート・音声接続・読み上げにDiscord Gateway接続が必要です。
SQS受信は`clientReady`以後に始めます。Guildの準備中・切断中はコマンドを削除せず再試行します。

### コマンド

従来の`join / leave / play / pause / resume / skip / list / help`を維持します。
Lambdaとの互換性として`queue`は`list`の別名、`stop`は音楽と音楽待ちリストだけの停止です。
`stop`でVC退出や読み上げ停止は行いません。退出には`leave`を使用します。
HTTP/SQS経由の`/play`は、停止中ならLambdaが起動を要求し、Botが必要に応じてVCへ自動参加します。
参加準備が終わってから既存の音楽キューへ追加します。既存セッションが別VCにある場合は移動せず拒否します。
ローカルでGatewayから直接受ける`/play`は従来どおり先に`/join`が必要です。

保存済みLambdaのSUPPORTED_COMMANDSは次の全コマンドに対応します。AWSへの反映は手動で行ってください。

```javascript
new Set(["join", "leave", "play", "pause", "resume", "skip", "list", "help", "stop", "queue"])
```

新しい`stop`/`queue`をDiscordに表示する場合は、利用者がローカル環境で`npm run register`を実行します。
登録処理は指定スコープのコマンド一覧を置換します。他のアプリやサイト用AWSリソースは変更しません。

## ECS環境変数

|名前|設定|
|---|---|
|`DISCORD_TOKEN`|Parameter Storeの`/discord-bot/prod/bot-token`をタスク定義の`secrets`で参照|
|`SQS_QUEUE_URL`|`https://sqs.ap-northeast-1.amazonaws.com/161063896786/discord-commands.fifo`|
|`AWS_DEFAULT_REGION`|`ap-northeast-1`。`AWS_REGION`がある場合はそちらを優先|
|`ECS_CLUSTER`|`discord-bot-cluster`|
|`ECS_SERVICE`|`discord-bot-service`|
|`TTS_MODE`|`external`|
|`VOICEVOX_URL`|同じタスクにEngineを置く場合`http://127.0.0.1:50021`|
|`COMMAND_TTL_MS`|既定`300000`。コールド起動待ちを含む受理期限。起動計測後に調整|
|`AUTO_STOP_IDLE_MS`|既定`60000`。VC無人状態の待機時間|
|`BOT_IDLE_MS`|旧設定。現在の自動停止では使用しない|
|`AUTO_STOP_ENABLED`|既定`false`。最初の疎通検証中はfalse|
|`AUTO_STOP_COORDINATED`|旧設定。現在は使用しない。厳密な調停を実装するフラグではない|
|`ECS_STOP_ON_FATAL`|既定`false`。単一タスク運用と権限を確認後、起動失敗時にサービスを止める場合のみtrue|

AWS SDK v3の標準認証経路でECSタスクロールを使用します。アクセスキーを環境変数やコードに追加しません。
`.env`は参照用資料やDockerイメージに含めません。ホスト上の`.env`を`docker build`へ渡す必要はありません。

## IAM・タスク設定（手動で確認）

タスクロール（アプリのAWS APIアクセス）:

- 対象キューの`sqs:ReceiveMessage`、`sqs:DeleteMessage`、`sqs:ChangeMessageVisibility`。
- 自動停止を使用する場合は同キューの`sqs:GetQueueAttributes`と対象サービスの`ecs:UpdateService`。
- `ECS_STOP_ON_FATAL=true`の場合も対象サービスの`ecs:UpdateService`が必要。

タスク実行ロール（ECSによるイメージ・シークレット取得）:

- ECRのイメージ取得権限。
- 指定パラメータへの`ssm:GetParameters`。カスタマー管理KMSキーの場合は`kms:Decrypt`も確認。

サービスはFARGATE（On-Demand）、通常の希望数0、起動時1とします。
メモリ状態を分散しないため、同時に複数のBotタスクを動かさないでください。
ローリング更新でも新旧Botが重ならないよう、初回はサービスを手動で0にして旧タスク停止後に更新します。
CloudWatch Logsの`awslogs`ドライバー、Container Insights、Redis、DynamoDBはこの改修では導入しません。
既存stdoutログは残しますが、ログ転送先は追加しません。

### VOICEVOXが必須

既存`/join`はVC接続とVOICEVOX合成の両方を待ちます。Botだけのタスクでは準備に失敗し退出します。
`compose.voicevox.yaml`にある固定イメージを、タスク定義の2つ目のコンテナとして設定してください。
Composeの設定はECSへ自動反映されません。同一Fargateタスク内はlocalhostで通信できます。
Engineのヘルスチェックを設定し、Botの依存条件をHEALTHYにするか、Botより前にEngineを利用可能にします。
DockerfileにEngineを新規導入する変更はしていません。

Discord、YouTube、SQSへの外向き通信とDiscord VoiceのUDP送信・応答が必要です。
パブリックサブネットの場合も、インターネットへのルートとタスクのパブリックIPの有無を確認します。
3000番のヘルスチェックと50021番のEngine APIをインターネットへ公開する必要はありません。

## メッセージの受理・結果

```json
{"interaction_id":"123456789012345678","guild_id":"123456789012345670","user_id":"123456789012345671","channel_id":"123456789012345672","command":"join","options":[],"created_at":1793450000}
```

上記は形式の例で、そのまま送ると期限切れです。テストでは実際のIDと現在のUnix秒へ置き換えます。
FIFOのMessageGroupIdはguild_idと一致させてください。

- `/join`はSessionを確保し準備処理を開始した時点で受理・削除。VC・VOICEVOXの成功は後で通知します。
- `/play`は音楽キューに追加した時点で削除。音楽の終了までSQSメッセージを保持しません。
- SQSの`/play`は未参加なら既存joinを実行し、準備中なら同じ準備Promiseを待ちます。準備中は可視性を延長して削除を待ち、後続FIFOコマンドも待機します。準備後にユーザーのVCと有効期限を再確認します。
- 不正形式・未対応・期限切れ・グループ不一致は実行せず削除。恒久的な入力不正でFIFOを詰まらせません。
- ユーザーのVC未参加・別VCでの操作・URL不正は通知して終了。GatewayやGuildの準備未完了は再試行。
- 削除失敗時は受理済みIDをメモリに残し、再配送では削除だけ再試行。
- 期限を過ぎたコマンドは次回起動時に実行しません。ただし一度受理した長い再生をTTLで中断しません。
- メモリで重複防止するため、処理後・削除前のクラッシュをまたぐ完全な一度限りの実行は保証しません。
- SIGTERMでは受信を中断し、未受理メッセージを削除せず、既存のVC・音声・子プロセスを解放します。

Lambdaは`type:4`で初期応答を完了し、Interactionトークンは送りません。
結果はBotとして`channel_id`へ通常投稿します。Lambdaの非公開応答を編集する機能はありません。
通知には送信権限が必要です。通知の失敗で成功済みの再生操作を再実行しません。

## 停止の保証範囲

`AUTO_STOP_ENABLED=true`で、通知済みのleaveまたは60秒無人によるVC退出を停止候補とします。
SQS削除完了・実際の空受信・全Session/準備/処理なし・Gateway正常・キュー概数を確認して希望数0を要求します。
失敗時はプロセスを終了せず、希望数1への復帰や無制限の停止再試行を行いません。
停止確定後は新規SQS受信を止め、ECSのSIGTERMを待ちます。

Lambdaの送信とECS更新は原子的ではありません。確認後に新しい要求が届く競合は残り、完全な停止保証が必要なら自動停止を無効にしてください。
詳細な順序、IAM、現行タスク定義からの反映手順、競合対策は[自動停止の手順](auto-stop.md)を参照してください。

`ECS_STOP_ON_FATAL`は起動失敗時の別機能で、今回の自動停止とは独立しています。既定falseを維持します。

## 配置と確認の順序

1. 型・Lint・既存回帰テスト・追加テストを実行: `npm run check`。コンパイル: `npm run build`。
2. 新しい未使用タグでビルドする（Immutableのv1は再使用しない）。

   ```bash
   docker build --platform linux/amd64 -t 161063896786.dkr.ecr.ap-northeast-1.amazonaws.com/discord-bot:v2 .
   aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin 161063896786.dkr.ecr.ap-northeast-1.amazonaws.com
   docker push 161063896786.dkr.ecr.ap-northeast-1.amazonaws.com/discord-bot:v2
   ```

3. 利用者がタスク定義`discord-bot-task`の新リビジョンを作り、Botイメージ・VOICEVOX・タスクロール・環境変数・シークレットを指定。
   起動コマンドの古い上書きは外し、Dockerfileの`node dist/main.js`を使用する。
4. サービス`discord-bot-service`を希望数0にし、旧タスク終了後、新リビジョンへ更新。
5. 初回はAUTO_STOPを無効のまま希望数1で起動。実際のユーザーがVCに入ってから、現在時刻のjoinメッセージをSQSへ手動送信。
   VCへ参加し、準備完了通知と効果音を確認。通知先とVCを別IDにして取り違えがないことも確認。
6. Lambdaのコマンド一覧を揃えてDeploy。準備後にDiscordのInteractions Endpoint URLをLambdaのFunction URLへ設定。
   GatewayとHTTPのスラッシュコマンド受信は同時には行われないため、受信処理が揃う前に切り替えない。
7. 希望数0から実際の`/join`で起動・VC参加を確認。再び停止後、VC内で`/play URL`を実行して自動起動・VC参加・音楽再生を確認。Lambdaの受付文だけを成功判定にしない。
8. `/play`で曲を2本追加し、音声・順番・読み上げ時の音量を確認。pause/resume/skip/list/queue/stop/leaveを確認。
   停止前に同ID再配送・期限切れ・Gateway切断・削除失敗・準備中leave・SIGTERMも検証する。
9. 自動停止を有効化した場合はleave/60秒無人後の希望数0を確認する。完全な調停はないため競合試験も行う。無効なら従来どおり手動で0へ戻す。

AWS実環境の接続・受聴・コールド起動時間と停止競合は、ローカルのモックテストでは検証できません。

公式資料:
- [SQS ReceiveMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html)
- [ECS UpdateService](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateService.html)
- [Fargateタスクのネットワーク](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html)
- [Discord Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
