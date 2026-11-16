# YouTube Cookie / Secrets Manager連携

2026-11-16。Cookie機能は既定OFF。既存のPO Token機能、`mweb;fetch_pot=always`、Node.js、動画情報90秒上限、socket 15秒、retries 2、`bestaudio -o -`、FFmpeg/Mixer、Discord再生キュー、VOICEVOXを維持する。AWSリソース・Providerコンテナ・Lambda・SQSは変更しない。

## 変更ファイル

| ファイル | 内容 |
| --- | --- |
| `src/media/cookies.ts` | 独立した環境設定、SDK取得/キャッシュ、検証、一時ファイル、後始末、安全な観測 |
| `src/media/youtube.ts` | metadata/download双方にCookieパス、子プロセス所有期間と観測を接続 |
| `src/media/po-token.ts` | 既存引数を維持し、Player用Tokenの要求/受領の観測を追加 |
| `src/media/diagnose.ts` | PCM先頭バイトの観測と診断終了時のCookie後始末 |
| `src/index.ts` | 起動時のCookieモード、停止時の後始末 |
| `src/audio/failure.ts` | Secret/ファイル/LOGIN_REQUIREDの固定分類 |
| `package.json`, `package-lock.json` | Secrets Manager SDK追加、既存依存は維持 |
| `.env.example`, `.gitignore`, `.dockerignore` | 追加設定とCookieファイル除外 |
| `tests/cookies.test.ts`, `tests/youtube-cookies.test.ts` | 新規Cookie検証35件＋yt-dlp連携10件 |
| `tests/po-token.test.ts`, `tests/youtube-po-token.test.ts` | Player用観測と既存引数の検証/整形 |
| `README.md`, `docs/media-diagnostics.md`, `docs/youtube-cookies.md` | 手順・診断・制約 |

`src/config.ts`は変更せず、Cookie設定はDiscord設定から独立したモジュールに置いた。DockerfileのCOPY・非rootユーザー・起動コマンドも変更していない。Provider用Compose設定、キュー、音声処理内部、Lambda/SQSには変更を加えていない。

## 取得・一時ファイル・同時実行

```text
ECSタスクロール → Secrets Manager GetSecretValue (AWSCURRENT)
  → Netscape形式の検証 → プロセス内の非公開キャッシュ
  → 再生ごとの専用一時ディレクトリ0700 / cookies.txt 0600
      → yt-dlp metadata --cookies <絶対パス>
      → yt-dlp bestaudio --cookies <同じ専用パス> → pipe → FFmpeg → PCM
      → yt-dlp終了後に専用ディレクトリを削除
```

追加依存は`@aws-sdk/client-secrets-manager`（既存ECS/SQS SDKと同じ3.1161.0系列）。credentialsやloggerをSDKへ指定せず、標準認証チェーンからECSタスクロールの一時認証情報を利用する。Cookieの実値・AWSアクセスキーを環境変数へ入れない。

初回のCookie有効再生時に取得する。同じregion/Secret IDについて、並行要求も同じPromiseを共有する。SDKの最大試行数は2、リクエストには10秒のAbortSignalを設定する。失敗もキャッシュするため、後続動画による無制限再試行をしない。修正・更新後は新しいタスク/プロセスで再取得する。ECS Execで診断するたびに別プロセスとなるため、その診断ごとに1回取得する。

再生のキャンセルは共有取得を中断せず、その再生の待機だけを解除する。Bot/診断の終了時は共有SDK要求も中断する。

SecretStringはNetscape形式のcookies.txt全文をプレーンテキストで保存する。JSONで包まず、SecretBinaryは使わない。ヘッダー、7列、ドメイン/フラグ/パス/期限/名前、制御文字、空内容、最大64 KiBを検証する。HttpOnly行とCRLF、session cookieの期限0/空を扱う。形式検証はCookieの有効期限・アカウント有効性・YouTubeによる受理を保証しない。

yt-dlpは終了時にCookieを書き戻すため、複数再生で同じファイルを共有しない。各再生内ではmetadata後のファイルをdownloadへ渡し、更新状態を引き継ぐ。他の再生は取得時点のキャッシュから独立したファイルを作る。メモリ内の初期Secretをyt-dlpの書き戻しでは上書きしない。

