# 運用・デプロイ

[README](../README.md) · [ローカルでの動作確認](local-development.md) · [設定ガイド](configuration.md)

## 起動方式の比較

|方式|利点|制約|
|---|---|---|
|BotとEngineをホスト上で実行、processモード|オンデマンド起動・10分後停止、Docker権限不要|Engine実行ファイルをホストに配置|
|Compose、externalモード|BotとEngineの環境を分離、起動順とヘルスチェックあり|Engineは常駐。自動停止はしない|

MVPの省資源運用はローカルprocess方式です。Linuxでは専用ユーザーのsystemdサービスでBotを常駐させ、Botの子プロセスとしてEngineを動かします。BotにDockerソケットやsudo権限を付けません。Composeでもオンデマンド制御したい場合は、固定のEngineサービスのみ操作できるホスト管理プロセスを追加する必要があります。この管理APIは現版には実装していません。

## Composeでの手動運用

`.env` を用意してから：

```bash
docker compose up -d --build
docker compose logs -f popon
# 利用しないとき
docker compose down
```

VOICEVOX APIは内部ネットワークだけで公開ポートを持ちません。Botのみ外向きネットワークへ接続します。EngineのHTTPヘルスチェック後にBotを起動し、join時にはさらにウォームアップ合成でREADYを判定します。秘密情報はGitに含めず `.env` へ保存し、`chmod 600 .env` としてください。

ローカルとサーバーは `compose.voicevox.yaml` の公式CPU版0.26.0 / Ubuntu 24.04と同じmanifest digestを使用します。AMD64・ARM64対応を公式レジストリで確認済みです（2026-10-25）。版の更新はこの共通ファイル1か所で行い、ローカルで再検証してからサーバーへ反映してください。`.env` の `VOICEVOX_IMAGE` による上書きは使用しません。

ローカル手順は[ローカルでの動作確認](local-development.md)を参照してください。本番ComposeはAPIをホストに公開せず、ローカルComposeだけが127.0.0.1:50021に公開します。Botも同じLinuxコンテナで試す場合は上記の本番Compose手順をローカルでも使用できますが、ホストのBotを先に停止し、同じBotトークンで二重起動しないでください。その場合、ComposeはBotに渡すため `.env` を読み込みます。

以下のsystemd/process手順はDockerを使わない省資源運用の選択肢です。ローカルDockerとのEngine環境の統一を優先する場合は、サーバーでも上記Compose方式を使用してください。

## OCI ARM64での手動構築

この手順は未実施です。実構築時に[Always Free公式資料](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)で無料枠・在庫・アイドル回収条件・規約を再確認します。目安はAmpere A1、2 OCPU / 12GB RAM、Ubuntu 24.04 ARM64、ブート50GBですが、無料で確保できる保証はありません。負荷を人工的に作って回収を回避しません。

1. Always Free対象と表示されたVM・ストレージ構成を確認し作成します。SSHは管理元IPに制限。
2. Node.jsの対応版、FFmpeg、Engine実行に必要なライブラリを導入します。
3. 専用ユーザー `popon` と `/opt/popon` を用意し、ソース・lockfile・音源・辞書を配置。`npm ci && npm run check && npm run build` を実行します。
4. 公式Linux CPU ARM64 Engineを展開し、`.env` で `TTS_MODE=process` と実行ファイルの絶対パスを指定。Engineは `127.0.0.1:50021` にbindします。
5. `docs/popon.service` をsystemdのサービス定義として配置。Nodeのインストール先に応じて `ExecStart` を調整します。
6. `sudo systemctl daemon-reload`、`sudo systemctl enable --now popon`。`journalctl -u popon -f` で起動を確認。
7. DNS・HTTPS/WSSの外向き通信とDiscord Voice向けUDP送信・応答を、OCIのNSG/セキュリティリストとOSファイアウォールの双方で確認。固定のDiscord IPに決め打ちしません。50021や3000はインターネットへ開けません。
8. [ローカルと同じ確認項目](local-development.md#discordでの確認項目)を実施し、DAVE接続・受聴・コールド起動時間・CPU使用状況を記録します。

## 更新と復旧

更新前に動作中リリースとlockfileを保存し、別ディレクトリでビルド・テストします。サービスを停止して切り替え、ヘルスチェックとVC受聴が成功したら運用を再開します。失敗時は前リリースへ戻して再起動します。自動デプロイは未実装です。

保存対象はソース、lockfile、音源、辞書、固定したEngineのバージョンと導入手順です。`.env` はソースと分離した暗号化バックアップに保存します。トークンを誤公開した場合はDiscordで失効・再発行します。VMが回収された場合はこの手順で再構築します。読み上げキューはメモリだけのため復旧対象外です。
