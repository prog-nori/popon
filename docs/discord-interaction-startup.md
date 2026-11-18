# /join・/playによるFargate起動の確認と配置手順

2026-11-18更新。Bot側の既存経路を再利用する。AWSへの操作、commit、push、`.env`・実Cookieの読み取りは実施していない。

## 調査結果と今回の作業範囲

利用者がAWS稼働中のソースを`lambda/discord-bot-interactions/index.mjs`へ追加したため、その実装を調査・修正した。
元からEd25519署名検証、PING/PONG、FIFO送信、ECS Describe/UpdateServiceは実装されていた。JSON形式もBotと互換だった。
不足は`leave / list / help`、join時の希望数確認、API待機上限、入力の検証、安全な失敗ログ、重複受信の同時実行抑制だった。
元のjoinはSQS送信とECS起動を並列に実行しており、送信失敗でも起動し得たため、保存完了後に起動する順序へ変更した。
AWS上の実行ロール・関数設定・Developer Portal設定は未取得で、現在の適用状態は未確認。

| 既存ファイル | 再利用できる機能 |
| --- | --- |
| `lambda/discord-bot-interactions/index.mjs` | 既存署名検証・PING・SQS配送・ECS起動を基に、不足コマンド・時間制限・失敗処理を追加 |
| `src/index.ts` | Gatewayログイン、`clientReady`後の受信開始、`executeCommand`、VC参加・退出、音楽操作 |
| `src/commands.ts` | 共通入力、FIFO JSON検証、URLオプション変換、5分の受理期限、queue→listの変換 |
| `src/sqs.ts` | 20秒ロングポーリング、120秒の可視性、30秒ごとの延長、受理後の削除、再配送の重複防止 |
| `src/sqs-dispatch.ts` | User IDからGateway Voice StateでVCを解決、通知先のGuild検証、通常メッセージによる結果通知 |
| `src/aws-service.ts` | Bot側の希望タスク数変更。Lambdaの起動処理ではない |
| `src/idle.ts` / `src/voice-idle.ts` | leave・VC無人からの停止候補と安全条件。[保証範囲](auto-stop.md)を参照 |
| `src/main.ts` / `Dockerfile` | `node dist/main.js`によるコンテナ起動 |

前段のjoin対応に加え、今回Lambdaの起動対象をjoin/playへ拡張した。
BotはSQS経由のplayで既存joinを再利用し、Sessionに保存した同じ準備Promiseを待ち、既存の再生キューへURLを登録する。
`CommandContext`とdispatcherへUser ID・受理期限を渡し、準備後にも現在のVC・期限を確認する。
Gateway経由のローカルplayは従来のjoin前提を維持する。
依存ライブラリは追加していない。YouTube Cookie、Secrets Manager取得、PO Token、`fetch_pot=always`、yt-dlp、FFmpeg、Mixer、VOICEVOX、再生キューの内部実装は変更していない。

## LambdaとBotの役割分担

```text
Discord /join または /play URL
  → Lambda Function URL（署名検証・PING応答・入力検証）
  → SQS FIFOに保存（Guild IDでグループ化、Interaction IDで重複防止）
  → Lambdaが既存サービスのdesiredCountを必要時だけ1にする
  → Discordへ3秒以内に受付結果を初期応答

ECSがBot・pot-provider・voicevox-engineを起動
  → BotがGatewayへログイン
  → clientReady後にSQSを受信
  → User IDで現在のVCを確認
  → 既存executeCommand(join)（既存の同一VCセッションがあれば再利用）
  → VC・VOICEVOX準備完了、通常のBotメッセージで結果通知
  → /playなら期限と現在のVCを再確認し、既存MediaQueueへ追加して再生
```

Lambdaの実装・検証内容：

