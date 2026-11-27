<#
.SYNOPSIS
  Idempotently provisions TRACE's AWS production stack in ap-south-1:
    - ECR repository (with lifecycle policy)
    - CloudWatch Log Group (7-day retention)
    - Least-privilege EC2 IAM Role (SSM + ECR + CloudWatch; zero SSH)
    - Security Group locked to CloudFront's managed prefix list (no port 22, no 0.0.0.0/0)
    - Free-Tier EC2 t3.micro (Amazon Linux 2023, IMDSv2 enforced) + Elastic IP
    - CloudFront distribution (free HTTPS, CachingDisabled, AllViewerExceptHostHeader, X-Origin-Verify)
    - GitHub Actions OIDC Provider + least-privilege deploy role
#>
[CmdletBinding()]
param(
  [string]$Region = "ap-southeast-2",
  [string]$AppName = "trace-backend",
  [string]$InstanceType = "t3.micro",
  [string]$GitHubRepo = "Alok9888/devpilot",
  [string]$GitHubBranch = "main",
  [string]$SsmPrefix = "/trace/prod",
  [string]$LogGroupName = "/trace/backend-go"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StatePath = Join-Path $ScriptDir ".aws-state.json"

function Invoke-AwsJson {
  param([string[]]$ArgsList, [switch]$IgnoreError)
  if ($IgnoreError) {
    $raw = & aws @ArgsList --output json 2>$null
  } else {
    $raw = & aws @ArgsList --output json
  }
  if ($LASTEXITCODE -ne 0) {
    if ($IgnoreError) { return $null }
    throw "aws $($ArgsList -join ' ') failed with exit code $LASTEXITCODE"
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host "==> 1. Verifying AWS caller identity..." -ForegroundColor Cyan
$identity = Invoke-AwsJson @("sts", "get-caller-identity")
$AccountId = $identity.Account
Write-Host "    Account: $AccountId | ARN: $($identity.Arn) | Region: $Region"

# Load existing state (for idempotent reruns / preserving OriginVerifySecret)
$state = @{}
if (Test-Path $StatePath) {
  $existing = Get-Content $StatePath -Raw | ConvertFrom-Json
  $existing.PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value }
}

if (-not $state.ContainsKey("OriginVerifySecret") -or [string]::IsNullOrWhiteSpace($state["OriginVerifySecret"])) {
  $bytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $state["OriginVerifySecret"] = ([System.BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
}
$OriginVerifySecret = $state["OriginVerifySecret"]

Write-Host "==> 2. Provisioning ECR repository ($AppName)..." -ForegroundColor Cyan
$ecrRepo = $null
try {
  $ecrResp = Invoke-AwsJson @("ecr", "describe-repositories", "--region", $Region, "--repository-names", $AppName)
  $ecrRepo = $ecrResp.repositories[0]
  Write-Host "    Reusing ECR repo: $($ecrRepo.repositoryUri)"
} catch {
  $ecrResp = Invoke-AwsJson @(
    "ecr", "create-repository",
    "--region", $Region,
    "--repository-name", $AppName,
    "--image-scanning-configuration", "scanOnPush=true",
    "--encryption-configuration", "encryptionType=AES256"
  )
  $ecrRepo = $ecrResp.repository
  Write-Host "    Created ECR repo: $($ecrRepo.repositoryUri)"
}

$lifecyclePolicy = @{
  rules = @(
    @{
      rulePriority = 1
      description  = "Keep only the 5 most recent images to stay within ECR free tier"
      selection    = @{
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = @{ type = "expire" }
    }
  )
} | ConvertTo-Json -Depth 6 -Compress

$tmpLifecycle = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom $tmpLifecycle $lifecyclePolicy
& aws ecr put-lifecycle-policy --region $Region --repository-name $AppName --lifecycle-policy-text "file://$tmpLifecycle" | Out-Null
Remove-Item $tmpLifecycle -Force

Write-Host "==> 3. Provisioning CloudWatch Log Group ($LogGroupName, 7-day retention)..." -ForegroundColor Cyan
$lgResp = Invoke-AwsJson @("logs", "describe-log-groups", "--region", $Region, "--log-group-name-prefix", $LogGroupName)
$existingLg = $lgResp.logGroups | Where-Object { $_.logGroupName -eq $LogGroupName }
if (-not $existingLg) {
  & aws logs create-log-group --region $Region --log-group-name $LogGroupName
  Write-Host "    Created log group $LogGroupName"
} else {
  Write-Host "    Reusing log group $LogGroupName"
}
& aws logs put-retention-policy --region $Region --log-group-name $LogGroupName --retention-in-days 7

Write-Host "==> 4. Provisioning least-privilege EC2 IAM Role & Instance Profile..." -ForegroundColor Cyan
$Ec2RoleName = "trace-ec2-role"
$Ec2ProfileName = "trace-ec2-profile"

$ec2Trust = @{
  Version   = "2012-10-17"
  Statement = @(
    @{
      Effect    = "Allow"
      Principal = @{ Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }
  )
} | ConvertTo-Json -Depth 5 -Compress

$roleExists = $true
try {
  Invoke-AwsJson @("iam", "get-role", "--role-name", $Ec2RoleName) | Out-Null
} catch {
  $roleExists = $false
}

if (-not $roleExists) {
  $tmpTrust = [System.IO.Path]::GetTempFileName()
  Write-Utf8NoBom $tmpTrust $ec2Trust
  Invoke-AwsJson @("iam", "create-role", "--role-name", $Ec2RoleName, "--assume-role-policy-document", "file://$tmpTrust") | Out-Null
  Remove-Item $tmpTrust -Force
  Write-Host "    Created IAM role $Ec2RoleName"
} else {
  Write-Host "    Reusing IAM role $Ec2RoleName"
}

& aws iam attach-role-policy --role-name $Ec2RoleName --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
& aws iam attach-role-policy --role-name $Ec2RoleName --policy-arn "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"

$ec2Inline = @{
  Version   = "2012-10-17"
  Statement = @(
    @{
      Sid      = "ReadTraceProdParams"
      Effect   = "Allow"
      Action   = @("ssm:GetParametersByPath", "ssm:GetParameter", "ssm:GetParameters")
      Resource = "arn:aws:ssm:${Region}:${AccountId}:parameter${SsmPrefix}/*"
    },
    @{
      Sid      = "DecryptDefaultSsmKey"
      Effect   = "Allow"
      Action   = @("kms:Decrypt")
      Resource = "*"
      Condition = @{
        StringEquals = @{ "kms:ViaService" = "ssm.${Region}.amazonaws.com" }
      }
    },
    @{
      Sid      = "WriteTraceCloudWatchLogs"
      Effect   = "Allow"
      Action   = @("logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams")
      Resource = "arn:aws:logs:${Region}:${AccountId}:log-group:${LogGroupName}:*"
    }
  )
} | ConvertTo-Json -Depth 6 -Compress

$tmpInline = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom $tmpInline $ec2Inline
& aws iam put-role-policy --role-name $Ec2RoleName --policy-name "trace-ec2-least-privilege" --policy-document "file://$tmpInline"
Remove-Item $tmpInline -Force

$profileExists = $true
try {
  $prof = Invoke-AwsJson @("iam", "get-instance-profile", "--instance-profile-name", $Ec2ProfileName)
} catch {
  $profileExists = $false
}
if (-not $profileExists) {
  Invoke-AwsJson @("iam", "create-instance-profile", "--instance-profile-name", $Ec2ProfileName) | Out-Null
  & aws iam add-role-to-instance-profile --instance-profile-name $Ec2ProfileName --role-name $Ec2RoleName
  Write-Host "    Created Instance Profile $Ec2ProfileName (waiting 10s for IAM propagation)..."
  Start-Sleep -Seconds 10
} else {
  $attached = $prof.InstanceProfile.Roles | Where-Object { $_.RoleName -eq $Ec2RoleName }
  if (-not $attached) {
    & aws iam add-role-to-instance-profile --instance-profile-name $Ec2ProfileName --role-name $Ec2RoleName
    Start-Sleep -Seconds 10
  }
  Write-Host "    Reusing Instance Profile $Ec2ProfileName"
}

Write-Host "==> 5. Provisioning CloudFront-locked Security Group (zero SSH, zero 0.0.0.0/0)..." -ForegroundColor Cyan
$vpcResp = Invoke-AwsJson @("ec2", "describe-vpcs", "--region", $Region, "--filters", "Name=isDefault,Values=true")
if (-not $vpcResp.Vpcs -or $vpcResp.Vpcs.Count -eq 0) {
  throw "No default VPC found in $Region."
}
$VpcId = $vpcResp.Vpcs[0].VpcId

$plResp = Invoke-AwsJson @("ec2", "describe-managed-prefix-lists", "--region", $Region, "--filters", "Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing")
if (-not $plResp.PrefixLists -or $plResp.PrefixLists.Count -eq 0) {
  throw "Could not resolve CloudFront managed prefix list in $Region."
}
$CfPrefixListId = $plResp.PrefixLists[0].PrefixListId
Write-Host "    VPC: $VpcId | CloudFront Prefix List: $CfPrefixListId"

$SgName = "$AppName-sg"
$sgResp = Invoke-AwsJson @("ec2", "describe-security-groups", "--region", $Region, "--filters", "Name=group-name,Values=$SgName", "Name=vpc-id,Values=$VpcId")
if ($sgResp.SecurityGroups -and $sgResp.SecurityGroups.Count -gt 0) {
  $SgId = $sgResp.SecurityGroups[0].GroupId
  Write-Host "    Reusing Security Group: $SgId"
} else {
  $sgCreate = Invoke-AwsJson @(
    "ec2", "create-security-group",
    "--region", $Region,
    "--group-name", $SgName,
    "--description", "TRACE backend: HTTP from CloudFront origin-facing prefix list only (zero SSH)",
    "--vpc-id", $VpcId
  )
  $SgId = $sgCreate.GroupId
  Write-Host "    Created Security Group: $SgId"
}

$ipPerm = "[{`"IpProtocol`":`"tcp`",`"FromPort`":80,`"ToPort`":80,`"PrefixListIds`":[{`"PrefixListId`":`"$CfPrefixListId`",`"Description`":`"CloudFront origin-facing only`"}]}]"
$tmpPerm = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom $tmpPerm $ipPerm
$prevPref = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& aws ec2 authorize-security-group-ingress --region $Region --group-id $SgId --ip-permissions "file://$tmpPerm" 2>$null | Out-Null
$ErrorActionPreference = $prevPref
Remove-Item $tmpPerm -Force

Write-Host "==> 6. Provisioning EC2 instance ($InstanceType, Amazon Linux 2023, IMDSv2)..." -ForegroundColor Cyan
$ec2Query = Invoke-AwsJson @(
  "ec2", "describe-instances",
  "--region", $Region,
  "--filters",
  "Name=tag:Name,Values=$AppName",
  "Name=instance-state-name,Values=pending,running,stopping,stopped"
)

$InstanceId = $null
foreach ($res in $ec2Query.Reservations) {
  foreach ($inst in $res.Instances) {
    $InstanceId = $inst.InstanceId
    break
  }
  if ($InstanceId) { break }
}

if (-not $InstanceId) {
  $amiParam = Invoke-AwsJson @(
    "ssm", "get-parameter",
    "--region", $Region,
    "--name", "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
  )
  $AmiId = $amiParam.Parameter.Value
  Write-Host "    Latest AL2023 AMI: $AmiId"

  # Normalize LF line endings for Linux scripts before encoding
  $deployScriptRaw = (Get-Content (Join-Path $ScriptDir "deploy-trace.sh") -Raw) -replace "`r`n", "`n"
  $deployScriptB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($deployScriptRaw))

  $userDataRaw = (Get-Content (Join-Path $ScriptDir "user-data.sh") -Raw) -replace "`r`n", "`n"
  $userDataRaw = $userDataRaw.Replace("__ORIGIN_VERIFY_SECRET__", $OriginVerifySecret).Replace("__DEPLOY_SCRIPT_B64__", $deployScriptB64)

  $tmpUserData = [System.IO.Path]::GetTempFileName()
  Write-Utf8NoBom $tmpUserData $userDataRaw

  $tagSpec = "ResourceType=instance,Tags=[{Key=Name,Value=$AppName},{Key=App,Value=trace},{Key=Env,Value=prod}]"
  $bdm = "[{`"DeviceName`":`"/dev/xvda`",`"Ebs`":{`"VolumeSize`":8,`"VolumeType`":`"gp3`",`"DeleteOnTermination`":true,`"Encrypted`":true}}]"
  $tmpBdm = [System.IO.Path]::GetTempFileName()
  Write-Utf8NoBom $tmpBdm $bdm

  $runResp = Invoke-AwsJson @(
    "ec2", "run-instances",
    "--region", $Region,
    "--image-id", $AmiId,
    "--instance-type", $InstanceType,
    "--iam-instance-profile", "Name=$Ec2ProfileName",
    "--security-group-ids", $SgId,
    "--metadata-options", "HttpTokens=required,HttpEndpoint=enabled",
    "--block-device-mappings", "file://$tmpBdm",
    "--user-data", "file://$tmpUserData",
    "--tag-specifications", $tagSpec
  )
  Remove-Item $tmpUserData, $tmpBdm -Force

  $InstanceId = $runResp.Instances[0].InstanceId
  Write-Host "    Launched EC2 instance: $InstanceId. Waiting for running state..."
  & aws ec2 wait instance-running --region $Region --instance-ids $InstanceId
} else {
  Write-Host "    Reusing EC2 instance: $InstanceId"
}

Write-Host "==> 7. Allocating/Associating Elastic IP for stable CloudFront origin..." -ForegroundColor Cyan
$eipResp = Invoke-AwsJson @("ec2", "describe-addresses", "--region", $Region, "--filters", "Name=tag:Name,Values=$AppName-eip")
$AllocationId = $null
$PublicIp = $null

if ($eipResp.Addresses -and $eipResp.Addresses.Count -gt 0) {
  $addr = $eipResp.Addresses[0]
  $AllocationId = $addr.AllocationId
  $PublicIp = $addr.PublicIp
  Write-Host "    Reusing EIP: $PublicIp ($AllocationId)"
} else {
  $alloc = Invoke-AwsJson @(
    "ec2", "allocate-address",
    "--region", $Region,
    "--domain", "vpc",
    "--tag-specifications", "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$AppName-eip},{Key=App,Value=trace}]"
  )
  $AllocationId = $alloc.AllocationId
  $PublicIp = $alloc.PublicIp
  Write-Host "    Allocated EIP: $PublicIp ($AllocationId)"
}

& aws ec2 associate-address --region $Region --instance-id $InstanceId --allocation-id $AllocationId --allow-reassociation | Out-Null

$ipDashed = $PublicIp -replace "\.", "-"
$OriginDns = "ec2-$ipDashed.$Region.compute.amazonaws.com"
Write-Host "    Origin DNS: $OriginDns"

Write-Host "==> 8. Provisioning CloudFront Distribution (Free HTTPS + SSE unbuffered)..." -ForegroundColor Cyan
$CfDistributionId = $state["CloudFrontDistributionId"]
$CfDomain = $state["CloudFrontDomain"]

if ($CfDistributionId) {
  try {
    $cfCheck = Invoke-AwsJson @("cloudfront", "get-distribution", "--id", $CfDistributionId)
    $CfDomain = $cfCheck.Distribution.DomainName
    Write-Host "    Reusing CloudFront: https://$CfDomain ($CfDistributionId)"
  } catch {
    $CfDistributionId = $null
  }
}

if (-not $CfDistributionId) {
  # Check if a distribution already points to this OriginDns
  $cfList = Invoke-AwsJson @("cloudfront", "list-distributions")
  if ($cfList.DistributionList -and $cfList.DistributionList.Items) {
    foreach ($d in $cfList.DistributionList.Items) {
      if ($d.Comment -eq "TRACE Go Backend HTTPS Edge ($Region)") {
        $CfDistributionId = $d.Id
        $CfDomain = $d.DomainName
        Write-Host "    Found existing CloudFront: https://$CfDomain ($CfDistributionId)"
        break
      }
    }
  }
}

if (-not $CfDistributionId) {
  $cfConfig = @{
    CallerReference = "trace-backend-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
    Comment         = "TRACE Go Backend HTTPS Edge ($Region)"
    Enabled         = $true
    PriceClass      = "PriceClass_200"
    HttpVersion     = "http2"
    Origins         = @{
      Quantity = 1
      Items    = @(
        @{
          Id                 = "trace-ec2-origin"
          DomainName         = $OriginDns
          CustomOriginConfig = @{
            HTTPPort               = 80
            HTTPSPort              = 443
            OriginProtocolPolicy   = "http-only"
            OriginSslProtocols     = @{ Quantity = 1; Items = @("TLSv1.2") }
            OriginReadTimeout      = 60
            OriginKeepaliveTimeout = 60
          }
          CustomHeaders = @{
            Quantity = 1
            Items    = @(
              @{
                HeaderName  = "X-Origin-Verify"
                HeaderValue = $OriginVerifySecret
              }
            )
          }
        }
      )
    }
    DefaultCacheBehavior = @{
      TargetOriginId       = "trace-ec2-origin"
      ViewerProtocolPolicy = "redirect-to-https"
      AllowedMethods       = @{
        Quantity      = 7
        Items         = @("GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE")
        CachedMethods = @{ Quantity = 2; Items = @("GET", "HEAD") }
      }
      Compress              = $false
      CachePolicyId         = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # AWS Managed: CachingDisabled
      OriginRequestPolicyId = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AWS Managed: AllViewerExceptHostHeader
    }
  } | ConvertTo-Json -Depth 10

  $tmpCf = [System.IO.Path]::GetTempFileName()
  Write-Utf8NoBom $tmpCf $cfConfig
  $cfResp = Invoke-AwsJson @("cloudfront", "create-distribution", "--distribution-config", "file://$tmpCf")
  Remove-Item $tmpCf -Force

  $CfDistributionId = $cfResp.Distribution.Id
  $CfDomain = $cfResp.Distribution.DomainName
  Write-Host "    Created CloudFront: https://$CfDomain ($CfDistributionId)"
}

Write-Host "==> 9. Provisioning GitHub Actions OIDC Provider & Deploy Role..." -ForegroundColor Cyan
$OidcArn = "arn:aws:iam::${AccountId}:oidc-provider/token.actions.githubusercontent.com"
$oidcExists = $true
try {
  Invoke-AwsJson @("iam", "get-open-id-connect-provider", "--open-id-connect-provider-arn", $OidcArn) | Out-Null
  Write-Host "    Reusing GitHub OIDC provider"
} catch {
  $oidcExists = $false
}

if (-not $oidcExists) {
  Invoke-AwsJson @(
    "iam", "create-open-id-connect-provider",
    "--url", "https://token.actions.githubusercontent.com",
    "--client-id-list", "sts.amazonaws.com",
    "--thumbprint-list", "6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"
  ) | Out-Null
  Write-Host "    Created GitHub OIDC provider"
}

$GhRoleName = "trace-github-deploy-role"
$ghTrust = @{
  Version   = "2012-10-17"
  Statement = @(
    @{
      Effect    = "Allow"
      Principal = @{ Federated = $OidcArn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = @{
        StringEquals = @{
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${GitHubRepo}:ref:refs/heads/${GitHubBranch}"
        }
      }
    }
  )
} | ConvertTo-Json -Depth 6 -Compress

$ghRoleExists = $true
try {
  $ghRole = Invoke-AwsJson @("iam", "get-role", "--role-name", $GhRoleName)
} catch {
  $ghRoleExists = $false
}

$tmpGhTrust = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom $tmpGhTrust $ghTrust
if (-not $ghRoleExists) {
  $ghRole = Invoke-AwsJson @("iam", "create-role", "--role-name", $GhRoleName, "--assume-role-policy-document", "file://$tmpGhTrust")
  Write-Host "    Created IAM role $GhRoleName"
} else {
  & aws iam update-assume-role-policy --role-name $GhRoleName --policy-document "file://$tmpGhTrust"
  Write-Host "    Updated trust policy on $GhRoleName"
}
Remove-Item $tmpGhTrust -Force
$GhRoleArn = $ghRole.Role.Arn

$ghPolicy = @{
  Version   = "2012-10-17"
  Statement = @(
    @{
      Sid      = "EcrAuth"
      Effect   = "Allow"
      Action   = @("ecr:GetAuthorizationToken")
      Resource = "*"
    },
    @{
      Sid      = "EcrPushTraceBackend"
      Effect   = "Allow"
      Action   = @(
        "ecr:BatchCheckLayerAvailability",
        "ecr:CompleteLayerUpload",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart"
      )
      Resource = $ecrRepo.repositoryArn
    },
    @{
      Sid      = "SsmDeployTraceInstance"
      Effect   = "Allow"
      Action   = @("ssm:SendCommand")
      Resource = @(
        "arn:aws:ec2:${Region}:${AccountId}:instance/${InstanceId}",
        "arn:aws:ssm:${Region}::document/AWS-RunShellScript"
      )
    },
    @{
      Sid      = "SsmReadCommandStatus"
      Effect   = "Allow"
      Action   = @("ssm:GetCommandInvocation", "ssm:ListCommandInvocations")
      Resource = "*"
    },
    @{
      Sid      = "ResolveTraceInstance"
      Effect   = "Allow"
      Action   = @("ec2:DescribeInstances")
      Resource = "*"
    }
  )
} | ConvertTo-Json -Depth 6 -Compress

$tmpGhPol = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom $tmpGhPol $ghPolicy
& aws iam put-role-policy --role-name $GhRoleName --policy-name "trace-github-deploy-policy" --policy-document "file://$tmpGhPol"
Remove-Item $tmpGhPol -Force

# Save state (gitignored)
$newState = [ordered]@{
  AccountId                = $AccountId
  Region                   = $Region
  AppName                  = $AppName
  EcrRepositoryUri         = $ecrRepo.repositoryUri
  LogGroupName             = $LogGroupName
  SsmPrefix                = $SsmPrefix
  SecurityGroupId          = $SgId
  CloudFrontPrefixListId   = $CfPrefixListId
  InstanceId               = $InstanceId
  AllocationId             = $AllocationId
  PublicIp                 = $PublicIp
  OriginDns                = $OriginDns
  CloudFrontDistributionId = $CfDistributionId
  CloudFrontDomain         = $CfDomain
  HttpsEndpoint            = "https://$CfDomain"
  GitHubDeployRoleArn      = $GhRoleArn
  OriginVerifySecret       = $OriginVerifySecret
}
Write-Utf8NoBom $StatePath ($newState | ConvertTo-Json -Depth 5)

Write-Host "`n================ TRACE AWS BOOTSTRAP COMPLETE ================" -ForegroundColor Green
Write-Host "HTTPS Endpoint     : https://$CfDomain"
Write-Host "ECR Repository     : $($ecrRepo.repositoryUri)"
Write-Host "EC2 Instance ID    : $InstanceId ($PublicIp)"
Write-Host "GitHub OIDC Role   : $GhRoleArn"
Write-Host "State Saved To     : $StatePath (gitignored)"
Write-Host "==============================================================" -ForegroundColor Green
