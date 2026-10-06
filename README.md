# Cat Hub

Cat Hub は Cat Tube、Cloud Cat、Play Cat、Proxy、Admin の入口です。現在の起動ファイルは `src/server.js` です。リポジトリ直下の古い `server.js` は起動対象ではありません。

## 構成

- Cat Hub: Express、PostgreSQL、セッション、アカウント名＋パスワード認証。既存の画面構成と Play Cat の画面を維持します。
- Cloud Cat と Cat Tube: 独立したサービス。Cat Hub は `CLOUD_CAT_URL` と `CAT_TUBE_URL` の公開 URL を使用して `/healthz` を安全な Proxy で確認し、それぞれの画面へ案内します。
- `GET /api/proxy?url=...`: ログイン必須、読み取り専用。HTTP/HTTPS のみ、内部 IP・予約済み IP・ローカル名・危険な Content-Type を拒否します。DNS 解決した IPv4 に接続を固定し、リダイレクト先も再検証します。Cookie、Authorization、任意のリクエストヘッダーは転送しません。

## 環境変数

`.env.example` にキー名を記載しています。`DATABASE_URL` と `SESSION_SECRET` は必須です。`ADMIN_USERS` はカンマ区切りのアカウント名です。秘密情報をソースや `.env.example` に記載しないでください。

## 起動

Node.js 20 以上と稼働中の PostgreSQL が必要です。

```sh
npm ci
npm start
```

起動時に `src/schema.sql` を適用します。既存テーブルやデータを削除しません。`/healthz` は DB 接続を確認します。`npm test` のテストは現在 `node --test src/safe-proxy.test.js` で実行できます。

## 既知の制限

Render の既存 PostgreSQL が停止している場合、アカウント登録とセッションを使う新バージョンは起動できません。DB の復旧と `DATABASE_URL` 設定を確認してから本番へ切り替えてください。Cat Tube には `YOUTUBE_API_KEY`、Cloud Cat には別の PostgreSQL 接続が必要です。既存 Play Cat 画面はこの変更では作り直していません。
