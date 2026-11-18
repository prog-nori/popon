# ニコニコ動画の音声再生

作業ブランチ：`feature/niconico-playback`。ローカル実装のみ。AWS、Discordのコマンド登録、commit・pushは実行しない。

## 設計と変更箇所

既存の`MediaQueue`はサービスに依存しない。`VideoAdapter`でURLに対応したアダプターへ振り分け、既存のFFmpegデコード・Mixer・Discord送信を使う。

```text
/play URL（GatewayまたはLambda→SQS）
  → ホスト・パスの検証と正規URL化
  → 既存のVC参加・MediaQueue
      → YouTube: 既存YoutubeAdapter（Cookie・PO Tokenは従来どおり）
      → ニコニコ: NiconicoAdapter
          → yt-dlpのNiconico Extractorでメタデータ取得（skip-download）
          → 音声専用形式を選択して標準出力へストリーミング
  → 既存FFmpegで48kHz・ステレオPCMへ変換 → 既存Mixer → Discord
```

| ファイル | 変更内容 |
| --- | --- |
| `src/media/niconico.ts` | URL検証、メタデータ、音声専用ストリーム、制限・失敗の分類と安全なログ |
| `src/media/router.ts` | ホストによるYouTube/ニコニコの振り分け |
| `src/index.ts` | playのURL検証・アダプターを振り分け対応に変更。起動・停止・VC・TTSは維持 |
| `src/media/youtube.ts` | 共通インターフェースへ任意のmetadataフィールドを追加。YouTube取得処理は変更しない |
| `src/media/queue.ts` | 取得したID・タイトル・時間を既存ジョブに保持。削除したジョブのタイトル取得もキャンセル |
| `src/audio/failure.ts` | 削除・利用不可を示す`media_unavailable`分類を追加 |
| `src/register.ts` | playの説明にニコニコ動画を追加。コマンド名・引数形式は維持 |
| `src/media/diagnose.ts` | 既存の安全な10秒音声診断をニコニコにも対応 |
| `tests/niconico.test.ts` | URL、メタデータ、形式・制限、引数、認証分離、エラー・上限のモック検証 |
| `tests/media-router.test.ts` | サービス振り分け、混在キュー、失敗からの継続、停止・スキップ |
| `tests/niconico-stream.test.ts`, `tests/fixtures/niconico-yt-dlp.py` | 自作音源を用いた実yt-dlp Niconico HLS解析・音声選択・FFmpeg・PCMの結合検証 |
| `tests/session.test.ts`, `tests/media-list.test.ts` | SQSからのニコニコplay自動参加・再生・削除、タイトル取得のキャンセル |
| `docs/niconico-playback.md`, `docs/usage.md` | 動作・制限・検証方法 |

追加依存パッケージ、常駐プロセス、コンテナ、AWSサービス、環境変数はない。既存のyt-dlpとFFmpegを使用する。Dockerfile・package.json・lockfile・Lambda・Cookie/PO Token・VOICEVOX・Mixer・ECS停止処理は変更しない。

## 対応範囲

- `https://www.nicovideo.jp/watch/sm12345678`
- `https://www.nicovideo.jp/watch/so12345678`
- `https://nico.ms/sm12345678`
- `nicovideo.jp`のwwwなし、`nm` ID、従来の数字だけの動画IDも受け付ける。
- HTTPSのみ。ユーザー名/パスワード、標準外ポート、別ホスト、プレイリスト、ニコ生、追加パスは拒否する。
- `nico.ms`はパスの動画IDから`https://www.nicovideo.jp/watch/ID`を構成し、短縮URLのリダイレクトにはアクセスしない。クエリ・フラグメントは除去する。
- yt-dlpも`--use-extractors Niconico$`で限定する。API/CDNへのアクセスとその通常のリダイレクトは信頼したNiconico Extractor/FFmpegが処理する。全配信先IPをアプリで検証する構成ではないため、実行ファイルと配信元が信頼できることが前提。
- 認証不要の公開動画、再生時間が0秒より長く2時間以内、音声専用形式がある動画のみ。公開so動画も条件を満たす場合に限る。
- 認証・有料会員・チャンネル会員・購入・年齢認証が必要な動画、非公開・削除・DRM・地域制限などは取得しない。ニコニコ用Cookieやログインは実装しない。
- YouTubeとニコニコを同じメモリ上のキューに登録でき、失敗時は既存通知・後続への移行を使う。

## 音声専用形式とHLS

[yt-dlpのNiconico Extractor（2026.10.26）](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/extractor/niconico.py)を確認した。ゲスト用watch API、HLSアクセス権API、マスタープレイリストから形式を取得し、`vcodec == none`の音声をAACとして扱っている。

Botはメタデータと取得の両方で`-f bestaudio[vcodec=none][acodec!=none]`を指定する。メタデータの選択結果も音声専用か再確認する。音声形式がない場合は失敗とし、`best`などの映像付き形式へ切り替えない。メタデータの段階でもAPIやHLSマニフェストの取得は必要だが、メディア本体はダウンロードしない。

