# cocode フロントエンド(Firebase Hosting)デプロイスクリプト
#
# docs/cocode/cocode-deploy-procedure.md の「② フロントエンド(Firebase
# Hosting)」を実行するだけの薄いラッパー。デプロイの挙動自体は変更しない
# (仕様書§16.1)。
#
# 前提: web/.env.production.local に本番用の値を設定済みであること
# (NEXT_PUBLIC_API_BASE_URL・NEXT_PUBLIC_WS_BASE_URL(wss://)・
# NEXT_PUBLIC_MAP_STYLE_URL・NEXT_PUBLIC_MAP_STYLE_URL_DARK・
# NEXT_PUBLIC_MAPTILER_KEY)。`npm run build`はNODE_ENV=productionになるため
# web/.env.local(ローカル開発用)ではなくこちらが自動的に使われる。
#
# web/firebase.json はビルド起点直下から動かしていない(firebase deployの
# 既定探索場所に依存するため、仕様書§16.1参照)。このスクリプト自体は
# web/deploy/ に置くが、実行時は一つ上の web/ へ移動してから実行する。

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

npm run build
firebase deploy --only hosting --project cocode-505303
