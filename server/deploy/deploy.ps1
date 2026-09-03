# cocode バックエンド(Cloud Run)デプロイスクリプト
#
# docs/cocode/cocode-deploy-procedure.md の「① バックエンド(Cloud Run)」を
# 実行するだけの薄いラッパー。デプロイの挙動自体は変更しない(仕様書§16.1)。
#
# 前提:
#   - gcloud CLI ログイン済み(osasadev@gmail.com)
#   - Secret Manager に cocode-database-url / cocode-navitime-api-key /
#     cocode-smtp-password が登録済み(2026-09-03時点で登録済み)
#
# server/Dockerfile はビルド起点直下から動かしていない(gcloud run deploy
# --source . の既定探索場所に依存するため、仕様書§16.1参照)。このスクリプト
# 自体は server/deploy/ に置くが、実行時は一つ上の server/ へ移動してから
# gcloud を呼ぶ。

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

gcloud run deploy cocode-server `
  --source . `
  --region asia-northeast1 `
  --min-instances=0 `
  --max-instances=1 `
  --allow-unauthenticated `
  --set-env-vars "PUBLIC_BASE_URL=https://cocode-505303.web.app" `
  --set-secrets "DATABASE_URL=cocode-database-url:latest,NAVITIME_RAPIDAPI_KEY=cocode-navitime-api-key:latest,SMTP_PASSWORD=cocode-smtp-password:latest" `
  --project cocode-505303