1. Function URLの生の本文を使用してEd25519署名を検証する。Base64指定の本文を扱い、JSONを再シリアライズして検証しない。不正署名は401。署名検証後のPINGは`{"type":1}`。
2. そのアプリの公開鍵で署名を検証し、Guild/Interaction/User/Channel ID、コマンドとoptionsを検証する。DMなどGuildがない入力は受理しない。単一Guildへの許可リストは追加していないため、運用対象を限定する場合は別途設定・実装が必要。
3. すべての既存Slash CommandをHTTPで処理する：`join / leave / play / pause / resume / skip / list / help / stop / queue`。`play`の`options`には名前`url`、type `3`の文字列が必要。
4. 下記JSONをSQSへ送信し、送信完了後に起動処理へ進む。Interaction TokenやCookieはメッセージに追加しない。
5. `DescribeServices`で対象サービスの存在・ACTIVE・希望数を確認してから送信する。join/playで希望数0なら保存後に`UpdateService({cluster,service,desiredCount:1})`。1なら追加起動不要。2以上なら1へ勝手に縮退せず構成不整合として扱う。`RunTask`、希望数の加算、`forceNewDeployment`は使わない。それ以外は希望数0ならキューへ送らずjoin/playを案内する。
6. 署名不正/入力不正でAWS APIを呼ばず、AWS失敗では固定の分類だけ記録し、成功したように応答しない。SQS送信済み・起動失敗のケースも明示し、同じInteractionの再試行でも起動を再試行できるようにする。
7. ハンドラー開始から応答生成までの時間枠を2200msとし、Describe→SQS送信→Update全体で共有する。SDKは`maxAttempts:1`。同じAbortSignalを各APIへ渡し、SDKの認証情報解決等が待ち続けても期限でエラー応答へ戻す。Lambda残り時間が短ければ100msの余裕を残してさらに短縮する。タイムアウト時のAWS側成否は不確かなので、失敗表示で再実行を案内する。未awaitの起動処理を応答後に開始しない。
8. 初期応答は1回だけ。joinは起動・参加要求、playは起動・参加・再生要求の受付と伝え、参加/再生の成功とは区別する。Tokenを渡さない構成ではBotはLambdaの非公開初期応答を編集できない。SQS保存済みで起動APIが失敗した場合、元のplayが後から実行され得るため、すぐ同じ曲を再登録せず、起動しなければjoinで起動を再要求する案内にする。

**3秒以内を実環境で保証したわけではない。** Discordからの通信、Lambdaコールドスタート、イベントループ遅延はハンドラーの2200ms枠の外でも発生する。初回起動で測定し、枠内に収まらない場合は起動ワーカー等の別設計が必要。

```json
{
  "interaction_id": "123456789012345678",
  "guild_id": "123456789012345670",
  "user_id": "123456789012345671",
  "channel_id": "123456789012345672",
  "command": "join",
  "options": [],
  "created_at": 1793450000
}
```

`created_at`は署名タイムスタンプのUnix秒で、再送時に受理期限を引き延ばさない。署名は300秒以上古い、または60秒超の未来なら拒否し、Botの検証範囲と揃える。上の固定例はそのまま送らず、手動試験では現在時刻へ置換する。
`MessageGroupId=guild_id`、`MessageDeduplicationId=interaction_id`。
`channel_id`は通知先のテキストチャンネルで、VC IDではない。

同じInteractionの重複配送はFIFOの5分の重複排除とBotプロセス内の受理済みIDで抑制する。
同一Lambdaインスタンスでは5分間、処理中/成功応答のPromiseを共有し、同時受信でもAPIを重ねない。キャッシュは最大10000件。失敗は保持せず、SQS保存後の起動失敗も同じInteraction IDで再試行できる。
Lambdaの複数インスタンスをまたぐ「API呼出し自体が厳密に1回」はこの構成だけでは保証できない。
希望数を絶対値1にする操作は、複数回呼ばれてもタスク数を加算しない。
Botの受理後・削除前のクラッシュをまたぐ完全な一度限りの音楽操作も保証しない。
署名タイムスタンプの鮮度とメッセージ期限を組み合わせ、古いリクエストの再送を拒否する。

Botは処理中の可視性を延長する。一時的なGateway/API失敗時は削除せず再配送を待つ。
再配送時に`COMMAND_TTL_MS`を過ぎていれば実行せず破棄するため、失敗コマンドを期限なく実行し続けない。
受信デーモン自体はAWS通信障害後も最大30秒のバックオフで接続を再試行する。
ユーザーのVC未参加、対応外VC、入力不正などは通知または固定分類の記録で処理を完了する。
`join`は参加準備を開始した時点で受理され、実際のVC接続・VOICEVOX成功は`join_ready`と準備完了通知で確認する。

### play自動参加とSQSの保証範囲

