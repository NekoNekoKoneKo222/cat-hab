# Cat Hub 実装状況（2026-09-26）

## 既存コードの調査

- `package.json` と `Dockerfile` は Firebase だけを使う `src/server.js` を起動していた。もう一つの `server.js` に PostgreSQL / Socket.IO / セッション / API の統合コードがあったが、`routes/`, `middleware/`, `utils/`, `public/`, `config.js`, `db.js` が欠けて起動できなかった。
- ルートに散在していた各 API と画面資産を、元のファイルを残したまま参照先のディレクトリに配置した。既存 `schema.sql` のテーブルと API 名を維持。
- ChocoTube-Plus-main.zip はルート一覧でページ構成を確認した。ホーム、検索、視聴、チャンネル、ライブラリ、プレイリスト、Shorts、設定、トレンドという導線だけを参考にした。コード、素材、名称、デザインは使用していない。

## 今回接続したもの

- PostgreSQL 初期化、ゲーム初期データ、セッション認証、bcrypt、利用規約同意、プロフィール・パスワード変更、`admin.txt` 判定、アカウント BAN・ログ
- フレンド、DM、公開/非公開ルーム（参加コード）、Kick/BAN、ルームメッセージの `chat_logs` 保存、Play Cat、YouTube Data API サーバー側呼び出しと履歴・お気に入り・プレイリスト API
- Proxy の許可リスト、私有 IP 拒否、転送ヘッダー制限、DNS 解決結果への接続固定、5分無操作タイムアウト
- UI のログイン、登録、検索、視聴、フレンド、DM、ルーム、ゲーム、管理一覧を API に接続。Render 起動先を統合サーバーに修正。

## 未完了・検証待ち

- `DATABASE_URL` が提供されていないため PostgreSQL 実接続と DB を伴うエンドツーエンドテストは未実施。スキーマの実行成功は確認できていない。
- `YOUTUBE_API_KEY` が提供されていないため外部 YouTube API の成功は未確認。
- Cloud Cat を別 Render にデプロイして Cat Hub 経由でセッション・Socket.IO を共有する構成は未実装。現在は単一サービス内に統合。
- nyan play は公式サイトへの導線。第三者の非公開 API と WebRTC シグナリングの接続、キュー、地域選択は未実装。
- DM の既読、返信、リアクションと画像は API 側の対応に対して画面操作を揃えきれていない。ルーム管理 UI、チャンネル、ゲームカテゴリ、Cat Tube プレイリスト画面も未完了。
- Socket.IO は基盤と通知イベントを保持するが、BAN/Kick 中に既に参加していた socket を即座に退出させる処理と複数 Render インスタンス間の pub/sub は未実装。
- Render/Oracle Cloud 実デプロイは未実施。画像はローカルディスク保存なので Render の再起動を跨ぐ永続化には外部ストレージが必要。

## ローカル確認

`npm ci --ignore-scripts --no-audit --no-fund`、全 JS の構文確認、DB 未設定の開発起動で `/healthz`、`/api/auth/me`、静的ページに対する HTTP 応答を確認。DB 未設定時の `/healthz` は HTTP 503 と `db:false`。
