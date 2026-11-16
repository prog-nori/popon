# ローカルPO Token検証

2026-11-13、`feature/youtube-po-token`で実装。AWS・ECR・Lambda・SQS・ECS・Discordの設定は変更していない。コミット・pushも行っていない。

## 構成と既存処理

```text
Discord/Gateway または既存SQSコマンド
  → 既存MediaQueue → YoutubeAdapter
      → yt-dlp（同じPython venv内のProviderプラグイン）
          → HTTPのpot-provider:4416 → YouTube/Google（匿名）
          → YouTubeメタデータ / 音声ストリーム
      → 既存FFmpeg → PCM → 既存Mixer → Discord音声接続
```

元のURL正規化、`-f bestaudio -o -`、FFmpegの48 kHz/stereo/s16le、Mixer、再生キュー、Discordコマンド、VOICEVOXを維持した。エントリーポイントは`node dist/main.js`のまま。ProviderはON時の`/play`で確認し、BOT起動自体にはProvider接続を要求しない。

## 変更ファイル

| ファイル | 変更内容 |
| --- | --- |
| `src/media/po-token.ts` | ON/OFF、HTTP接続確認、引数構築、安全な観測ログ |
| `src/media/youtube.ts` | メタデータ／音声取得の両方へ条件付きで接続 |
| `src/audio/process.ts` | 生stderrを公開せず観測するコールバック |
| `src/audio/failure.ts` | Bot判定・GVS 403・Provider失敗の分類 |
| `src/index.ts` | 起動時のON/OFF記録 |
| `Dockerfile` | 任意のプラグイン導入と互換性確認スクリプトの配置 |
| `compose.pot.yaml` | ローカル用Provider、内部接続、比較用固定バージョン |
| `.env.example` | OFF既定の2環境変数 |
| `scripts/setup-media.py` | ホストvenv向けの明示的な`--po-token`オプション |
| `scripts/check-po-token.py` | 認証情報・通信不要の同一venv互換性確認 |
| `tests/po-token.test.ts` | 設定・接続・秘密情報非出力・観測の検証 |
| `tests/youtube-po-token.test.ts` | ON/OFFでの引数・既存取得経路・停止時の検証 |
| `tests/session.test.ts` | ログインをモックしたON/OFF起動検証 |
| `tests/media-diagnostics.test.ts` | Bot判定の独立分類に対応 |
| `README.md` | ローカル検証手順への案内 |
| `docs/media-diagnostics.md` | 新分類・ログ方式の説明 |
| `docs/po-token-local.md` | 構成、起動、比較結果、未検証範囲 |

## 固定した依存関係

| 項目 | ローカル比較用ビルド |
| --- | --- |
| yt-dlp | 2026.10.26 |
| yt-dlp-ejs | 0.8.0（yt-dlpのdefault依存指定） |
| bgutilプラグイン | 2.0.2、`/opt/media`の同じvenvにpipで導入 |
| HTTP Provider | `brainicism/bgutil-ytdlp-pot-provider:2.0.2-node` |
| Provider digest | `sha256:d7d34108b76e52c7d3b575fe9e797e4bf41c1b2a08f80c5292eff6f851ce8472` |
| BOT比較イメージ | `popon:po-token-local` / linux/amd64で検証 |

新しいnpm依存は追加していない。通常のDockerfileビルドでは`POT_PLUGIN_SPEC`が空なのでプラグインを追加しない。`compose.pot.yaml`を選んだ場合だけ、上記固定バージョンでビルドする。従来のDockerfileのyt-dlp既定指定は維持している。将来通常ビルドでも同じ版を使う場合は`YT_DLP_SPEC`を明示する。

公式READMEの要件（yt-dlp 2025.05.22以上）を満たし、プラグインのHTTP Provider APIがこのyt-dlpでimportでき、GVSを扱えることをオフラインで確認した。実際の抽出ログでもHTTPプラグインの認識を確認した。[Providerの固定版README](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/blob/2.0.2/README.md)

## ON/OFF

| 環境変数 | 既定 | 用途 |
| --- | --- | --- |
| `YOUTUBE_POT_ENABLED` | `false` | `true`でHTTP Providerを使う。真偽値は小文字で指定 |
| `YOUTUBE_POT_BASE_URL` | `http://127.0.0.1:4416` | ON時のProvider。Compose内では`http://pot-provider:4416` |

OFFでは`--no-plugin-dirs`を明示し、比較イメージにインストール済みのプラグインが自動起動しないようにする。`--ignore-config`だけではプラグインを無効にできないため、この指定が必要。

ONでは次をメタデータ取得・音声取得の両方に渡す。

```text
--verbose
--extractor-args youtube:player_client=mweb;fetch_pot=always
--extractor-args youtubepot-bgutilhttp:base_url=http://pot-provider:4416
--extractor-args youtubepot-bgutilscript:server_home=/nonexistent/popon-http-only
```

