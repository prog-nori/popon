# 検証記録（2026-10-25）

最新のメモリ制限・合成速度の実測は[VOICEVOXメモリ制限検証](benchmarks/README.md)を参照してください。以下の「未検証」は初回記録で、その後の追記と区別してください。

## 実施済み

- Mac / Node.js v24.4.1 / FFmpeg 6.0。
- 型チェック、ESLint、Vitest、TypeScriptビルド。
- 効果音原本と配置ファイルのバイト一致（cmp）。長さ1.6秒。
- @discordjs/voiceの実際のAudioResourceでWAV→Opus変換。81パケットを取得。
- DAVE依存 @snazzah/davey 0.1.12 のロードを確認。
- npm依存監査：更新後0件。Opusは互換性のあるopusscript 0.0.8を使用。

## 未検証・制限

- Discord認証情報未設定のため、実VC接続、DAVE通信、切断復帰、ユーザーの受聴は未検証。
- localhost:50021のVOICEVOX応答がなく、実際の起動・ウォームアップ・合成・コールドスタート性能は未計測。
- 10秒目標、READY後2秒目標の達成は未確認。
- インストール済みDocker CLIの `docker info` が内部エラーになり、コンテナのビルド・起動は未検証。
- OCI VMの作成・ARM64実行・UDP通信・無料枠確認は未実施。
- Composeはexternal常駐方式。自動起動・停止はホスト上のprocess方式で実装。

依存更新中にnpm 11.5.2のpeer依存解決が内部エラーになりました。npm 11.21.1の一時実行で解消しています。元の依存生成物は /private/tmp/popon-node-modules-before-update-20261025 と /private/tmp/popon-package-lock-before-update-20261025.json に退避しました。

## Docker実機確認の追記（2026-10-25）

Docker Desktop起動後、固定したVOICEVOX 0.26.0イメージを取得して起動しました。localhostの `/version` は0.26.0を返し、Botで使用するVoicevoxProviderで「ぽぽん やあ」（話者3）を2回合成し、86,060バイトのWAVを取得しました。合成所要時間は1,141ms / 1,561ms。コンテナ起動からのコールドスタート時間やDiscord受聴までの時間とは異なります。

公式イメージにpython3/curl/wgetがないことが判明したため、共通Composeのヘルスチェックをbash組込みのHTTPステータス確認へ変更しました。Docker CLIのmanifest inspect形式エラーは、今回のコンテナ取得・起動を妨げませんでした。

.envは一切読み取らず、VOICEVOX専用Composeを `--env-file /dev/null` で起動しました。Botのログイン・Discordでの受聴はこの確認には含みません。