- BotがGatewayの`clientReady`になるまで受信しない。Fargate起動待ちではSQSに保持する。キューの保持期間と、別の消費者がメッセージを取り去らない構成かはAWSで手動確認する。
- SQSのplayはセッションがなければ既存joinを実行。準備中ならそのPromiseを待つ。同じVCのセッションを重複作成せず、別VCの既存セッションへは移動しない。
- VC・VOICEVOX・準備音の完了後に、ユーザーの最新Voice State、Sessionの同一性、期限を再確認してから既存MediaQueueへ追加する。失敗時は追加せず通知し、無制限に接続し直さない。
- playの準備待ち中はSQSを削除せず、120秒の可視性を30秒ごとに延長する。FIFOの後続コマンドもその間待機する。待機は非同期で、音声のイベントループはブロックしない。
- VC準備の30秒、VOICEVOX起動の既定180秒など既存の上限は変更していない。音楽キューへ追加できた時点、または恒久的な失敗を通知した時点でSQS処理を完了する。再生終了までSQSを保持しない。
- `COMMAND_TTL_MS`は既定300000のまま。根拠のない延長はせず、要求が古くなれば破棄する。受信時だけでなく準備待ち後にも期限を確認する。既に受理した音楽の再生時間はこのTTLで中断しない。
- 5分が3コンテナのイメージ取得・起動・Gateway接続・VC/VOICEVOX準備を含めて十分かは未実測。実環境でそれらの合計を測定し、必要な場合だけ余裕を含めた`COMMAND_TTL_MS`へ変更する。dispatcherにも同じ設定値を渡すため、受信時と準備後の期限が一致する。SQSの保持期間は別の設定。
- 参加/再生キューの状態はメモリにある。受理後・削除前のクラッシュをまたぐ完全な一度限りの実行や、削除後のタスク停止による再生要求の消失防止は保証しない。Botは単一タスクで運用する。

## IAMの確認項目

以下は手動確認用の必要権限であり、現在のAWSロールに適用済みとは確認していない。
既存のCookie用Secret権限、タスク実行ロールのECR/SSM権限は維持する。

Lambda実行ロールに必要な範囲：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:ap-northeast-1:161063896786:discord-commands.fifo"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:DescribeServices", "ecs:UpdateService"],
      "Resource": "arn:aws:ecs:ap-northeast-1:161063896786:service/discord-bot-cluster/discord-bot-service"
    }
  ]
}
```

Botの**タスクロール**に追加/維持する範囲：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"],
      "Resource": "arn:aws:sqs:ap-northeast-1:161063896786:discord-commands.fifo"
    }
  ]
}
```

起動だけならBotの`ecs:UpdateService`は不要。既存の自動停止を有効にする別作業では対象キューの`sqs:GetQueueAttributes`と対象サービスの`ecs:UpdateService`も必要。
キューにカスタマー管理KMSキーを使用している場合は、そのキーに対する送信側の`kms:GenerateDataKey`/`kms:Decrypt`、受信側の`kms:Decrypt`およびキーポリシーを確認する。
アクセスキーは追加せず、Lambda実行ロール/ECSタスクロールの標準認証経路を利用する。

## 設定先と環境変数

Lambdaソースで確認した実際の変数名は次のとおり。CookieやDiscord Bot TokenをLambdaへ追加する必要はない。

| 設定先 | キー | 値/取得元 | 必須 |
| --- | --- | --- | --- |
| Lambda | `DISCORD_PUBLIC_KEY` | Developer Portalの対象アプリのPublic Key | 署名検証に必須 |
| Lambda | `SQS_QUEUE_URL` | `https://sqs.ap-northeast-1.amazonaws.com/161063896786/discord-commands.fifo` | 必須 |
| Lambda | `ECS_CLUSTER` | `discord-bot-cluster` | 必須 |
| Lambda | `ECS_SERVICE` | `discord-bot-service` | 必須 |
| Lambda | `AWS_REGION` | Lambdaが自動設定する`ap-northeast-1` | 手動追加不要 |
| Bot | `DISCORD_TOKEN` | 既存SSM参照をそのまま維持 | 必須 |
| Bot | `SQS_QUEUE_URL` | `https://sqs.ap-northeast-1.amazonaws.com/161063896786/discord-commands.fifo` | SQS受信に必須 |
| Bot | `AWS_DEFAULT_REGION` | `ap-northeast-1`。`AWS_REGION`があれば優先 | 明示推奨 |
| Bot | `COMMAND_TTL_MS` | 既定`300000`。初回起動待ち時間も含む | 任意 |
| Bot | `AUTO_STOP_ENABLED` | 初回は`false` | 任意、既定false |
| Bot | `AUTO_STOP_IDLE_MS` | 既定`60000`。VC無人の待機時間 | 任意 |
| Bot | `AUTO_STOP_COORDINATED` | 旧設定。現在の停止処理では使用しない | 不要 |
| Bot | `ECS_CLUSTER` / `ECS_SERVICE` | 上記の既存名称 | 起動受信だけなら不要。既存停止機能を使う場合のみ |
| Bot | PO Token/Cookie/VOICEVOXの既存設定 | 動作確認済みのタスク定義を維持 | 現行どおり |

