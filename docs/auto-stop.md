# /leave・VC無人時のFargate自動停止

2026-11-18。利用者が確認した現在の正常動作構成を維持し、Bot側だけに停止処理を追加する。Lambdaのjoin/play起動、Cookie、PO Token、fetch_pot=always、yt-dlp、FFmpeg、Mixer、VOICEVOX、再生キュー内部は変更しない。AWS接続・デプロイ・commit・push・実.env/Token/Cookieの読み取りは実施していない。

## 変更ファイル

| ファイル | 内容 |
| --- | --- |
| `src/idle.ts` | 旧5分アイドル停止を、明示的な停止候補と安全条件の確認へ置換。希望数1への復帰処理を削除 |
| `src/voice-idle.ts` | 実VCの人間/Bot判定、不明状態の拒否、60秒タイマーと再確認 |
| `src/index.ts` | leave・無人退出・Gateway状態・SQS空受信を接続。ECS成功後はSIGTERMを待つ |
| `src/sqs.ts` | 削除未完了メッセージの追跡、停止確定後の新規ポーリング抑止 |
| `src/aws-service.ts` | 設定済みサービスを0にする専用の呼出し口 |
| `src/config.ts` | `AUTO_STOP_IDLE_MS`追加 |
| `src/commands.ts`, `src/sqs-dispatch.ts` | 通知失敗を停止判断へ伝達。成功済み音楽操作は再実行しない |
| `tests/idle.test.ts`, `tests/voice-idle.test.ts` | 停止条件、API競合、無人判定とタイマー |
| `tests/session.test.ts` | 実ハンドラーとSQS consumerを通した停止順序・キャンセル |
| `tests/sqs.test.ts`, `tests/aws-service.test.ts`, `tests/startup-env.test.ts` | 削除完了、希望数0、設定既定値 |
| `docs/auto-stop.md`, `docs/aws-fargate.md`, `docs/discord-interaction-startup.md` | 設定・反映手順・競合の保証範囲 |

`@aws-sdk/client-ecs`は既に依存関係に存在するため、追加インストールやpackage-lock変更は不要。

## /leaveの処理順序

1. Gateway/SQSから既存の共通ハンドラーへ渡す。
2. 既存の音楽・読み上げキュー・音声出力を停止し、VC接続を破棄する。
3. 「退出しました」の通知をawaitする。通知失敗を観測した場合は停止候補を作らない。
4. 停止候補を記録するが、まだECSを変更しない。
5. SQS consumerがDeleteMessageをawaitし、削除未完了の記録を解放する。削除失敗時は記録を残して停止を拒否する。受理済みIDは維持し、再配送時は削除だけを再試行する。
6. consumerが次のReceiveMessageで空の結果を受けた後にのみ停止判定する。通常は最大20秒の追加待機がある。先に新しいコマンドを受信した場合は候補をキャンセルする。
7. Gateway準備完了・全Guild利用可能・全Sessionなし・参加準備なし・コマンド処理なし・削除未完了なしを確認する。
8. キューの可視・不可視・遅延メッセージ概数も確認し、照会後にローカル条件と活動世代を再確認する。
9. 対象サービスへUpdateService(desiredCount=0)を要求する。StopTask、process.exit、desiredCount=1による復帰は行わない。
10. 成功したら新規SQS受信を止め、プロセスとGatewayはECSからのSIGTERMまで維持する。SIGTERMで既存の終了処理を行う。希望数0により同一タスクのProvider/VOICEVOXもECSが停止する。

API失敗時は固定イベントだけを記録し、プロセスを終了させない。SDKの試行上限は既存の2回、API全体のAbortSignalは10秒。失敗候補を解除し、毎回の空受信で停止を無限に再試行しない。修正後に新しいleave/無人タイムアウトで再要求できる。

DeleteMessageの応答だけが失われ、実際には削除済みだった場合も、削除未完了のローカル記録を安全側に残す。再配送で解消できない場合は自動停止が保留されたままになるため、希望数・キュー状態を確認して手動で復旧する。

## VC無人の検知

既存のGuildVoiceStates IntentとvoiceStateUpdateを利用する。

