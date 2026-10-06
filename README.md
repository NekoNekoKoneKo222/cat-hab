# Cat Hub

Cat Hub は Cat Tube、Cloud Cat、Play Cat、Proxy、Admin の入口です。起動ファイルは `src/server.js` です。

## Firebase 構成

- Firestore Standard の `(default)` データベースにアカウント、セッション、ゲーム、お気に入りを保存します。
- 登録・ログインはメール不要のアカウント名＋パスワードです。表示名は任意です。パスワードは bcrypt でハッシュ化し、サーバー側で照合します。
- Firebase Admin SDK のみが Firestore にアクセスします。`firestore.rules` はクライアントからの直接読み書きをすべて拒否します。
- `FIREBASE_SERVICE_ACCOUNT` に JSON のサービスアカウントを、`FIREBASE_PROJECT_ID` に `cat-hub-4cf7a` を設定してください。Google の Application Default Credentials も利用できます。
- `SESSION_SECRET` は長く予測できない値を指定してください。`ADMIN_USERS` は管理者アカウント名のカンマ区切りです。

```sh
npm ci
npm start
npm test
```

`/healthz` は Firestore への接続を確認します。Firestore ルールは `firebase.json` から Firebase CLI でデプロイできます。

## サービス

Cloud Cat と Cat Tube は独立したサービスです。`CLOUD_CAT_URL` と `CAT_TUBE_URL` に公開 URL を設定します。`GET /api/proxy?url=...` はログイン必須の読み取り専用プロキシで、内部アドレス、危険な応答形式、大きすぎる応答を拒否します。

既存 PostgreSQL のユーザー情報は自動移行しません。旧 Firebase Authentication のメールアカウントとも別のアカウントになります。