PO Token/Cookie用の変数をLambdaやProviderへ複製する必要はない。Provider/VOICEVOXのコンテナ構成は変更しない。
`DISCORD_APPLICATION_ID`/`DISCORD_GUILD_ID`はコマンド登録用で、Botの通常起動・SQS受信には不要。

## ローカル検証

```bash
npm run typecheck
npm run lint
npx vitest run --maxWorkers 1
npm run build
```

実Discord Tokenや実AWSを使わず、SDKとDiscord接続をモックする。主な確認箇所：

- `tests/session.test.ts`：`clientReady`前には受信しない。FIFO入力→実dispatcher→共通join、play自動参加→準備完了→既存MediaQueue再生、join/play連続、VC不在・失敗・準備後の退出・期限切れ・別VC拒否、連続playの順序と重複を確認する。
- 同テスト：ユーザー退出後のjoin、同期VC接続失敗の安全な通知・記録。
- `tests/sqs.test.ts`：可視性延長、受理後削除、削除失敗後の二重操作防止、期限切れ、失敗時の非削除と再配送、安全なログ、受信失敗後の復旧。
- `tests/sqs-dispatch.test.ts`：実VCと通知チャンネルの分離、Guild未準備、誤った通知先、通知失敗で操作を再実行しない。

- `tests/lambda-interactions.test.ts`：実Ed25519鍵をテスト内で生成し、署名・改ざん・生本文/base64・PINGを検証。希望数0/1、不正入力、全10コマンドのBotパーサ互換、重複の同時受信・別インスタンス、各AWS API失敗、共有応答期限、実Lambda→SQS本文→Bot consumer/dispatcherもモックで検証する。

Lambda/API応答や音声の実環境検証は未実施。モック成功をAWS上での成功とは判定しない。

既存の`popon:youtube-cookies-tests`に現在の`src`・`tests`・`lambda`をマウントし、`--network none`で検証した。
2026-11-18の結果：Lambdaの構文確認、型チェック、lint、26ファイル311テスト、TypeScriptビルドがすべて成功。うちLambda関連は58テスト、Session関連は32テスト。既存のCookie/PO Token、実FFmpeg/Opus/Mixerテストも含む。
配布用Dockerイメージはこの作業では再ビルドしていないため、変更の配置には下記の再ビルドが必要。

## 手動での配置手順（未実行）

1. 全テストを確認する。今回はBotにもplay自動参加の変更があるため、**先にBotを更新してからLambdaを反映する**。Lambdaの反映時は`lambda/discord-bot-interactions/index.mjs`を既存関数の`index.mjs`へコピーしてDeployする。ランタイムは現在のNode.jsを維持し、ハンドラーは`index.handler`。AWS SDK v3はLambda Node.jsランタイム同梱版を使用できるため、Botのnode_modules一式をコピーしない。
2. Botの全テスト・ビルドを通し、未使用タグでLinux/amd64イメージを作る。今回はBotの再ビルド・配置が必要。既存の取得環境を固定するため、ビルド時はPOプラグイン用引数を省略しない。

   ```bash
   # poponディレクトリで実行。タグが未使用であることを確認する。
   docker build --platform linux/amd64 \
     --build-arg 'YT_DLP_SPEC=yt-dlp[default]==2026.10.26' \
     --build-arg 'POT_PLUGIN_SPEC=bgutil-ytdlp-pot-provider==2.0.2' \
     -t popon:discord-play-startup-v1 .

   docker tag popon:discord-play-startup-v1 \
     161063896786.dkr.ecr.ap-northeast-1.amazonaws.com/discord-bot:discord-play-startup-v1
   aws ecr get-login-password --region ap-northeast-1 | \
     docker login --username AWS --password-stdin 161063896786.dkr.ecr.ap-northeast-1.amazonaws.com
   docker push 161063896786.dkr.ecr.ap-northeast-1.amazonaws.com/discord-bot:discord-play-startup-v1
   ```