- Sessionが準備完了し、音声接続がReadyで、Bot自身のVoice Stateが対象VCを指す場合だけ監視する。
- GuildのVoice Stateから対象VCにいる人間を数え、Bot自身と他のBotは除外する。
- Guild/チャンネル/メンバー情報が不明、Gateway切断中、参加・再接続中なら空とみなさない。
- 人間0人なら既定60秒を計測する。復帰や不明状態でキャンセルし、満了時にも再度確認する。
- Guild/Shard切断では全タイマーと停止候補をキャンセルする。再接続後に確認できた状態から新しい時間を計測する。
- タイマー満了で既存のleaveを実行し、空受信後に上記と同じ停止判定へ進む。別GuildのSessionが残れば停止しない。
- 退出後も、対象VCへの人間の復帰を停止API直前まで再確認する。60秒はVC退出までの時間で、ECS停止までには空受信・API待機が加わる。

AUTO_STOP_ENABLED=falseなら、既存AUTO_LEAVE/AUTO_LEAVE_MSによるVC退出だけの動作を維持し、ECSは停止しない。新しい自動停止が有効な場合の無人時間はAUTO_STOP_IDLE_MSを使用する。

## Botコンテナの環境変数

```text
AUTO_STOP_ENABLED=true
AUTO_STOP_IDLE_MS=60000
ECS_CLUSTER=discord-bot-cluster
ECS_SERVICE=discord-bot-service
AWS_DEFAULT_REGION=ap-northeast-1
```

SQS_QUEUE_URLと既存のSSM/Secrets Manager、PO Token、VOICEVOXの設定は維持する。アクセスキーを追加しない。停止APIはECSタスクロールの標準認証経路を使用する。

AUTO_STOP_ENABLEDは既存の名前を再利用し、既定はfalse。今回はtrueでleave/無人停止が有効になる。以前のBOT_IDLE_MSとAUTO_STOP_COORDINATEDは新しい停止方式では参照せず、外部調停が存在すると宣言するためのフラグも不要。旧5分停止方式は実行しない。AUTO_LEAVE_MSはAUTO_STOPがfalseの場合の既存退出機能だけに適用される。

## IAM：discord-bot-task-role

以下は手動確認用。現在のAWSポリシーは取得していない。**タスク実行ロールではなくアプリケーション用タスクロール**に設定する。既存のCookie取得等の権限は削除しない。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ecs:UpdateService",
      "Resource": "arn:aws:ecs:ap-northeast-1:161063896786:service/discord-bot-cluster/discord-bot-service"
    },
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:ap-northeast-1:161063896786:discord-commands.fifo"
    }
  ]
}
```

StopTask/RunTaskや他サービスへの権限は不要。UpdateServiceに渡す希望数はコードで0に固定する。このIAM権限自体が希望数の値を0だけに制約するものではない。

## ログ

既存stdoutに出力し、CloudWatch設定は追加しない。Cookie・Token・SQS本文・生のAWS例外は出力しない。

| イベント | 内容 |
| --- | --- |
| auto_stop_timer_started | voice_emptyの監視開始、Guild ID、待機時間 |
| auto_stop_cancelled | 人間復帰・不明状態・新コマンド・通知失敗等。停止API送信中ならrequestInFlight=true |
| auto_stop_condition_checked | leave/voice_empty、ローカル・キュー・タイマー段階の安全条件 |
| auto_stop_requested | desiredCount=0 APIの成功を確認 |
| auto_stop_failed | API/キュー照会失敗。自動的にプロセスを終了しない |

## 残る競合と保証範囲

**現在のBot・Lambda・SQS・ECSだけで、起動要求と停止要求を完全に原子化することはできない。**

例：Botが空の受信結果を確認→Lambdaが希望数1を確認→Lambdaがjoin/playを保存→Botが希望数0を送信、という順序なら、新しい要求がキューに残ってタスクが停止し得る。GetQueueAttributesの概数は遅延し、停止API直前のローカル再確認もLambdaの将来の送信を禁止できない。

今回の対策は、削除未完了のローカル記録・実際の空受信・概数・世代・Gateway/Session・人間復帰の再確認。確認中に観測した新コマンドでは停止しない。しかし、APIを送信した後のキャンセルはECSの更新を取り消せず、requestInFlight=trueのログだけで停止阻止の成功と判定してはいけない。

停止APIの応答が失われた場合も、実際には希望数0が反映されている可能性がある。Bot側から希望数1へ戻す処理は追加していない。

競合した際は、実際の希望数/タスク数を確認し、停止後に/joinを再実行する。元のplayが有効期限内でキューに残っていれば、再起動後に処理され得るので、同じ曲を直ちに重ねて登録しない。完全な停止保証が必要な運用ではAUTO_STOP_ENABLED=falseにする。将来的な恒久対策は、送信側と停止側の共通調停、停止後の独立した再起動確認などであり、今回は追加していない。

Botは単一タスクを前提とする。ローリング更新で旧新タスクを重ねると、旧タスクの停止が新タスクも停止させ得るので、初回反映は希望数0・旧タスク終了を確認して行う。

## ローカル検証

```bash
npm run typecheck
npm run lint
npx vitest run --maxWorkers 1
npm run build
```

AWS SDK、Discord、時間経過をモックし、外部通信なしで検証する。実際のToken/Cookie/.envは使用しない。実AWSでのAPI競合・音声・停止までの時間はモックだけでは検証できない。

今回の結果：27ファイル・337テスト成功、typecheck・lint・build成功。Node.jsがホストの実行PATHにないため、既存の開発用Dockerイメージ`popon:youtube-cookies-tests`へ現在のsrc/tests/lambdaをマウントし、`--network none`で実施した。Cookie/PO Tokenと既存のFFmpeg・Mixer・join/playの回帰テストを含む。本番用Dockerイメージの再ビルドと実Discord/AWSでの検証は未実施。

## 手動での反映（未実行）

最初に**現在サービスに適用されているタスク定義**を確認する。過去のリビジョン番号を固定で指定しない。

```bash
CURRENT_TASK_DEF=$(aws ecs describe-services \
  --region ap-northeast-1 \
  --cluster discord-bot-cluster \
  --services discord-bot-service \
  --query 'services[0].taskDefinition' --output text)

