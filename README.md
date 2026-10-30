# ぽぽん

## 概要

DiscordのVC付属チャットを読み上げながら、YouTube動画の音声をキュー順に再生するBotです。読み上げ中は動画の音量を下げ、終了後に滑らかに戻します。

音声合成にはローカルのVOICEVOX Engineを使用します。有料API・DB・LLMは不要です。

## コマンド一覧

| コマンド | 使い方 |
| --- | --- |
| `/join` | 参加中のVCにBotを呼び、読み上げを開始 |
| `/leave` | VCから退出し、再生と待ちリストを終了 |
| `/play <url>` | YouTube動画を再生待ちに追加 |
| `/pause` | 動画を一時停止（読み上げは継続） |
| `/resume` | 一時停止した動画を再開 |
| `/skip` | 現在の動画を破棄して次へ |
| `/list` | 再生中の動画と再生待ち最大20件をタイトル付きリンクで表示 |
| `/help` | 日本語の使い方を表示 |

通常のVCに参加して `/join` を実行し、準備完了後にVC付属チャットへ投稿してください。動画操作はBotと同じVCから実行します。

対応動画・読み上げ・音量の詳細は[利用ガイド](docs/usage.md)を参照してください。

## 使い方（開発者向け）

必要なもの：Node.js 22.12以上、FFmpeg、VOICEVOX Engine。動画再生にはPython 3.10以上とyt-dlpも必要です。

リポジトリのルートで実行します。

```bash
npm ci
cp -n .env.example .env
npm run setup:media
```

[設定ガイド](docs/configuration.md)に従ってDiscordアプリと `.env` を設定し、VOICEVOXを起動してから実行します。

```bash
npm run register
npm run dev
```

検証・ビルド：

```bash
npm run check
npm run build
```

ビルド済みBotは `npm start` で起動できます。

- [ローカルでの動作確認](docs/local-development.md)：VOICEVOXの起動、複数サーバーへの登録、確認項目、トラブルシュート
- [設定ガイド](docs/configuration.md)：Discord設定、環境変数、外部コマンド
- [内部構成](docs/architecture.md)：音声処理、キュー、リソース管理
- [運用・デプロイ](docs/operations.md)
- [検証記録](docs/validation.md)・[VOICEVOXのメモリ測定](docs/benchmarks/README.md)

音声合成：**VOICEVOX:ずんだもん**（既定話者）。利用条件・クレジットは[利用ガイド](docs/usage.md#利用条件とクレジット)を確認してください。
