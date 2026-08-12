# cocode

認証不要・共有リンクだけで、ユーザーAとユーザーBが「待ち合わせ地点」と「お互いの現在地」をリアルタイムに共有できる、個人開発・低コスト運用前提の位置共有アプリです。

- ユーザーAが待ち合わせ地点(現在地 or 地図タップ)を指定 → 共有リンクが発行される
- ユーザーAとユーザーBは、双方の画面で「待ち合わせ地点」「Aの現在地」「Bの現在地」の3点と、それぞれの現在地から待ち合わせ地点までの徒歩ルートをリアルタイムに確認できる
- セッションは作成から**30分**、またはどちらかの「終了」操作で失効する

## 技術スタック

| レイヤ | 技術 | デプロイ先 |
|---|---|---|
| バックエンド | Go (REST + WebSocket) | Cloud Run (`min-instances=0`, `max-instances=1`) |
| フロントエンド | Next.js (静的エクスポート) + MapLibre GL JS | Firebase Hosting 無料枠 |
| データベース | Supabase (Postgres) | Supabase 無料枠 |

コストを抑えるための設計判断:

- Cloud Runは`max-instances=1`固定。同一セッションのWebSocket接続が必ず同一インスタンス上に乗るため、Redis等の外部Pub/Subが不要。
- セッションの永続データ(トークン・失効時刻・位置情報)のみSupabaseに保存し、DB接続はGoバックエンドからのみ行う(フロントは直接Supabaseを叩かない)。
- セッションの自動削除にCloud Scheduler等は使わず、Goプロセス内の`time.AfterFunc`によるTTLタイマー + アクセス時の遅延チェックのみで完結させている。
- 待ち合わせ地点までの徒歩ルートはOSRMの公開デモサーバー(無料・APIキー不要、`web/lib/routing.ts`)から都度取得して描画するだけで、サーバー・ブラウザどちらにも保存しない。
- 地図タイルはデフォルトでMapLibreの無料デモスタイルを使用(本番でより洗練された見た目にしたい場合はMapTiler等の無料枠キーに差し替え可能)。

## ディレクトリ構成

```
cocode_project/
  server/   Goバックエンド (REST API + WebSocket)
  web/      Next.jsフロントエンド (静的エクスポート)
```

## ローカル開発

### 1. Supabase (または任意のPostgres) を用意する

`server`はPostgres接続文字列(`DATABASE_URL`)を必須とします。起動時に`sessions`テーブルを自動作成するので、事前のマイグレーションは不要です。

- 本番運用ではSupabaseの無料プロジェクトを作成し、「Connection string」をコピーして使用してください。
- ローカルだけで試したい場合は、Dockerでローカル Postgres を立てても構いません:
  ```bash
  docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=password postgres:16
  ```

### 2. バックエンドを起動する

```bash
cd server
cp .env.example .env   # DATABASE_URL 等を編集
go run ./cmd/server
```

デフォルトで `http://localhost:8080` で待ち受けます。ヘルスチェックは `GET /healthz`。

### 3. フロントエンドを起動する

```bash
cd web
cp .env.example .env.local   # 必要に応じて編集(デフォルトのままlocalhost:8080向けでOK)
npm install
npm run dev
```

`http://localhost:3000` を開くと、待ち合わせ地点の設定画面が表示されます。2つのブラウザ(またはブラウザ+スマホ)でユーザーA・Bの動きを再現して動作確認してください。

## 本番デプロイ

### バックエンド (Cloud Run)

```bash
cd server
gcloud run deploy cocode-server \
  --source . \
  --region asia-northeast1 \
  --min-instances=0 \
  --max-instances=1 \
  --set-env-vars "PUBLIC_BASE_URL=https://<your-firebase-hosting-domain>" \
  --set-secrets "DATABASE_URL=cocode-database-url:latest"
```

- `DATABASE_URL` はSecret Managerに登録し、環境変数へ直書きしないでください(spec §8-7)。
- `PUBLIC_BASE_URL` はフロントエンドのオリジンを指定します(共有URLの生成・CORS許可オリジンの両方に使われます)。

### フロントエンド (Firebase Hosting)

```bash
cd web
npm run build   # 静的ファイルが web/out に出力される

firebase login
firebase use --add   # 初回のみ: FirebaseプロジェクトIDを選択
firebase deploy --only hosting
```

`npm run build` は `NODE_ENV=production` になるため、`web/.env.local`(ローカル開発用、localhost向け)ではなく `web/.env.production.local` を自動的に読み込みます。本番用のCloud Run URLやMap Tilerキーはこちらに設定してください(`.env.local` は書き換え不要)。

## セッション・WebSocketプロトコル概要

REST:

| メソッド | パス | 用途 |
|---|---|---|
| POST | `/api/sessions` | 待ち合わせ地点(`lat`,`lng`)を指定してセッション作成。地点未指定は400 |
| GET | `/api/sessions/:id/state?token=` | セッション状態の再取得 |
| POST | `/api/sessions/:id/end?token=` | セッションの即時終了 |

WebSocket (`/ws`): 接続直後の最初のフレームで `{ "sessionId": "...", "token": "..." }` を送って認証し、以降 `location_update` (`kind: "target" | "live"`) を送受信します。詳細はソースコード内のコメント(`server/internal/ws/handler.go`, `server/internal/hub/hub.go`)を参照してください。

## 既知の制約

- Aはセッション作成直後、ブラウザのURLが自分専用のリンク(`?s=<id>&t=<Aのtoken>`)に自動で書き換わります。これをブックマークしておけば別端末からでも同じセッションを開けますが、URLを控え忘れて`localStorage`もない状態(別端末・別ブラウザ)だと復帰できません。
- 待ち合わせ地点までの徒歩ルートはOSRMの無料公開デモサーバーから取得しており、可用性・レート制限の保証はありません。取得できない場合はルート線が表示されないだけで、位置共有自体には影響しません(v1は徒歩のみ。車・電車などの選択は今後の拡張予定)。
- セッションのTTLは30分固定で、活動があっても延長されません。長引く場合はリンクを再発行してください。
