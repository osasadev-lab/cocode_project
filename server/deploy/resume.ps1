# cocode バックエンド(Cloud Run)の公開アクセスを再開する(stop.ps1の逆操作)。

$ErrorActionPreference = "Stop"

gcloud run services add-iam-policy-binding cocode-server `
  --region asia-northeast1 --project cocode-505303 `
  --member="allUsers" --role="roles/run.invoker"