最後の指定は、HTTPサーバー停止時にホームディレクトリのスクリプトへ暗黙にフォールバックすることを避けるため。mweb以外のクライアントへのフォールバックも今回追加していない。Cookie、Googleログイン、固定Token、VPN、プロキシ、IPローテーションは使わない。

## Dockerで起動

作業場所は`popon/`。この操作は利用者が手動で行う。

```bash
cd /Users/shizu/program/products/discord-bot/popon

# ON：BOT＋VOICEVOX＋Provider
YOUTUBE_POT_ENABLED=true docker compose -p popon-pot \
  -f compose.yaml -f compose.pot.yaml up -d --build

# OFF：同じ比較イメージで従来クライアント／Provider不使用に切り替える
YOUTUBE_POT_ENABLED=false docker compose -p popon-pot \
  -f compose.yaml -f compose.pot.yaml up -d popon
```

ComposeによるBOT起動では、従来どおり利用者の`.env`からDiscord設定を注入する。今回の実装・検証では`.env`を読んでいない。ComposeのPO用overlayはSQS URLを空、自動停止・異常時ECS操作をfalseへ上書きし、AWSとの通信を無効にする。コンテナ用yt-dlp/FFmpegパスも明示し、PC固有パスの混入を防ぐ。

Providerはホストポートを公開しない。内部`pot`ネットワークに加え、Googleとの通信のため外向き通信ができる`default`ネットワークにも参加する。`internal: true`のネットワークだけではToken生成に必要な外部通信ができない。既存のVOICEVOX用`tts`ネットワークは変更しない。

Providerの生ログはDockerの`logging.driver: none`で保存しない。診断はBOT側の固定フィールドJSONから行う。Providerを起動・停止する目的でDockerソケットをBOTへ渡すことはない。

## Discord/AWS認証情報なしの取得テスト

まず比較イメージをビルドし、Providerだけ起動する。

```bash
docker build --platform linux/amd64 \
  --build-arg 'YT_DLP_SPEC=yt-dlp[default]==2026.10.26' \
  --build-arg POT_PLUGIN_SPEC=bgutil-ytdlp-pot-provider==2.0.2 \
  -t popon:po-token-local .

docker compose -p popon-pot -f compose.yaml -f compose.pot.yaml up -d pot-provider

# 通信なしで同一venv・バージョン・GVS対応を確認
docker run --rm --network none --entrypoint /opt/media/bin/python \
  popon:po-token-local -B scripts/check-po-token.py

# ON：ユーザーが利用を許諾した動画で先頭10秒のPCMまで確認
docker run --rm --network popon-pot_default --cpus 1 --memory 768m \
  -e YOUTUBE_POT_ENABLED=true \
  -e YOUTUBE_POT_BASE_URL=http://pot-provider:4416 \
  --entrypoint node popon:po-token-local \
  dist/media/diagnose.js 'https://www.youtube.com/watch?v=lxk1UcXcLc8'

# OFF：Providerを使わない対照試験
docker run --rm --network popon-pot_default --cpus 1 --memory 768m \
  -e YOUTUBE_POT_ENABLED=false \
  --entrypoint node popon:po-token-local \
  dist/media/diagnose.js 'https://www.youtube.com/watch?v=lxk1UcXcLc8'
```

`docker run`で実行する上記プローブは`.env`・Discord Token・AWS認証情報を渡さず、BOTの`config.ts`も読み込まない。取得した音声は保存せず、先頭10秒をPCMとして消費して終了する。終了処理によるダウンロード中断は`state=cancelled`で区別する。

Provider停止時は次で確認する。停止後、上記ONのプローブを再実行すると、YouTube取得前に`pot_provider_unavailable`になる。検証後は必要に応じて`start pot-provider`で再開する。

```bash
docker compose -p popon-pot -f compose.yaml -f compose.pot.yaml stop pot-provider
```

実Discordの確認を行う場合は、同じBOTがAWSとローカルから同時にVCを操作しない構成で利用者が実施する。Interactions Endpoint URLがAWS Lambdaを指すアプリでは、スラッシュコマンドはローカルのGatewayには届かない。この設定や認証情報は今回変更していないため、実Discordへのログイン・VC実再生のON/OFF比較は未検証。

## Dockerを使わずBOTを動かす場合

既存のローカルvenvを使う場合は、利用者が次を実行できる。従来のsetupと同様に`.tools/media`を作り直す操作であり、今回ホストでは実行していない。

```bash
python3 scripts/setup-media.py --po-token
```

HTTP Providerは別途起動する。ホストへ公開する必要がある場合は`127.0.0.1:4416:4416`へ限定し、`YOUTUBE_POT_BASE_URL=http://127.0.0.1:4416`にする。Docker内ではホストのlocalhostをProviderのアドレスとして使わない。

## ログと判定