3. 利用者が既存サービスを希望数0にし、旧タスクの終了を確認する。既存の`discord-bot-task`から新リビジョンを作り、Botイメージだけを更新する。Provider、VOICEVOX、Cookie/Secret設定を維持する。Docker起動コマンドは`node dist/main.js`。
4. `SQS_QUEUE_URL`とタスクロールの権限、通常希望数0、On-Demand、サービス/Auto Scalingの最小数を確認する。単一Botでメモリ状態を共有しないため、タスクを複数同時に起動しない。0に戻せなくなる設定を残さない。
5. 確認済みのLambdaコード・実行ロール・環境変数を利用者が反映する。通常運用中のVOICEVOX/Providerへ新たな設定を追加しない。
6. Function URLはDiscordが呼べる`AuthType=NONE`と適切なリソースポリシーを使用する。現在のAWS仕様では`lambda:InvokeFunctionUrl`と`lambda:InvokeFunction`が必要。公開HTTPの正当性は関数内のDiscord署名で検証する。
7. **全コマンドのHTTP中継が確認できてから**Developer PortalのInteractions Endpoint URLへそのFunction URLを登録する。PING検証成功を確認する。既に設定済みならURLを不必要に変更しない。HTTP設定中はスラッシュコマンドはGatewayへ同時配送されない。

LambdaはECS/SQSへのHTTPS接続が必要。既存LambdaをVPCへ接続している場合は、その経路が到達可能か確認する。VPCやネットワーク構成をこの作業で変更する必要はない。
`src/register.ts`の全10コマンドとLambdaの受付一覧は一致する。Discord上に既に登録済みなら再登録は不要。

## /join・/playからの実環境確認（利用者が実施）

1. 対象サービスを希望数0・タスク数0にして、ユーザーが通常VCに入る。
2. 投稿権限のあるテキストチャンネルで`/join`。3秒以内の「受付」は参加成功ではない。
3. SQSへ1件保存され、希望数が1へ変わり、Bot・Provider・VOICEVOXが起動することを確認する。
4. Botの`bot_ready`→`command_consumer_started`→`command_received`→`command_handled`→`join_ready`と準備完了投稿を確認する。非同期のため`command_handled`と`join_ready`の前後だけで成否を判断しない。
5. 対象ユーザーのVCにBotが参加したことをDiscordで確認する。再度`/join`してもタスクは1のまま、別のVCセッションは作られないことを確認する。
6. `/play`、pause/resume/skip/list/queue/stop/leave、VOICEVOXを確認する。Lambdaの受付文だけでplay成功とは判定しない。
   その後もう一度希望数0・タスク数0に戻し、VC参加中に`/play URL`だけを実行して、起動→自動VC参加→実際の音楽再生を確認する。希望数1で別のplayを送ってもタスク数は増えないこと、join直後のplayも準備後に実行されることを確認する。
7. 起動待ちの間にユーザーがVC退出した場合は参加せず、案内と`join_rejected`を確認する。Guild準備不足の一時失敗は`command_retry_pending`、削除失敗は`command_delete_failed`、受理済み再配送は`command_duplicate`。
8. 自動停止を有効にする場合は[leave・VC無人による自動停止](auto-stop.md)の設定・保証範囲を確認する。無効の場合は希望数0を手動で設定する。

CloudWatch Logsは追加しない。ログ転送がない環境では既存stdoutが後から取得できるとは限らず、ECS Execも既に出力済みのstdoutを再生する機能ではない。Discordへの準備完了/失敗投稿、VC参加、ECSの希望数・稼働数、SQSの概数を併用する。概数だけでは個別コマンドの成功証拠にならない。

参照：

- [Discordの受信・応答・3秒制約・署名検証](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [ECS UpdateService](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateService.html)
- [ECSアクションとリソース範囲](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html)
- [SQS FIFOのグループ・重複排除](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-key-terms.html)
- [SQS可視性タイムアウト](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Lambda Function URLの認可](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
- [Lambda Node.jsと同梱AWS SDK v3](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)
