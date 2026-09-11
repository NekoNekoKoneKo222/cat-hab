# Cat Hub

Cat Tube / Cloud Cat / Play Cat / Proxy / Web VM を1つのWebサービスへ統合したアプリケーションです。
Node.js + Express + Socket.IO + PostgreSQLで構築され、単一のRender Web Serviceとして動作します。

> 現時点の実装状況: 基盤(認証・DB・GUI枠組み)、Proxy、Web VM、Cat Tube、Cloud Cat、
> Play Catの全機能を実装済みです。詳細な制限事項は各セクションを参照してください。

## セットアップ (ローカル開発)

### 必要なもの

- Node.js 18以上
- PostgreSQL 14以上

### 手順

```bash
git clone <このリポジトリ>
cd cathub
npm install
cp .env.example .env   # 値を編集
# .envの内容を環境変数として読み込む方法は各自の環境に合わせてください
# (例: direnv, dotenv-cli, または単純にexportする)
npm start
```

サーバーは `http://localhost:3000` で起動します。

### PostgreSQL設定

`DATABASE_URL` に接続文字列を設定してください。起動時に必要なテーブルが自動作成されます
(再実行しても安全な `CREATE TABLE IF NOT EXISTS` 方式)。

```
DATABASE_URL=postgresql://user:password@localhost:5432/cathub
```

## Render設定

1. このリポジトリをGitHubにpushする
2. Renderで「New Web Service」からこのリポジトリを選択(Dockerを使用)
3. `render.yaml` を使う場合は「Blueprint」から読み込み可能です
4. Environment Variablesを設定する(下記参照)
5. デプロイ

`PORT` はRenderが自動設定するため指定不要です。`DATABASE_URL` はRender PostgreSQLを
作成すると自動的に注入されます。

## Environment Variables

| 変数名 | 必須 | 説明 |
|---|---|---|
| `DATABASE_URL` | 必須 | PostgreSQL接続文字列 |
| `SESSION_SECRET` | 必須 | セッション署名用のランダムな秘密文字列 |
| `NODE_ENV` | - | `production` を推奨 |
| `YOUTUBE_API_KEY` | Cat Tube利用時 | YouTube Data API v3のAPIキー |
| `ADMIN_USERS` | - | カンマ区切りの管理者ユーザー名 |
| `ALLOWED_PROXY_HOSTS` | Proxy利用時 | カンマ区切りの許可ホスト(例: `example.com,*.example.org`)。未設定だとProxyは無効。 |
| `VM_ISO_URL` | Web VM利用時 | ISOの場所(相対パスまたは外部URL) |
| `VM_MAX_ISO_SIZE_MB` | - | ISOサイズ上限(MB)。既定2048 |
| `VM_MEMORY_MB` | - | VMのメモリ割り当て(MB)。既定512 |
| `VM_CPU_COUNT` | - | 現バージョンでは常に1固定です(下記「VMの制限」参照) |
| `VM_ENABLED` | - | `false` でWeb VM機能自体を無効化 |
| `VM_NETWORK_PROXY_ALLOWLIST` | 未使用 | 将来のVM用ネットワーク機能のためのプレースホルダー(下記参照) |

秘密情報(APIキー等)はAdmin画面には一切表示されません。「設定済みか否か」のみ表示されます。
`VM_ISO_URL` は秘密情報ではない前提のため、Admin画面および一般ユーザー向けVM画面の両方に表示されます。

## 管理者設定

`ADMIN_USERS` にユーザー名をカンマ区切りで指定するか、DBの `users.is_admin` を `true` に
更新することで管理者権限を付与できます。管理者のみがナビゲーションの「Admin」メニューと
`/admin.html` にアクセスできます。

## Proxy設定

`GET /api/proxy?url=<エンコード済みURL>` がProxy本体です。

- **オープンプロキシではありません**: `ALLOWED_PROXY_HOSTS` に登録されたホストのみアクセス可能です
  (未設定の場合は全て拒否されます)。ワイルドカード `*.example.com` によるサブドメイン許可に対応。
- DNS解決後の実IPアドレスを検証し、プライベート/予約済みIP(ループバック、リンクローカル、
  クラウドメタデータエンドポイント169.254.169.254等、RFC1918プライベートレンジ全般)への
  アクセスを拒否します。
- リダイレクトは自動追跡せず、遷移先ごとに毎回同じ検証を行います(最大5ホップ)。
- タイムアウト10秒、レスポンスサイズ上限8MB、レートリミット30回/分(ユーザーごと)。
- HTML応答は`<script>`タグ・`on*`イベント属性・`javascript:`リンクを除去したうえで返され、
  フロントエンドはこれを`sandbox="allow-forms allow-popups"`(スクリプト実行不可)のiframeで
  表示します。取得先のCookieやAuthorizationは一切転送しません。

