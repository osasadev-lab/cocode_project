# cocode バックエンド(Cloud Run)の公開アクセスのみ無効化する(可逆)。
# サービス・設定・トラフィックは残したまま、未認証呼び出し権限だけを外す。
# 再開は resume.ps1 を参照。

$ErrorActionPreference = "Stop"

gcloud run services remove-iam-policy-binding cocode-server `
  --region asia-northeast1 --project cocode-505303 `
  --member="allUsers" --role="roles/run.invoker"
