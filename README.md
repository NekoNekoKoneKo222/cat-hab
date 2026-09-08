# Cat Hub

Cat Tube + Cloud Cat + Play Cat を1つのNode.jsサービスで動かすプロジェクトです。

## Render
1. GitHubにこのフォルダの中身をリポジトリ直下へアップロード
2. Render → New → Web Service
3. `cloud-hub` のリポジトリを選択
4. Runtime: Docker
5. Plan: Free
6. Environment Variables:
   - `DATABASE_URL` = Render PostgreSQLのInternal Database URL
   - `SESSION_SECRET` = 長いランダム文字列
   - `NODE_ENV` = `production`
   - `YOUTUBE_API_KEY` = YouTube Data API v3 key
7. Deploy

## 管理者
`admin.txt` にユーザー名を1行ずつ記入するとAdminとして扱います。

## 注意
- 画像は現在ローカル `uploads/` に保存します。Renderで本番運用する場合はR2/S3等への移行を推奨します。
- YouTubeのストリーム取得・保存は、権利・利用許諾のあるコンテンツを対象にしてください。

## プロキシ機能
`/api/proxy?url=...` で、`ALLOWED_PROXY_HOSTS` に登録したホストのリソースだけを取得できます。

RenderのEnvironment Variablesに以下を設定してください。
- `ALLOWED_PROXY_HOSTS` = 許可するホストをカンマ区切り（例: `example.com,example.org`）
- `PROXY_MAX_BYTES` = 最大レスポンスサイズ（既定8MB、最大32MB）
- `PROXY_TIMEOUT_MS` = タイムアウト（既定10秒）

プロキシはログインユーザーのみ利用でき、HTTP/HTTPS以外、localhost、プライベートIP、許可リスト外のホスト、許可リスト外へ向かうリダイレクトを拒否します。HTML/JavaScriptはCat Hubの同一オリジンで実行されないようテキストとして返します。
