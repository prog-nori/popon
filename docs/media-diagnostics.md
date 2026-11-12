# Fargateでの音声取得・デコード診断

## 調査結果（2026-11-04）

対象は `https://www.youtube.com/watch?v=ez8Uv-pi0Jg`。AWSリソースは変更せず、`.env`・Cookie・Discord/AWS認証情報は使用していない。

ローカルのv2相当イメージ `popon:aws-check` の実行ファイルを起動して確認した結果:

| ツール | 実行ファイル | 確認したバージョン |
| --- | --- | --- |
| Node.js | `/usr/local/bin/node` | 24.22.2 |
| yt-dlp | `/opt/media/bin/yt-dlp` | 2026.10.26 |
| yt-dlp-ejs | `/opt/media` のPythonパッケージ | 0.8.0 |
| FFmpeg | `/usr/bin/ffmpeg` | 5.1.9-0+deb12u1 |

yt-dlpのパッケージメタデータでも `yt-dlp-ejs==0.8.0` を要求しており、インストール済み版と一致した。
既存の `--js-runtimes node:<process.execPath>` は有効な設定で、Dockerfileの `yt-dlp[default]` はEJSを含む。
Nodeは公式EJSガイドの最低22.0.0を満たしている。別の言語・ランタイム・ライブラリの追加は不要。
[公式EJSガイド](https://github.com/yt-dlp/yt-dlp/wiki/EJS)

| 試行 | 実測結果 |
| --- | --- |
| 512 MiB・0.25 CPU、旧コード | メタデータ取得が30秒の上限で停止。FFmpeg起動前 |
| メタデータのみ、CPU制限なし | 約5.5秒で成功 |
| メタデータのみ、0.25 CPU | 約23秒で成功。試行ごとに変動 |
| 512 MiB・CPU制限なし、診断 | 取得＋10秒分のPCMデコード成功、約24秒、コンテナのピーク約317 MiB、OOM kill 0 |
| 512 MiB・0.25 CPU、修正後の診断 | 取得＋10秒分のPCMデコード成功、約52秒、ピーク約316 MiB、OOM kill 0 |
| 修正後にビルドした `popon:media-check`、512 MiB・0.25 CPU | 同じ診断に成功、約55秒、ピーク約322 MiB、OOM kill 0 |

旧診断の全体60秒制限では、低CPU時に約4秒分のPCM取得後に制限へ達した試行もあった。
メタデータ上限を30→90秒、診断全体の上限を180秒に変更した。スキップ・退出による中断は維持している。
**30秒の上限が低CPU時に不足する問題は再現したが、Fargateで起きた失敗の原因までは断定していない。**
Dockerの `--cpus` は厳しい上限を課す比較条件であり、CPUを共有するFargate＋VOICEVOX構成そのものの再現ではない。
この診断はBOT本体・VOICEVOX・Discordへの送信を含まない。配信元の状態も試行時刻・送信元IPによって変わる。

## 既存処理とエラーの発生経路

1. `src/media/youtube.ts:youtubeURL` がHTTPSのYouTube単体動画URLを検証し、動画IDだけの標準URLへ変換。
2. `YoutubeAdapter.open` がyt-dlpの `--dump-single-json --skip-download` でメタデータを取得。
   公開・通常動画・2時間以内の既存条件を維持。JSONや署名付きメディアURLは出力しない。
3. yt-dlpを再実行し、`-f bestaudio -o -` で音声をstdoutへ出力。署名付きURLを保存・再利用する実装はない。
4. `src/audio/process.ts:decode` がパイプからFFmpegへ渡し、48 kHz・stereo・s16le PCMへ変換。
5. `src/media/queue.ts` → `src/audio.ts:playMedia` → `Mixer` → `@discordjs/voice` のAudioResource/Opus → Discord VC。
   読み上げとのミキシング・ダッキング・メモリ上の再生待ちキューは維持。

従来の `media_error` は `MediaQueue.drain` のcatchで発生していた。
メタデータ取得・JSON解析・ダウンロード・デコード・ミキサーの例外を同じ場所で受け取る。
外部コマンドの非0終了、終了シグナル、タイムアウト、JSON解析エラーなどは同じ汎用通知になり、終了コードだけでは段階を特定できなかった。
特に子プロセスをシグナルで終了するとexit codeは `null` になり、元の実装はシグナルを失っていた。
対応外動画の `MediaError` と実行ファイル不在 `ENOENT` は別の案内を出す。

## 安全な診断表示

| 今回の変更ファイル | 内容 |
| --- | --- |
| `src/media/youtube.ts` | メタデータ取得上限90秒、JSONの安全な検証、上流・下流エラーの識別 |
| `src/audio/process.ts`・`src/audio/failure.ts` | 子プロセスの段階・分類・終了コード・シグナル。生stderrを例外に含めない |
| `src/media/queue.ts`・`src/media/dependencies.ts` | Discordへの安全な診断通知、構造化したmedia_error、既存キュー継続 |
| `src/media/diagnose.ts`・`src/media/diagnostics.ts` | 認証情報なしのDocker診断、ツール版とcgroupメモリの確認 |
| `tests/media-diagnostics.test.ts`・`tests/youtube-diagnostics.test.ts` | 分類・終了・秘密情報非出力・二次エラーの誤診防止 |
| `README.md`・`docs/media-diagnostics.md`・`docs/validation.md` | 手順・結果・未確認事項 |

失敗時はDiscordの通常通知にも、例えば次の固定コードを付加する。CloudWatchは不要。

```text
診断: <照合ID> stage=download class=http_403 exit=1 signal=none oomKills=0
```

`media_error` のJSONには同じ照合ID、tool、elapsedMs、メモリ数値も含める。
stderrは最大4096文字をプロセス内で分類にだけ使い、例外・通知・ログには渡さない。
実行引数、Cookie、トークン、署名付きURL、メタデータJSONも含めない。
ダウンロード失敗でFFmpegが二次的に失敗した場合は、最大1秒待って判明した上流の分類付き非0終了を優先する。
分類できない非0終了（FFmpeg停止に伴うbroken pipe等）は、元のデコード失敗を上書きしない。
全ての未知の失敗を分類できるわけではなく、該当しないものは `process_exit` / `unknown` とする。

| stage / class | 切り分け |
| --- | --- |
| metadata / timeout | yt-dlpによる抽出が90秒以内に完了しない。CPU競合、JS challenge、通信遅延を比較 |
| metadata・download / http_403 | 配信元からの拒否。認証・地域・送信元IP・形式・署名失効等を含み、403だけではどれかを確定できない |
| provider_restriction | Bot判定・ログイン要求・年齢・地域・公開範囲等の制限を示すエラー |
| http_429 | リクエスト数の制限。連打・無限再試行は避ける |
| dns / network / timeout | DNS名前解決、接続・証明書、時間切れ。実行環境間で比較 |
| javascript_challenge | Node/EJSの存在・互換性・配信元側の変更を確認 |
| format_unavailable | yt-dlpが要求する音声形式を取得できない。動画の利用可否と抽出を確認 |
| decode / invalid_media | FFmpegが入力を解釈できない。上流取得失敗も確認 |
| killed + SIGKILL | 強制終了。OOMの可能性はあるがSIGKILLだけでは断定しない |
| oomKills が正数 | このコマンド処理中にコンテナcgroupのOOM killが増えた。他の同居プロセスの可能性もある |
| missing_executable / permission_denied | Docker内の実行ファイル・実行権限・パス指定を確認 |
| playback | PCM取得後のミキサー・音声出力の失敗。取得/デコード診断と分ける |

`memoryPeakBytes` はコンテナ生存期間のピーク、`nodeRssBytes` はNodeのみ（子プロセスを含まない）。
cgroupの種類・公開範囲によって取得できない値は `null`。OOM回数はcgroup v2のみ取得する。
BOT自体がSIGKILL/OOMで終了した場合はDiscord通知できないため、ECSの停止したタスクの理由・各コンテナ終了コードをコンソールで確認する。
終了137はSIGKILL相当だが、OOMの断定には停止理由等も必要。

## ローカルDockerで指定URLを再現

`popon/` で実行。`.env` や秘密情報は渡さない。BOT用CMDを診断専用コマンドで上書きする。
既存のDockerfileを使い、検証したyt-dlpの版を指定する。新しいホスト側ツールは不要。

```bash
docker build --platform linux/amd64 \
  --build-arg 'YT_DLP_SPEC=yt-dlp[default]==2026.10.26' \
  -t popon:media-check .

docker run --rm --memory 512m --memory-swap 512m --cpus 0.25 \
  --entrypoint node popon:media-check \
  dist/media/diagnose.js 'https://www.youtube.com/watch?v=ez8Uv-pi0Jg'
```

`media_probe_start` でバージョン・実行可能性・リソースを、`media_probe_result` で成功/失敗を確認する。
`ok:true, sampleComplete:true` は先頭約10秒分の音声取得とPCMデコード成功を示す。Discord送信や動画全編の成功を示さない。
短い動画は10秒未満でもPCMがあれば `ok:true, sampleComplete:false` になり得る。
診断は最大180秒で中断する。音声ファイルは保存しない。
CPU比較は `--cpus 0.25` だけを外し、メモリ比較は512→768 MiB等でローカルで行う。

ECS Execが既に有効で利用できる場合、更新後のBOTコンテナで同じ `node dist/media/diagnose.js '<動画ページURL>'` を実行すると、
CloudWatchなしでもAWS側の環境で比較できる。既に再生中なら診断は追加負荷になるため音楽を停止して行う。
未設定の場合は勝手にExecやIAM/VPCを変更せず、まずDiscordの診断コードを使う。

## ローカル成功・Fargate失敗の場合

- 同じイメージdigest・同じツール版・同じ動画・近い時刻で比較する。ECRタグだけでは実行中タスクの切り替えを保証しない。
- VOICEVOXとDiscordが動くことは、YouTube・メディアCDNへの通信成功を保証しない。DNS、外向き443、ルート/NATまたはPublic IP、SG/NACL、TLS時刻等を読み取り確認する。
- `http_403` / `provider_restriction` がAWSだけなら送信元IPや地域・配信元制限が候補。同じコード変更だけで解消するとは限らない。
  Cookie・プロキシ・ブラウザ認証の自動追加や制限回避はしていない。
- メディアURLはyt-dlpがダウンロード時に再取得しており、メモリキューには動画ページURLだけを保持する。
  保存済み署名URLの期限切れはこの実装では考えにくいが、長い一時停止・配信中断・配信元の拒否による403は別途あり得る。
  メディアURL自体をログへ出さず、再生し直して新しい抽出でも再発するか確認する。
- 512 MiBはBOT＋Node製JS solver＋yt-dlp＋FFmpegで共有するハード上限。
  VOICEVOXの1.5 GiB分はBOTの512 MiB超過を補わない。
  単体診断でOOMがなくてもDiscord・複数ギルド・TTS併用時の十分性は未確認。
  [AWSメモリ設定](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
- コンテナCPUはFargateで共有・競合する。CPU不足は通常、即座の終了コードではなく抽出の遅延・再生途切れ・時間切れとして現れる。
  [AWS CPU制御](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-cpu-memory-error.html)

## AWSへの反映順序（利用者が実施）

追加の環境変数・依存ライブラリ・AWSリソースは不要。DockerfileとVOICEVOXの設定も今回変更していない。

1. 上記イメージで診断が成功することを確認する。
2. ECRがImmutableなので未使用のタグ（例 `v3-media-fix`）へtag/pushする。既存タグを再利用しない。
3. タスク定義を新しいリビジョンとして作り、**BOTコンテナのimageだけ**を新タグへ変更する。
   VOICEVOXコンテナ、既存の環境変数・シークレット参照・CPU/メモリ・IAMは維持。
4. ECSサービスへ新リビジョンを指定し、起動中なら置換して実行タスクのimage digestを確認する。
5. `/join` → `/play <対象URL>`、読み上げとの併用、`/skip`、`/pause`・`/resume`、`/stop` 後の再生を確認する。
6. 失敗した場合はDiscordの固定診断コードを確認する。未知コードのままリソースを増量せず、必要な切り分けを行う。

ECRへのpushコマンド例（タグが未使用であることを確認してから実施）:

```bash
aws ecr get-login-password --region ap-northeast-1 | \
  docker login --username AWS --password-stdin 161063896786.dkr.ecr.ap-northeast-1.amazonaws.com
docker tag popon:media-check 161063896786.dkr.ecr.ap-northeast-1.amazonaws.com/discord-bot:v3-media-fix
docker push 161063896786.dkr.ecr.ap-northeast-1.amazonaws.com/discord-bot:v3-media-fix
```

AWS反映・ECR push・タスク定義やサービスの変更・実Discord VCでの受聴は、この調査では実施していない。