## Web VM設定

Web VMはブラウザ内WebAssemblyで動作するx86エミュレータ [v86](https://github.com/copy/v86)
(Simplified BSD License)を使用しています。Cat Hubサーバー上でVMを実行するものではなく、
ユーザーのブラウザ内で完結します。

### ISO配置方法

ISOファイルはCat Hub側にアップロードする機能を持たず、**ユーザー自身がGitHubリポジトリへ配置**します。

1. GitHubリポジトリ(このCat Hubのデプロイ元リポジトリ、または別リポジトリ)を用意する
2. `public/vm/iso/linux.iso` としてISOファイルを配置する
   (`.gitignore` で `*.iso` は除外されているため、コミット時は `git add -f` 等で明示的に追加してください)
3. Renderの環境変数で以下を設定する

   ```
   VM_ISO_URL=/vm/iso/linux.iso
   ```

4. Cat Hubをデプロイする

外部URL(GitHub Raw等)を使う場合は次のように設定できます。

```
VM_ISO_URL=https://raw.githubusercontent.com/USER/REPO/main/vm/iso/linux.iso
```

外部URLを使う場合、対象サーバーがCORSを許可している必要があります。GitHub Rawは
`Access-Control-Allow-Origin: *` を返すため利用可能です。CORSが許可されていない場合、
VM画面に「ISOを読み込めませんでした」というエラーが表示されます。

任意のURLを自由に指定できるオープンプロキシではありません。`VM_ISO_URL` は管理者が
デプロイ時に固定するものであり、一般ユーザーが実行時に任意のISO URLを指定することはできません。

### VM操作

VM起動 / 停止 / 再起動 / 一時停止 / フルスクリーンに対応しています。

- 一時停止はVMインスタンスを破棄せず`stop()`するのみなので、再開すると続きから再開されます。
- 停止(destroy)は完全にリソースを解放するため、再度起動すると最初からブートし直します。
- ページを閉じる・離れる際は`pagehide`イベントで自動的にVMを破棄し、リソースリークを防止します。

### iPad / タッチ対応

- タップ = 左クリック、長押し(約550ms) = 右クリック相当として動作します(v86のマウス処理は
  タッチ/マウス双方をネイティブ処理するため、追加コードは主に長押し右クリックのみです)。
- キーボード: 外付けキーボードは物理キーボードとして自動的に機能します。
  画面内の仮想キーボードパネルでは、Esc/Tab/Ctrl/Alt/Shift/Enter/Backspace/矢印/F1-F12の
  特殊キーに加え、「文字入力」ボタンをタップすると非表示のテキストエリアにフォーカスが移り、
  iPadのソフトウェアキーボードで入力した文字がVMへ転送されます。
- ピンチズームやスクロールがVM操作の邪魔をしないよう、VM画面領域は`touch-action: none`を
  設定しています。

### VMの制限(既知の制限事項)

- **CPU数は常に1です**。`VM_CPU_COUNT`は設定として受け付けますが、v86は単一CPUエミュレータの
  ため複数コアを実際にはサポートしていません。実装されていない機能をUI上で「設定できるように
  見せかける」ことはしていません。
- **ネットワーク機能は本バージョンには含まれていません。** そのため、VM内部のLinux/ブラウザから
  実際にインターネット上のWebサイトを閲覧することは、現時点ではできません
  (画面表示・OS起動・キーボード/マウス操作までは動作します)。
  安全なネットワーク中継(SSRF対策込みのTCPリレー等)の実装は複雑かつ検証コストが高いため、
  今回のスコープでは意図的に含めていません。`VM_NETWORK_PROXY_ALLOWLIST`はそのための
  設定項目として予約されていますが、現バージョンでは未使用です。
  将来的にネットワーク機能を追加する場合は、v86公式のネットワークリレー実装
  (https://github.com/copy/v86/tree/master/net) を参考に、別サーバーとして構築し、
  localhost/プライベートIP/メタデータエンドポイントを拒否するSSRFガード
  (`src/utils/ssrfGuard.js`を再利用可能)を通すことを強く推奨します。
- ISOサイズが大きい場合、iPad等のメモリが少ない端末ではVMが起動できない場合があります。
  `VM_MAX_ISO_SIZE_MB`で上限を設定できますが、実際に起動できるかは端末性能に依存します。
- 巨大なISOファイルはこのリポジトリにコミットしないでください。`.gitignore`で`*.iso`を
  除外していますが、ユーザーが意図的に配置したISOファイルをツールが勝手に削除することはありません。

## Cat Tube

YouTube Data API v3を使用しています。`YOUTUBE_API_KEY`が未設定の場合、検索APIは
`503`を返し、その旨を画面に表示します(機能を偽装して見せかけることはしません)。

- キーワード検索、またはYouTube URL(youtube.com/watch, youtu.be, /embed/, /shorts/)を
  直接貼り付けての再生に対応
- 視聴は公式Embed(`https://www.youtube.com/embed/VIDEO_ID`)を使用

**注記**: 本開発環境からは`www.googleapis.com`への実際のネットワークアクセスができないため、
YouTube検索の実通信は未検証です。APIキー未設定時のエラーハンドリング、認証チェック、
URL解析ロジックは実際にテスト済みです。

## Cloud Cat

以下を実装しています。

- アカウント、フレンド(申請/承認/削除)
- DM(1:1・グループ)、既読とは別に通知を発行
- グループ(オーナー/モデレーター/メンバーの役割、メンバー追加・削除)
- コミュニティ+チャンネル(作成時に「雑談」チャンネルを自動作成、チャンネルは
  ログイン済みユーザーに公開、投稿はオーナー/管理者/本人のみ削除可能)
- ルーム(参加・退出・Kick・BAN・BAN解除。BANされている間は再参加不可)
- 画像送信(multer、MIME検証、ランダムファイル名、8MB上限)
- メッセージへの返信・リアクション(トグル式)・削除(論理削除)
- 通知(フレンド申請/承認、DMメッセージ)とナビゲーションバーの未読バッジ
- Socket.IOによるリアルタイム配信(メッセージ新規/削除/リアクション/通知)。
  参加権限のないルームへはサーバー側で`join`要求を拒否します。

**既知の制限事項**:
- チャンネル・ルームのメッセージにはリアクション機能のAPIは用意していますが
  (チャンネルの`POST .../reactions`)、リアクション**一覧取得API**はDMのみ提供しています。
  UI上のリアクション件数表示もDMのみ対応しています。
- コミュニティのチャンネル作成UIは未実装です(バックエンドAPIは実装済み。
  `POST /api/communities/:id/channels`)。
- 実際のSocket.IOリアルタイム配信は`socket.io-client`を使った自動テストで検証済みですが、
  ブラウザGUI上での目視確認は行っていません(本環境にGUIブラウザがないため)。

## Play Cat

ゲームポータル機能です。初期データとして「将棋ライク」
(https://unityroom.com/games/shougi-like) を起動時に自動登録します。

- ゲーム一覧・検索・カテゴリ絞り込み・お気に入り・履歴・評価(1〜5)・コメント
- ゲームはiframeで埋め込み表示(`unityroom.com`をCSPのframe-srcに許可済み)

**既知の制限事項**: `unityroom.com`への実際のネットワークアクセスは本開発環境からは
できないため、iframe埋め込みが実際にunityroom.com側で正しく表示されるかは未検証です
(iframe許可設定とAPIロジックは検証済み)。

## テスト結果

開発時に実施した確認内容は完了報告(会話ログ)を参照してください。主な確認項目:

- 認証(register/login/logout/session)の一連の動作
- 管理者権限の判定と403/401の分岐
- Proxy: allowlist外ホストの拒否、内部IPの拒否、正常系のHTTP取得、レートリミット
- Web VM: 静的アセット(libv86.js / v86.wasm / BIOS)の配信、ISO未配置時の404エラー、
  ISO疎通確認ロジック(404 / 成功 / 接続不可の3パターン)

## 既知の問題

- Web VMは実機のiPadやブラウザでの目視確認は行っていません(本開発環境にGUIブラウザが
  ないため)。ロジックレベルでの検証(構文チェック・API疎通・状態遷移コードレビュー)に
  留まります。Web VMのネットワーク機能自体も未実装です(前述の通り)。
- Cat TubeのYouTube Data API実通信、Play Catのunityroom.com iframe実表示は、
  本開発環境のネットワーク制限により実通信での検証ができていません。
- Cloud Catのチャンネル/ルームのリアクション一覧表示、コミュニティのチャンネル作成UIは
  未実装です(詳細は各セクション参照)。
- いずれの画面もSocket.IO通信のロジック(join認可・イベント配信)は自動テストで検証済み
  ですが、実際のブラウザGUIでの目視確認は行っていません。
