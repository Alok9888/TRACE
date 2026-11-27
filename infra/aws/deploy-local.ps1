<#
.SYNOPSIS
  Builds backend-go Docker image, pushes to ECR, and triggers zero-SSH blue/green deploy via AWS SSM.
#>
[CmdletBinding()]
param(
  [string]$Tag = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$StatePath = Join-Path $ScriptDir ".aws-state.json"

if (-not (Test-Path $StatePath)) {
  throw "State file not found at $StatePath. Run infra/aws/bootstrap.ps1 first."
}

$state = Get-Content $StatePath -Raw | ConvertFrom-Json
$Region = $state.Region
$EcrUri = $state.EcrRepositoryUri
$Registry = $EcrUri.Split("/")[0]
$InstanceId = $state.InstanceId

if ([string]::IsNullOrWhiteSpace($Tag)) {
  $sha = (& git -C $RepoRoot rev-parse --short HEAD 2>$null)
  if (-not $sha) { $sha = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString() }
  $Tag = $sha.Trim()
}

$ImageSha = "${EcrUri}:${Tag}"
$ImageLatest = "${EcrUri}:latest"

Write-Host "==> 1. Logging into ECR ($Registry)..." -ForegroundColor Cyan
$pw = & aws ecr get-login-password --region $Region
if ($LASTEXITCODE -ne 0) { throw "ECR login password fetch failed." }
$pw | & docker login --username AWS --password-stdin $Registry
if ($LASTEXITCODE -ne 0) { throw "Docker login to ECR failed." }

Write-Host "==> 2. Building backend-go Docker image ($ImageSha)..." -ForegroundColor Cyan
& docker build --platform linux/amd64 -t $ImageSha -t $ImageLatest (Join-Path $RepoRoot "backend-go")
if ($LASTEXITCODE -ne 0) { throw "Docker build failed." }

Write-Host "==> 3. Pushing image to ECR..." -ForegroundColor Cyan
& docker push $ImageSha
if ($LASTEXITCODE -ne 0) { throw "Docker push $ImageSha failed." }
& docker push $ImageLatest
if ($LASTEXITCODE -ne 0) { throw "Docker push $ImageLatest failed." }

Write-Host "==> 4. Waiting for EC2 SSM agent online ($InstanceId)..." -ForegroundColor Cyan
$online = $false
for ($i = 1; $i -le 30; $i++) {
  $ping = & aws ssm describe-instance-information --region $Region --filters "Key=InstanceIds,Values=$InstanceId" --query "InstanceInformationList[0].PingStatus" --output text 2>$null
  if ($ping -eq "Online") {
    $online = $true
    break
  }
  Write-Host "    [$i/30] SSM PingStatus: $ping (waiting 5s...)"
  Start-Sleep -Seconds 5
}
if (-not $online) { throw "EC2 instance $InstanceId did not register with SSM in time." }

Write-Host "==> 5. Running zero-SSH blue/green deploy via SSM..." -ForegroundColor Cyan
$paramsJson = "{`"commands`":[`"/usr/local/bin/deploy-trace.sh $ImageSha`"]}"
$tmpParams = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($tmpParams, $paramsJson, (New-Object System.Text.UTF8Encoding($false)))

$cmdId = & aws ssm send-command `
  --region $Region `
  --instance-ids $InstanceId `
  --document-name "AWS-RunShellScript" `
  --comment "Local deploy $Tag" `
  --parameters "file://$tmpParams" `
  --query "Command.CommandId" `
  --output text
Remove-Item $tmpParams -Force
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($cmdId)) { throw "SSM send-command failed." }

Write-Host "    SSM Command ID: $cmdId"
for ($i = 1; $i -le 60; $i++) {
  Start-Sleep -Seconds 5
  $inv = & aws ssm get-command-invocation --region $Region --command-id $cmdId --instance-id $InstanceId --output json 2>$null | ConvertFrom-Json
  if (-not $inv) { continue }
  Write-Host "    [$i] Status: $($inv.Status)"
  if ($inv.Status -eq "Success") {
    Write-Host "`n--- Remote Deploy Output ---" -ForegroundColor Green
    Write-Host $inv.StandardOutputContent
    Write-Host "Live HTTPS Endpoint: $($state.HttpsEndpoint)/health" -ForegroundColor Green
    exit 0
  }
  if ($inv.Status -in @("Failed", "Cancelled", "TimedOut", "Undeliverable", "Terminated")) {
    Write-Host "`n--- Remote Stdout ---" -ForegroundColor Yellow
    Write-Host $inv.StandardOutputContent
    Write-Host "`n--- Remote Stderr ---" -ForegroundColor Red
    Write-Host $inv.StandardErrorContent
    throw "Remote deploy failed with status $($inv.Status)"
  }
}

throw "Timed out waiting for SSM deploy command $cmdId"