aws ecs describe-task-definition \
  --region ap-northeast-1 \
  --task-definition "$CURRENT_TASK_DEF" \
  --query 'taskDefinition.{family:family,revision:revision,taskRoleArn:taskRoleArn,images:containerDefinitions[].{name:name,image:image}}'
```

この表示には環境変数やシークレット値を含めない。取得した現行定義を基準に、利用者がコンソールで新リビジョンを作る。既存の3コンテナ構成、CPU/メモリ、シークレット参照、ネットワークを保持する。

```bash
cd /Users/shizu/program/products/discord-bot/popon
ECR_URI=161063896786.dkr.ecr.ap-northeast-1.amazonaws.com/discord-bot
IMAGE_TAG=auto-stop-$(date +%Y%m%d-%H%M%S)

docker build --platform linux/amd64 \
  --build-arg 'YT_DLP_SPEC=yt-dlp[default]==2026.10.26' \
  --build-arg 'POT_PLUGIN_SPEC=bgutil-ytdlp-pot-provider==2.0.2' \
  -t "$ECR_URI:$IMAGE_TAG" .

aws ecr get-login-password --region ap-northeast-1 | \
  docker login --username AWS --password-stdin \
  161063896786.dkr.ecr.ap-northeast-1.amazonaws.com

docker push "$ECR_URI:$IMAGE_TAG"
echo "$ECR_URI:$IMAGE_TAG"
```

1. タスクロールへ必要権限を確認/追加する。
2. 現在のタスク定義から新リビジョンを作り、Botイメージと上記環境変数を更新する。Provider/VOICEVOX/Cookie/PO設定は維持する。
3. 希望数0で旧タスク終了を待ち、既存サービスへ新リビジョンを適用する。Lambdaの更新・コマンド再登録・Developer PortalのURL変更は不要。
4. サービスの最小希望数やAuto Scalingが勝手に1へ戻さないこと、単一タスク運用であることを確認する。

## Discordでの検証

1. /joinまたは/playで起動し、通常の音声と読み上げを確認する。
2. /leaveで退出通知を確認し、希望数0→3コンテナを含むタスク停止を確認する。空受信待ちとECS終了処理の時間は必要。
3. 再度起動し、人間が最後に退出する。60秒未満で戻ると退出/停止しないことを確認する。
4. 再び全員退出し、60秒無人後にVC退出し、その後に希望数0になることを確認する。他Botだけ残る場合も検証する。
5. 他Guildが稼働中、参加準備中、Gateway再接続中は停止しないことを確認する。
6. /leave直後に/join・/playを送り、安全確認で観測された要求はキャンセルされることを確認する。競合窓を完全に排除した証明にはならないため、希望数とキューも確認する。
7. AUTO_STOP_ENABLED=falseのタスクで、leave/無人退出後も希望数1のまま、既存動作が維持されることを確認する。

参照：[ECS UpdateService](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateService.html)、[SQS概数の整合性](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_GetQueueAttributes.html)、[discord.js Clientイベント](https://discord.js.org/docs/packages/discord.js/14.27.0/Client:Class)
