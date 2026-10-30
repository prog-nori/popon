# VOICEVOXメモリ制限検証（2026-10-25）

[README](../../README.md) · [ローカルでの動作確認](../local-development.md) · [検証記録](../validation.md)

## 結論

現行の最大200文字を一括合成する仕様では、VOICEVOX用に1GiBを推奨できません。短文は処理できましたが、200文字でOOMKilledとなりました。Botを別VMへ分離しても、このVOICEVOX単体の制限は解消しません。

## 条件

- Intel Mac Core i9-10910 3.60GHz、Docker Desktop Linux AMD64。Docker VMは10 CPU / 約7.77GiB。
- 既存のVOICEVOX 0.26.0公式CPUイメージを利用。イメージIDとDockerの実際の制限値はJSON参照。
- コンテナCPU上限2コア、メモリ1GiBまたは2GiB、スワップなし。既定のスレッド設定。
- 話者3、API既定の速度・音量。audio_query＋synthesisのHTTP完了までを測定。WAV再生、Discord通信、Opus変換は含まない。
- 既存のpopon-local-voicevox-1は停止・変更せず、別の検証コンテナを各試験ごとに作成・削除。.envは読み込まない。
- 各コンテナは新規起動だが、イメージ取得済み・ホストのキャッシュあり。VM初回起動やイメージ取得を含むコールドスタートではない。

## 実測

|メモリ制限|試験|結果|
|---|---|---|
|1GiB|短文6文字→42文字→200文字|短文1.32秒、42文字4.44秒。200文字の処理中にOOMKilled、終了コード137|
|1GiB|ウォームアップ後、6文字と42文字を交互に各5回|10回すべて成功。6文字1.33～1.51秒（中央値1.34秒）、42文字4.30～4.64秒（中央値4.62秒）|
|2GiB|ウォームアップ後、6文字・42文字・200文字を各2回|6回すべて成功。200文字17.76秒／18.51秒|

1GiBの短文連続試験は、コンテナ起動操作からAPI応答まで1.70秒、最初の短文WAV取得まで4.26秒。試験終了時のcgroup memory.currentは約493MiB、oom/oom_killは0でした。

2GiB試験は200文字の1回目完了後が約1,207MiB、2回目完了後が約1,796MiBでした。これはキャッシュ等を含むcgroup使用量で、プロセスRSSや合成中の最大値とは異なります。各リクエスト完了後に測定しており、瞬間ピークは未測定です。memory.peakはこの環境では取得できませんでした。

2GiBでの200文字成功は2回のみです。継続利用時のメモリ増加が頭打ちになるかは未確認で、2GiBの長時間安定性を保証しません。

## 運用への判断

- このMacでは6文字の合成は2秒以内ですが、42文字は合成だけで2秒を超えます。
- 1GBのVMではOSやDockerもメモリを使うため、今回の「VOICEVOXだけに1GiB」より条件が厳しくなります。
- GCP e2-microの持続CPU性能、通信遅延、実際の受聴時間は未検証。Macでの時間をGCPの予測値として使わないでください。
- 現行仕様を維持する場合は4GB級VMを次の検証候補とします。1GB運用を目指す場合は長文を短い単位で合成する変更と、OS分を差し引いたメモリ制限での再検証が必要です。分割時の発音・間・キュー処理も確認が必要です。

## 再実行

リポジトリルートで以下を実行します。`IMAGE_ID`には対象環境で取得した公式VOICEVOXイメージのIDを指定してください。

```bash
python3 scripts/benchmark-voicevox.py --image IMAGE_ID --memory 1g --output /tmp/voicevox-1g.json
python3 scripts/benchmark-voicevox.py --image IMAGE_ID --memory 1g --skip-long --output /tmp/voicevox-short.json
python3 scripts/benchmark-voicevox.py --image IMAGE_ID --memory 2g --repeats 2 --output /tmp/voicevox-2g.json
```

Docker操作権限が必要です。ローカルホストの動的ポートを使い、検証用コンテナだけを終了時に削除します。合成失敗時もJSONを保存し、スクリプトは終了コード1を返します。

生データ: [1GiB・長文失敗](voicevox-1g.json)、[1GiB・短文連続](voicevox-1g-short.json)、[2GiB・比較](voicevox-2g.json)。
