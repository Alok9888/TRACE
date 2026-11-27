<#
.SYNOPSIS
  Safely syncs backend-go/.env parameters into AWS SSM Parameter Store (/trace/prod/*).
  Secrets are stored as KMS-encrypted SecureString; non-secrets as String.
  Never echoes secret values to stdout.
#>
[CmdletBinding()]
param(
  [string]$EnvFile = "",
  [string]$Region = "ap-southeast-2",
  [string]$SsmPrefix = "/trace/prod",
  [switch]$AllowLocalDb
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\..")
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  $EnvFile = Join-Path $RepoRoot "backend-go\.env"
}

if (-not (Test-Path $EnvFile)) {
  throw "Env file not found: $EnvFile"
}

$SecretKeys = @(
  "DATABASE_URL",
  "CLOUDFLARE_API_TOKEN",
  "GROQ_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GITHUB_TOKEN",
  "SPRING_DATASOURCE_URL",
  "SPRING_DATASOURCE_PASSWORD"
)

$params = @{}
foreach ($line in Get-Content $EnvFile) {
  $trimmed = $line.Trim()
  if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
  $trimmed = $trimmed -replace '^export\s+', ''
  $eq = $trimmed.IndexOf('=')
  if ($eq -le 0) { continue }
  $k = $trimmed.Substring(0, $eq).Trim()
  $v = $trimmed.Substring($eq + 1).Trim()
  if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
    $v = $v.Substring(1, $v.Length - 2)
  }
  if ($k -ne "" -and $v -ne "") {
    $params[$k] = $v
  }
}

# Safety guard against accidentally pushing localhost Postgres to AWS prod
if ($params.ContainsKey("DATABASE_URL") -and -not $AllowLocalDb) {
  if ($params["DATABASE_URL"] -match "(localhost|127\.0\.0\.1|host\.docker\.internal)") {
    throw "DATABASE_URL in $EnvFile points to localhost! Update it to your Neon Postgres URL (or pass -AllowLocalDb to override)."
  }
}

Write-Host "==> Syncing $($params.Count) parameters to SSM $SsmPrefix ($Region)..." -ForegroundColor Cyan
foreach ($key in ($params.Keys | Sort-Object)) {
  $type = if ($SecretKeys -contains $key) { "SecureString" } else { "String" }
  $name = "$SsmPrefix/$key"
  & aws ssm put-parameter `
    --region $Region `
    --name $name `
    --type $type `
    --value $params[$key] `
    --overwrite | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to put SSM parameter $name"
  }
  Write-Host "    [OK] $name ($type)"
}

Write-Host "==> SSM Parameter Store sync complete." -ForegroundColor Green