HLSは`--downloader m3u8:ffmpeg`、`-o -`でストリーミングする。既存FFmpegをコピー処理のダウンローダーとして使い、その出力を既存のPCMデコーダーへ渡す。FFmpegの入力に15秒のrw_timeout、出力に`-vn`を指定する。yt-dlpのnative HLSは標準出力モードでも断片ファイルを作るため、この方式を選んだ。動画全体の保存や音声の全量取得完了を待つ処理はない。

ログには固定のイベント・段階・エラー分類・終了コードだけを出し、生stderr・メタデータJSON・署名付き配信URL・Cookie・Tokenは出さない。YouTube Cookie/PO Token設定がONでも、ニコニコ側の引数には渡さない。

## タイムアウト・終了処理

- メタデータ：最大30秒、JSONは4MiBまで。リスト用のタイトル取得は既存と同じ最大8秒。
- 小さいタスクで多数のPythonプロセスを同時起動しないよう、リスト用のニコニコタイトル取得はセッションごとに同時1件まで。処理中の他の項目は既存のURL表示へ戻し、次のリスト表示時に再取得する。再生用の取得はこの制限で待たせない。
- yt-dlp：socket timeout 15秒、再試行2回。HLS外部FFmpegには入力rw_timeout 15秒を指定し、無制限の再試行は追加しない。
- 既存キューの1曲125分の実時間上限を維持する。一時停止時間も含む。
- 停止・スキップ・退出・取得/デコード失敗では既存AbortSignalと子プロセス所有権を利用する。POSIXのプロセスグループによりyt-dlp配下のFFmpegも終了させる。
- タイトル用メタデータも、その曲のスキップ・停止・完了・セッション終了でキャンセルする。
- `niconico_media_result`と既存`media_error`でmetadata/download/decode等を区別する。削除は`media_unavailable`、認証・会員等は`provider_restriction`、403・DNS・timeout等は既存分類を使用する。Discordには既存の安全な通知と診断コードを出す。

## ローカル検証

通常の開発環境では既存スクリプトを実行する。

```bash
npm run typecheck
npm run lint
npm test -- --maxWorkers 1
npm run build
```

ホストにNode.jsがない今回の環境では、既存の開発用イメージ`popon:youtube-cookies-tests`にsrc/tests/lambdaだけをマウントし、`--network none`で検証する。実.env・認証情報はマウントしない。結合テストはDocker内のloopbackで自作テスト音をHLS配信し、実yt-dlp 2026.10.26のNiconico形式解析・選択とFFmpegを実行する。watch/access API応答だけはfixtureへ置き換える。実サイトの現行APIとの疎通を証明するテストではない。

2026-11-18の最終結果：**30ファイル・406テスト成功**。`npm run typecheck`、`npm run lint`、`npm run build`も成功。実行環境はLinux/amd64、Node.js 24.22.2、yt-dlp 2026.10.26、FFmpeg 5.1.9。Cookie/PO Token・Mixer・SQS・Lambda起動・自動停止の既存テストを含む。既存の実時間音声出力テストは初回に5秒の待機上限を超過したが、個別再実行と最後の全件実行では成功した（当該テストや音声出力処理は変更していない）。ビルド検証はDocker内で行い、本番用Botイメージの再ビルドは行っていない。

実サイトの音声取得を確認するときは、取得・再生の許諾がある公開動画を指定する。次の診断は既存Bot TokenやDiscord接続を使わず、音声取得とPCMの先頭10秒を検証する。

```bash
node dist/media/diagnose.js 'https://www.nicovideo.jp/watch/許諾のある動画ID'
```

成功時は`media_probe_result.ok=true`と`pcmBytes > 0`を確認する。Token生成やメタデータ成功だけで音声成功とは判断しない。ニコニコ実サイト・実Discordでの再生は別途確認が必要。

## AWS Fargateで後から確認する場合

今回はビルド・push・デプロイを行わない。後からBotイメージをLinux/amd64で再ビルドし、現在の正常動作中のタスク定義を基準にBotコンテナのイメージだけ更新する。yt-dlpとPOプラグインのバージョンは正常動作版に合わせて固定し、YouTubeの動作を比較できるようにする。Provider/VOICEVOXのイメージや設定、Cookieシークレット、起動停止環境変数は維持する。

Lambda・SQSメッセージ形式、IAM権限、ECSリソース、追加環境変数の変更は不要。`/play`の既存url引数を使うためコマンド再登録なしでも動作する。Discord上の説明文も更新したい場合だけ、利用者が既存`npm run register`を実行する。

1. 安全な診断でニコニコのメタデータ・音声取得・PCMまでを確認する。
2. `/play`で起動・VC自動参加・ニコニコ音声再生を確認する。
3. YouTube→ニコニコ→YouTubeの混在、pause/resume・skip・stop・leaveを確認する。
4. 読み上げとの混合、無人タイマー・ECS停止、YouTube Cookie/PO Tokenに回帰がないか確認する。

ローカルで成功しても、Fargateの送信元・地域・レート制限や配信元の変更により失敗する可能性がある。実環境でのアクセス成功は保証しない。利用可能なコンテンツだけを扱い、サイトの利用条件と権利者の許諾に従う。
