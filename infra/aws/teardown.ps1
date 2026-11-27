<#
.SYNOPSIS
  Cleanly tears down all TRACE AWS resources created by bootstrap.ps1.
#>
[CmdletBinding()]
param(
  [string]$Region = "ap-southeast-2",
  [string]$AppName = "trace-backend",
  [string]$SsmPrefix = "/trace/prod",
  [string]$LogGroupName = "/trace/backend-go"
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StatePath = Join-Path $ScriptDir ".aws-state.json"

if (-not (Test-Path $StatePath)) {
  Write-Host "No .aws-state.json found; nothing to tear down automatically." -ForegroundColor Yellow
  exit 0
}

$state = Get-Content $StatePath -Raw | ConvertFrom-Json

Write-Host "==> Disabling & deleting CloudFront distribution $($state.CloudFrontDistributionId)..." -ForegroundColor Yellow
if ($state.CloudFrontDistributionId) {
  $cfgResp = aws cloudfront get-distribution-config --id $state.CloudFrontDistributionId --output json | ConvertFrom-Json
  if ($cfgResp) {
    $etag = $cfgResp.ETag
    $cfgResp.DistributionConfig.Enabled = $false
    $tmp = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($tmp, ($cfgResp.DistributionConfig | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
    aws cloudfront update-distribution --id $state.CloudFrontDistributionId --if-match $etag --distribution-config "file://$tmp" | Out-Null
    Remove-Item $tmp -Force
    Write-Host "    Waiting for CloudFront to disable (may take a few minutes)..."
    aws cloudfront wait distribution-deployed --id $state.CloudFrontDistributionId
    $newEtag = (aws cloudfront get-distribution --id $state.CloudFrontDistributionId --query "ETag" --output text)
    aws cloudfront delete-distribution --id $state.CloudFrontDistributionId --if-match $newEtag
  }
}

if ($state.InstanceId) {
  Write-Host "==> Terminating EC2 instance $($state.InstanceId)..." -ForegroundColor Yellow
  aws ec2 terminate-instances --region $Region --instance-ids $state.InstanceId | Out-Null
  aws ec2 wait instance-terminated --region $Region --instance-ids $state.InstanceId
}

if ($state.AllocationId) {
  Write-Host "==> Releasing Elastic IP $($state.AllocationId)..." -ForegroundColor Yellow
  aws ec2 release-address --region $Region --allocation-id $state.AllocationId
}

if ($state.SecurityGroupId) {
  Write-Host "==> Deleting Security Group $($state.SecurityGroupId)..." -ForegroundColor Yellow
  aws ec2 delete-security-group --region $Region --group-id $state.SecurityGroupId
}

Write-Host "==> Deleting ECR repository $AppName..." -ForegroundColor Yellow
aws ecr delete-repository --region $Region --repository-name $AppName --force | Out-Null

Write-Host "==> Deleting CloudWatch Log Group $LogGroupName..." -ForegroundColor Yellow
aws logs delete-log-group --region $Region --log-group-name $LogGroupName

Write-Host "==> Deleting SSM parameters under $SsmPrefix..." -ForegroundColor Yellow
$names = aws ssm get-parameters-by-path --region $Region --path $SsmPrefix --recursive --query "Parameters[].Name" --output text
if ($names) {
  foreach ($n in ($names -split "\s+")) {
    if ($n) { aws ssm delete-parameter --region $Region --name $n }
  }
}

Write-Host "==> Cleaning up IAM roles & instance profile..." -ForegroundColor Yellow
aws iam remove-role-from-instance-profile --instance-profile-name trace-ec2-profile --role-name trace-ec2-role 2>$null
aws iam delete-instance-profile --instance-profile-name trace-ec2-profile 2>$null
aws iam delete-role-policy --role-name trace-ec2-role --policy-name trace-ec2-least-privilege 2>$null
aws iam detach-role-policy --role-name trace-ec2-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>$null
aws iam detach-role-policy --role-name trace-ec2-role --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly 2>$null
aws iam delete-role --role-name trace-ec2-role 2>$null

aws iam delete-role-policy --role-name trace-github-deploy-role --policy-name trace-github-deploy-policy 2>$null
aws iam delete-role --role-name trace-github-deploy-role 2>$null

Remove-Item $StatePath -Force
Write-Host "==> Teardown complete." -ForegroundColor Green
