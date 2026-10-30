# ローカルでの動作確認

[README](../README.md) · [設定ガイド](configuration.md) · [利用ガイド](usage.md) · [検証記録](validation.md)

以下のコマンドはリポジトリのルートで実行します。Node.js 22.12以上、FFmpeg、動画用のPython 3.10以上を用意し、READMEの依存導入と `.env` の設定を済ませてください。

## VOICEVOXの起動

Dockerを使う場合は、Docker EngineとComposeを起動して確認します。

```bash
docker version
docker compose version
docker compose --env-file /dev/null -p popon-local -f compose.local.yaml pull
docker compose --env-file /dev/null -p popon-local -f compose.local.yaml up -d
docker compose --env-file /dev/null -p popon-local -f compose.local.yaml ps
curl --fail http://127.0.0.1:50021/version
```

VOICEVOXが `healthy`、APIが `"0.26.0"` を返すことを確認します。起動直後にAPIへ接続できない場合は少し待って再実行してください。

ローカルとサーバーは `compose.voicevox.yaml` の固定イメージを共有します。APIの公開先は `127.0.0.1:50021` です。Docker側では `.env` を読み込みません。他のアプリが同じポートを使っている場合は先に停止してください。

Dockerを使わない場合はVOICEVOXアプリまたはEngineを別途起動し、同じAPIが応答することを確認します。BotによるEngineの自動起動は[processモード](configuration.md#voicevoxの起動方式)を利用します。

## コマンド登録

`.env` の `DISCORD_GUILD_ID` が設定済みなら、そのサーバーだけに登録します。

```bash
npm run register
```

複数のテストサーバーを使う場合は、各IDに置き換えて実行します。コマンド先頭の環境変数は `.env` より優先され、ファイル自体は変更しません。

```bash
DISCORD_GUILD_ID=サーバー1のID npm run register
DISCORD_GUILD_ID=サーバー2のID npm run register
```

グローバル登録は `DISCORD_GUILD_ID` を空にして行います。グローバルとサーバー別のコマンドは別管理なので、一方の登録で他方の古い定義は消えません。登録先は `src/register.ts` で決まります。

## Botの起動と終了

```bash
TTS_MODE=external VOICEVOX_URL=http://127.0.0.1:50021 npm run dev
```

Botは認証情報のため `.env` を読み込みます。`bot_ready` のログを確認し、ターミナルを開いたままDiscordで操作します。`external` ではEngineは常駐し、`/leave` による停止や `/join` によるコンテナ起動は行いません。

終了はBotのターミナルでCtrl+Cを押し、Dockerで起動したEngineを停止します。

```bash
docker compose --env-file /dev/null -p popon-local -f compose.local.yaml down
```

同じBotトークンで複数プロセスを起動しないでください。

## 自動チェック

```bash
npm run check
npm run build
git diff --check
```

型・Lint・自動テストを確認します。音声統合テストにはFFmpegが必要です。未導入時は一部がスキップされるため、結果を確認してください。自動テストは実Discordへの接続や受聴の代わりにはなりません。

## Discordでの確認項目

1. 通常VCで `/join` を実行し、準備完了音と完了通知を確認する。
2. VC付属チャットに「テスト」や辞書に登録した単語を投稿し、表示名と本文が最後まで順番に読まれることを確認する。
3. 利用可能な動画を `/play` で2本追加する。順番に再生され、再生中の投稿も読まれることを確認する。
4. 読み上げ中だけ動画が減衰し、終了後に滑らかに復帰することを確認する。
5. `/pause` 中も読み上げが続き、`/resume` で動画が再開することを確認する。
6. `/skip` を再生中・取得中・一時停止中に試し、後続へ進むことを確認する。
7. `/list` のタイトルリンク・順番、`/help` の表示を確認する。
8. 取得不能な動画の後にも正常な動画が再生され、読み上げが継続することを確認する。
9. 再生中や準備中の `/leave`、無人退出、再参加、接続切断を確認する。取得・デコードの子プロセスが残らないことも確認する。
10. 2サーバーで同時利用し、一方の退出や失敗が他方へ影響しないことを確認する。

## ログとトラブルシュート

ログはJSON形式です。投稿本文やトークンは出力しません。

| ログ | 確認する内容 |
| --- | --- |
| `bot_ready` | Discordへのログイン完了 |
| `tts_state` / `tts_ready` | Engine準備状態・ウォームアップ時間 |
| `join_ready` | VC接続開始から準備完了音終了までの時間 |
| `speech_started` | 投稿から送信位置到達までの時間（端末での受聴時刻とは異なる） |
| `synthesis` / `playback` | 合成・再生所要時間 |
| `media_queued` → `media_fetching` → `media_started` → `media_finished` | 動画キュー・取得・送信開始・出力完了 |
| `media_error` / `tts_warmup_error` / `audio_output_error` / `connection_error` | 動画・合成・共有出力・VC接続の障害 |

| 症状 | 確認・対処 |
| --- | --- |
| `Used disallowed intents` | Developer Portalで実行中BotのMessage Content Intentを有効化・保存して再起動 |
| コマンドが見えない・古い | アプリID・サーバーID・招待スコープを確認して該当スコープへ再登録。Discordも再読み込み |
| 投稿が読まれない | Message Content Intent、VC付属チャットへの投稿か、閲覧権限を確認 |
| 音が出ない | Connect/Speak権限、サーバーミュート、FFmpeg、UDP通信を確認 |
| `/join` の準備失敗 | VOICEVOXの `/version`、話者ID、実行パスを確認。外部Engineへの接続確認は最大5秒 |
| `spawn yt-dlp ENOENT` | `npm run setup:media` を実行して再起動。`YT_DLP_PATH` があれば実行ファイルの位置を確認 |
| 次の動画へ進まない | `media_finished` の後に次の `media_fetching` があるか、関連エラーログを確認 |
| Dockerへ接続できない | Docker Engineの起動状態と `docker context ls` を確認 |
| 効果音が出ない | `ready_sound_error` と `READY_SOUND_PATH` を確認 |

VOICEVOXコンテナのログ：

```bash
docker compose --env-file /dev/null -p popon-local -f compose.local.yaml logs --tail=100 voicevox
```