一時領域はOSのtmpdirを使用する。作業ディレクトリ内へのTMPDIR指定は拒否する。通常完了、失敗、skip/leave、診断終了、SIGINT/SIGTERMで子プロセス終了を待って削除する。SIGKILL/OOMでは後始末を実行できないため、コンテナ破棄時の一時領域破棄に依存する。失敗して残ったファイルは固定分類の削除失敗ログにする。

DockerfileはSecretをCOPYせず、非rootの`node`ユーザーと`node dist/main.js`を維持する。`/tmp`が書き込み可能であることが必要。`.gitignore`/`.dockerignore`にもCookieファイルを除外する設定を追加した。

## 環境変数（Botコンテナ）

| キー | 値 | 用途 |
| --- | --- | --- |
| `YOUTUBE_COOKIES_ENABLED` | `true` / 既定`false` | true時のみAWS取得・Cookie使用 |
| `YOUTUBE_COOKIE_SECRET_ID` | `/discord-bot/prod/youtube-cookies` | Secret名または完全ARN。ON時必須、実値は禁止 |
| `AWS_DEFAULT_REGION` | `ap-northeast-1` | SDKの接続先。AWS_REGIONがあればそちらを優先 |
| `YOUTUBE_POT_ENABLED` | 既存どおり`true` | Providerを併用する場合 |
| `YOUTUBE_POT_BASE_URL` | `http://127.0.0.1:4416` | 同一Fargateタスクの既存Provider |

OFFではSecret IDを検証せず、Secrets Managerを呼ばず、`--cookies`を渡さない。PO OFF/ONとは独立した設定。Provider側へCookie環境変数を追加する必要はない。

## IAM・ネットワーク（利用者が確認）

