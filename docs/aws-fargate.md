# AWS Fargate / SQS FIFO

既存の音声・動画キューを維持し、Lambdaの簡略化したコマンドをSQSから受信します。
AWSリソースの作成・変更はこのリポジトリから自動実行しません。

## 実装と入口

- `src/index.ts`: GatewayとSQSから共通の`executeCommand`を呼ぶ。音声・Session・キャンセル処理は既存実装を利用。
- `src/commands.ts`: Lambda本文の検証・変換。`created_at`はUnix秒。
- `src/sqs.ts`: 20秒ロングポーリング、1件ずつ受信、可視性120秒（処理中は30秒ごとに延長）、受理後の削除。
- `src/sqs-dispatch.ts`: GuildのGatewayボイスステートから実行ユーザーの現在のVCを特定。`channel_id`は通知先としてのみ使用。
- `src/idle.ts` / `src/aws-service.ts`: 停止候補の確認と希望タスク数変更。外部調停がなければ自動停止しない。
- `src/main.ts`: コンテナ起動の失敗を捕捉。明示的な設定がある場合だけサービス停止を要求。

`SQS_QUEUE_URL`が空ならAWSクライアントで通信せず、既存のローカルGateway操作を維持します。
AWSモードでもボイスステート・音声接続・読み上げにDiscord Gateway接続が必要です。
SQS受信は`clientReady`以後に始めます。Guildの準備中・切断中はコマンドを削除せず再試行します。

### コマンド

従来の`join / leave / play / pause / resume / skip / list / help`を維持します。
添付Lambdaとの互換性として`queue`は`list`の別名、`stop`は音楽と音楽待ちリストだけの停止です。
`stop`でVC退出や読み上げ停止は行いません。退出には`leave`を使用します。
`/play`だけによるコールド起動・自動参加は未実装です。

Lambda側のSUPPORTED_COMMANDSも以下へ揃えて、手動でDeployしてください。

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
|`BOT_IDLE_MS`|既定`300000`|
|`AUTO_STOP_ENABLED`|既定`false`。最初の疎通検証中はfalse|
|`AUTO_STOP_COORDINATED`|既定`false`。後述の外部調停が本当に存在する場合のみtrue|
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
- 不正形式・未対応・期限切れ・グループ不一致は実行せず削除。恒久的な入力不正でFIFOを詰まらせません。
- ユーザーのVC未参加・別VCでの操作・URL不正は通知して終了。GatewayやGuildの準備未完了は再試行。
- 削除失敗時は受理済みIDをメモリに残し、再配送では削除だけ再試行。
- 期限を過ぎたコマンドは次回起動時に実行しません。ただし一度受理した長い再生をTTLで中断しません。
- メモリで重複防止するため、処理後・削除前のクラッシュをまたぐ完全な一度限りの実行は保証しません。
- SIGTERMでは受信を中断し、未受理メッセージを削除せず、既存のVC・音声・子プロセスを解放します。

添付Lambdaは`type:4`で初期応答を完了し、Interactionトークンは送りません。
結果はBotとして`channel_id`へ通常投稿します。Lambdaの非公開応答を編集する機能はありません。
通知には送信権限が必要です。通知の失敗で成功済みの再生操作を再実行しません。

## 停止の保証範囲

全Guildで音楽・読み上げの待ち/処理/一時停止・参加準備・コマンド処理がなくなってから5分を計測します。
空の受信結果の後だけ停止判定し、キューの可視・不可視・遅延メッセージ概数を確認します。
ローカル活動の世代が変われば停止せず、停止要求後に活動を検知した場合は希望数1への復帰を試みます。
キュー照会失敗時は停止せず、停止APIの結果が不確かな場合も復帰を試みます。

ただし、SQSとECSの操作は原子的ではありません。現在のLambdaが起動を要求した直後にBotが希望数0を送ると、
新しいコマンドを取り残して停止し得ます。概数照会・短い猶予・再確認だけではこの競合を解消できません。
そのため`AUTO_STOP_ENABLED=true`だけでは停止せず、`AUTO_STOP_COORDINATED=true`も必要です。
このフラグ自体はロックや調停機能ではありません。競合を処理する外部調停・停止後の独立した再起動確認を
別途用意した場合にだけ両方をtrueにしてください。その仕組みはこの改修には含めていません。
導入前はサービスの希望数を手動で0にしてください。厳密な無競合の5分自動停止は未対応です。

`ECS_STOP_ON_FATAL=true`はコンテナ起動・ログイン失敗時に希望数0を要求します。
既定ではAWSの停止変更を行いません。SDK/IAMが壊れている場合・OOM・SIGKILLでは停止要求できないため、
希望数1のサービスによる再起動ループをアプリ単独で完全には防げません。ECS側の失敗検出や外部制御が必要です。
サービスを複数タスクや新旧重複で動かす場合は、古い失敗タスクが正常タスクも止めるためこの設定を使わないでください。

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
7. 希望数0から実際の`/join`で起動・VC参加を確認。Lambdaの受付文だけを成功判定にしない。
8. `/play`で曲を2本追加し、音声・順番・読み上げ時の音量を確認。pause/resume/skip/list/queue/stop/leaveを確認。
   停止前に同ID再配送・期限切れ・Gateway切断・削除失敗・準備中leave・SIGTERMも検証する。
9. 利用後はサービスの希望数を手動で0へ戻す。安全な停止調停が完成してから5分自動停止を検証する。

AWS実環境の接続・受聴・コールド起動時間と停止競合は、ローカルのモックテストでは検証できません。

公式資料:
- [SQS ReceiveMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html)
- [ECS UpdateService](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateService.html)
- [Fargateタスクのネットワーク](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html)
- [Discord Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