| イベント／分類 | 意味 |
| --- | --- |
| `youtube_pot_mode.enabled` | 機能のON/OFF。起動時・取得時 |
| `youtube_pot_provider.reachable` | `/ping`の接続と2.0.2版の確認 |
| `youtube_pot_result.pluginRecognized` | yt-dlp自身のHTTP Provider一覧で2.0.2を観測 |
| `gvsTokenRequested` | HTTP ProviderへのGVS Token生成／取得要求を観測 |
| `gvsTokenReceived` | yt-dlpがmweb用GVS Tokenを受領したことを観測 |
| `generationFailed` | ProviderによるToken取得失敗を観測 |
| `tokenOnGvsRequest` | ダウンローダーがToken付きメディアURLを使用したことを観測。URLは出力しない |
| `youtube_media_result` | メタデータの妥当性、音声の先頭バイト、ダウンロード完了／失敗／キャンセル |
| `provider_bot_check` | `Sign in to confirm / not a bot`。403を伴う場合もこちらを優先 |
| `http_403` + `stage=download` | 音声ダウンロード段階の403。Token生成成功とは別の結果 |
| `pot_provider_unavailable` | Providerに接続できない、応答が不正など。ON時は取得を開始せず失敗 |
| `pot_version_mismatch` | Providerと固定プラグインのバージョン不一致 |
| `pot_plugin_missing` | メタデータプロセスは成功したが、固定HTTPプラグインが認識されていない |

生のverbose出力は子プロセスのpipeからメモリ内で解析し、上記の真偽値・固定分類だけを出力する。`pot_trace`は有効にしない。Cookie、Token実値、レスポンス本文、署名付きメディアURL、任意の例外文字列をログへ転送しない。メタデータ上限4 MiB・stderrの保持上限・既存の有限リトライ・取得期限を維持する。

Tokenの「受領」は新規生成またはProvider内キャッシュからの取得を含む。`youtube_pot_result.ok`はそのyt-dlpプロセスの終了結果であり、実再生成功を保証しない。再生の証拠には`media_probe_result`のPCM取得、または実Discord再生の確認を使う。

## 今回の実測結果

対象はユーザー指定の`lxk1UcXcLc8`。同じ比較イメージ、同じDockerネットワーク、1 CPU・768 MiB、Cookie等なしで各1回実施した。外部IPの一致までは測定していない。

| 確認項目 | 結果 |
| --- | --- |
| Provider起動・コンテナ間`/ping` | 成功、2.0.2 |
| yt-dlp／EJS／プラグイン互換性 | 成功、2026.10.26／0.8.0／2.0.2 |
| PO ON：プラグイン認識 | メタデータ・ダウンロード双方で成功 |
| PO ON：GVS Token要求・受領 | 両段階で観測、取得失敗の観測なし |
| PO ON：メタデータ | 成功 |
| PO ON：音声取得 | **Token付きGVS要求後にHTTP 403、終了1、PCM 0バイト**。全体約20.5秒 |
| PO OFF：メタデータ・音声・PCM | **先頭10秒成功**、1,945,632バイト、全体約23.6秒、終了0 |
| Providerを停止してPO ON | `pot_provider_unavailable`、約0.4秒で終了。YouTube取得は開始しない |
| OOM kill | ON/OFFとも増分0 |
| BOT起動ON/OFF | Discordログインをモックした起動・コマンド登録テストで確認 |
| 実Discordログイン・VC再生・VOICEVOX実サイドカー | 未検証。実認証情報を使用していない |

ONは`mweb`、OFFは従来の自動クライアント選択なので、Tokenだけでなくクライアント選択にも差がある。今回の結果だけでTokenが403の原因だと断定しない。**Provider連携の導入は確認できたが、mweb＋PO Token条件の音声取得は成功していない。既定はfalseのままとする。** Cookie、別クライアントへの暗黙フォールバックなどで失敗を隠していない。

回帰検証では、型チェック、lint、キュー、キャンセル、コマンド、VOICEVOX API、実FFmpeg、Mixer、Discord Opus/AudioPlayerのローカルテストを実施した。これらは実Discord接続を代替しない。

回帰テストは23ファイル・187件成功（スキップなし）。Dockerビルド、同一venvの互換性チェック、`.env`展開を無効にしたCompose構成チェックも成功。テスト用の`popon:po-token-tests`は検証依存を含むため、BOT配布用には使わない。

## AWSへ反映する場合に必要となる作業（今回は未実施）

利用者の別途承認後に、プラグイン入りBOTイメージ、Providerのサイドカー、Provider到達先、必要なCPU/メモリ・外向き通信、Provider readinessをタスク定義で検討する。Fargateの同一タスクなら`YOUTUBE_POT_BASE_URL=http://127.0.0.1:4416`を候補とする。音声取得の変更なのでLambda・SQSメッセージ形式を変更する必要はない。既存VOICEVOXサイドカーは維持する。

**ローカルでTokenを生成・受領できても、AWSからのHTTP 403やIPベースのログイン要求が解消する保証はない。** 公式READMEも同じ制約を説明している。今回もToken受領後の403が残ったため、この状態を本番への移行完了とは扱わない。

参考: [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)、[bgutil README](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)、[YouTube Extractor](https://github.com/yt-dlp/yt-dlp/wiki/Extractors)