Bot自身がSDKで取得するため、権限は**ECSタスクロール**に付ける。SSMからBot tokenを注入するタスク実行ロールとは別。

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "secretsmanager:GetSecretValue",
    "Resource": "<対象Secretの完全ARN>"
  }]
}
```

カスタマー管理KMSキーで暗号化した場合は、そのキーへの`kms:Decrypt`とキーポリシーも確認する。AWS管理キー`aws/secretsmanager`の場合はこの追加権限は不要。タスクからSecrets ManagerのHTTPSエンドポイントへ到達できることを確認する。Secretの作成・更新やIAM/VPC変更は今回実行していない。SDK取得はサービスの料金対象で、タスク内キャッシュで回数を抑える。

## PO Token・認証ヘッダーとの関係

Cookie ON時のみ、metadata/download双方へ`--cookies <専用絶対パス>`を追加する。Cookie値をargvに含めない。mwebはCookieをサポートするクライアントで、PO引数とは別オプションなので既存指定を上書きしない。Player用とGVS用のTokenは引き続きyt-dlp/Providerが扱う。診断にはPlayer用の要求/受領も追加した。

現在のFFmpegは`pipe:0`でyt-dlpからのバイト列を受け、YouTubeへ直接アクセスしない。この経路でFFmpegへCookie/Authorizationヘッダーを渡す必要はない。署名付きURLやCookieヘッダーをFFmpegの引数へ追加していない。将来FFmpegへURLを直接渡す方式へ変える場合は別途ヘッダー継承の設計が必要。

## 安全なログ・診断

| イベント/フィールド | 意味 |
| --- | --- |
| `youtube_cookie_mode.enabled` | 起動時/取得時のON・OFF |
| `youtube_cookie_secret_fetch.ok` | AWS取得の成否。形式検証とは別 |
| `youtube_cookie_file_ready.ok` | 形式検証とファイル準備。認証成功を意味しない |
| `youtube_cookie_auth_result.cookieRead` | `observed`: yt-dlpのアカウントCookie検出、または初期化後のPlayer API取得ログを観測 / `failed` / `unconfirmed` |
| `accountCookiesDetected` | yt-dlpがアカウント用Cookieの存在を検出。ローカル判定でありサーバー受理ではない |
| `cookiesInvalidated` | yt-dlpがCookie無効化/ローテーションを報告 |
| `loginRequiredObserved` / `outcome=login_required` | Cookie使用後もログイン要求を観測 |
| `loginAcceptance` | 拒否を観測すると`rejected`。それ以外は`unverified`。公開動画成功からログイン成功を推定しない |
| `youtube_pot_result.playerTokenRequested/Received` | Player用Tokenの要求・受領。GVSとは別 |
| `youtube_media_result` | metadata成功、download先頭バイト、完了/失敗と固定分類 |
| `stage=decode,state=first_pcm` / `media_probe_result.pcmBytes` | 診断でPCMを実際に取得できた証拠 |
| `youtube_cookie_file_removed.ok` | 子プロセス終了後の削除結果 |

AWS失敗は`cookie_secret_access_denied`、`cookie_secret_not_found`、`cookie_secret_decryption`、`cookie_secret_credentials`、`cookie_secret_throttled`、`cookie_secret_timeout`、`cookie_secret_network`、`cookie_secret_unavailable`。形式等は`cookie_secret_not_string`、`cookie_empty`、`cookie_format_invalid`、`cookie_file_io`。yt-dlpの`LOGIN_REQUIRED`は`youtube_login_required`、Bot判定文は従来の`provider_bot_check`、GVS取得の拒否は`download/http_403`で識別する。

生のSDK例外、stderr、Cookie、Token、任意のレスポンス本文、Authorization、署名付きURL、Cookieパスをログへ転送しない。stderrはメモリ内で固定パターンのみ解析する。`pot_trace`、`--print-traffic`、生の`--dump-single-json`を共有しない。

ECS Execが利用可能な更新後のBotコンテナで、利用許諾のある動画ページURLを使う（音楽再生を止めて追加負荷を避ける）。

```bash
cd /app
node dist/media/diagnose.js 'https://www.youtube.com/watch?v=lxk1UcXcLc8'
```

順に、Secret取得→ファイル準備→Cookie観測→metadata成功またはLOGIN_REQUIRED→GVS/audio→PCMを確認する。CloudWatch Logsは必須ではない。この診断はDiscordログインやVOICEVOXを開始せず、`.env`を読まない。Cookie ONの場合は実AWS Secretを取得するため、ローカルではこの実行方法で実認証情報を使用せず、下記のモックテストを使う。

## モック検証・ビルド

```bash
npm ci
npm run check
npm run build
```

テストは架空のNetscapeデータとAWS SDKモックのみを使用する。権限、並行取得の共有、ファイル分離/書き戻し、削除順序、取得失敗、失敗キャッシュ、新タスクの再取得、引数保持、秘密情報非出力を確認する。実Google Cookie、実Secret、AWSの認証情報は要求しない。

2026-11-16のローカルDocker検証では、型チェック・lint・ビルド成功、25ファイル233テスト成功（スキップなし）。既存の実FFmpeg/Opus/Mixer・VOICEVOX API・Discordコマンドのモック検証も含む。Dockerビルドと併走した試行では既存の音声出力テストが5秒待機上限で一度失敗し、ビルドと分離して1ワーカーで全件再実行すると成功した。音声処理やテストの時間制限を変更してはいない。

配布用`popon:youtube-cookies-local`もビルド済み（Linux/amd64、USER node、`node dist/main.js`、image ID先頭`885fae7f788f`）。非rootのUID 1000で、SDKをモックして作った架空Cookieをyt-dlp自身が1件読み込み・書き戻し、0600を維持し、終了後に削除できることを`--network none`で確認した。実AWSやGoogleには接続していない。yt-dlp 2026.10.26 / EJS 0.8.0 / bgutil 2.0.2の互換性チェックも成功した。

旧`popon:po-token-local`（image ID先頭`8db8fd3aa086`）は変更していない。Cookie対応を反映する場合は新しいイメージを使う。

POプラグインを維持したLinux/amd64の配布用イメージを、未使用タグでビルドする。

```bash
docker build --platform linux/amd64 \
  --build-arg 'YT_DLP_SPEC=yt-dlp[default]==2026.10.26' \
  --build-arg 'POT_PLUGIN_SPEC=bgutil-ytdlp-pot-provider==2.0.2' \
  -t popon:youtube-cookies-local .
```

Provider/VOICEVOXのイメージ・構成は変更しない。`compose.pot.yaml`も変更していない。既存タグの上書き、ECR push、ECSタスク更新、Git commit/pushは行わない。

実際のGoogle Cookieによるログイン、FargateでのSecret取得、実動画のアクセス許可、LOGIN_REQUIRED/HTTP 403解消、Discord上の実再生はモック試験では検証できない。Cookieのローテーション/期限切れ、アカウント・IP制限は別に残り得る。Secret更新後は新しいタスクを起動して初回取得し直す必要がある。

参考: [AWS GetSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html)、[SDKの認証プロバイダー](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-credential-providers.html)、[yt-dlp YouTube Cookie](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies)、[固定版Cookieの読書き実装](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/cookies.py)
