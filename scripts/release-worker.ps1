[CmdletBinding()]
param(
    [string]$ApiBase = "https://www.sologle.com",
    [string]$WorkerKey = $env:GULONG_RELEASE_WORKER_KEY,
    [string]$SourceProjectRoot = "C:\Users\YCAI\Documents\Codex\2026-07-10\new-chat\work\gulong-agent",
    [string]$SourceThreadTurnId = $env:GULONG_SOURCE_THREAD_TURN_ID,
    [int]$PollSeconds = 20,
    [switch]$Once
)

$ErrorActionPreference = "Stop"
$ApiBase = $ApiBase.TrimEnd("/")
$themeAccessPath = Join-Path $env:LOCALAPPDATA "com.sologle.gulong\config\user-theme-access.json"
$workflowPath = Join-Path $SourceProjectRoot "scripts\release\Invoke-VersionReleaseWorkflow.ps1"
$outputRoot = Join-Path $SourceProjectRoot "release-worker-output"

if ([string]::IsNullOrWhiteSpace($WorkerKey)) { throw "GULONG_RELEASE_WORKER_KEY is required." }
if (-not (Test-Path -LiteralPath $themeAccessPath -PathType Leaf)) { throw "Theme access file was not found: $themeAccessPath" }
if (-not (Test-Path -LiteralPath $workflowPath -PathType Leaf)) { throw "Release workflow was not found: $workflowPath" }
if ([string]::IsNullOrWhiteSpace($SourceThreadTurnId)) {
    $gitSha = (& git -C $SourceProjectRoot rev-parse HEAD 2>$null)
    if ([string]::IsNullOrWhiteSpace($gitSha)) { throw "Cannot resolve source state; set GULONG_SOURCE_THREAD_TURN_ID." }
    $SourceThreadTurnId = "git-$gitSha"
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

$headers = @{ "X-Release-Worker-Key" = $WorkerKey }

function Invoke-PlatformJson {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        [object]$Body
    )
    $parameters = @{
        Method = $Method
        Uri = "$ApiBase$Path"
        Headers = $headers
        ContentType = "application/json; charset=utf-8"
        TimeoutSec = 120
    }
    if ($null -ne $Body) { $parameters.Body = ($Body | ConvertTo-Json -Depth 20 -Compress) }
    Invoke-RestMethod @parameters
}

function Get-ReleaseGroups {
    $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $themeAccessPath | ConvertFrom-Json
    $groups = @($document.groups)
    if ($groups.Count -eq 0) { throw "No groups were found in the theme access file." }
    @($groups | ForEach-Object {
        $themes = @($_.themeNames)
        [ordered]@{
            id = [string]$_.id
            name = [string]$_.name
            themeNames = $themes
            profileKey = if ([string]$_.id -eq "747a0afd-e52f-4793-b0d2-75dd1b04da48") { "yongshenghua" } else { "gulong" }
        }
    })
}

function Sync-ReleaseChannels {
    $groups = Get-ReleaseGroups
    $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $themeAccessPath | ConvertFrom-Json
    $assignments = @($document.assignments | ForEach-Object {
        [ordered]@{
            userId = [string]$_.userId
            displayName = [string]$_.displayName
            groupId = [string]$_.groupId
        }
    })
    $result = Invoke-PlatformJson -Method POST -Path "/api/release-worker/channels/sync" -Body @{ groups = $groups; assignments = $assignments }
    Write-Host ("Synchronized {0} release channels and {1} assignments." -f $groups.Count, $result.assignments)
}

function Complete-Job {
    param([Parameter(Mandatory)]$Job)
    $jobId = [string]$Job.id
    try {
        # Rebuild the active menu immediately before selecting, preserving the
        # release script's source-turn and theme-access snapshot gates.
        $releaseCommand = [string]::Concat([char]0x53D1, [char]0x5E03, [char]0x7248, [char]0x672C)
        & $workflowPath -Command $releaseCommand -SourceThreadTurnId $SourceThreadTurnId | Out-Host
        & $workflowPath -Selection ([int]$Job.menuSelection) -SourceThreadTurnId $SourceThreadTurnId -OutputDirectory $outputRoot | Out-Host

        $receiptFile = Get-ChildItem -LiteralPath $outputRoot -Recurse -Filter "version-release-receipt.json" -File |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
        if (-not $receiptFile) { throw "version-release-receipt.json was not produced." }
        $receipt = Get-Content -Raw -Encoding UTF8 -LiteralPath $receiptFile.FullName | ConvertFrom-Json
        if ([string]$receipt.status -ne "built" -or [string]$receipt.distributionStatus -ne "awaiting-admin") {
            throw "Local release receipt is not awaiting an explicit administrator publication."
        }
        if ([string]$receipt.publicationMode -ne "manual-admin-only" -or $receipt.automaticCosUpload -ne $false) {
            throw "Local release receipt does not enforce the manual-admin-only publication policy."
        }
        $installerPath = [IO.Path]::GetFullPath([string]$receipt.filePath)
        if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw "Installer from release receipt was not found: $installerPath" }

        $upload = Invoke-PlatformJson -Method POST -Path "/api/release-worker/jobs/$jobId/upload" -Body @{
            filename = [string]$receipt.fileName
            version = [string]$receipt.version
            bytes = [int64]$receipt.bytes
            sha256 = [string]$receipt.sha256
            signatureStatus = [string]$receipt.authenticode
        }
        Invoke-WebRequest -UseBasicParsing -Method PUT -Uri $upload.uploadUrl -InFile $installerPath -ContentType "application/vnd.microsoft.portable-executable" -TimeoutSec 7200 | Out-Null
        $completed = Invoke-PlatformJson -Method POST -Path "/api/release-worker/jobs/$jobId/complete" -Body @{ receipt = $receipt }
        $receipt.status = "released"
        $receipt.distributionStatus = "published"
        $receipt.publicationMode = "admin-triggered-worker"
        $receipt.websiteDistribution = [ordered]@{
            status = "published"
            trigger = "admin-release-job"
            jobId = $jobId
            channelId = [string]$Job.channelId
            channelName = [string]$Job.channelName
            objectKey = [string]$upload.objectKey
            apiBase = $ApiBase
            publishedAt = [string]$completed.publishedAt
            bytes = [int64]$receipt.bytes
            sha256 = [string]$receipt.sha256
        }
        $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptFile.FullName -Encoding UTF8
        Write-Host ("Published {0} v{1}; SHA-256 {2}" -f $Job.channelName, $receipt.version, $receipt.sha256)
    }
    catch {
        $message = $_.Exception.Message
        try { Invoke-PlatformJson -Method POST -Path "/api/release-worker/jobs/$jobId/fail" -Body @{ error = $message } | Out-Null } catch { }
        Write-Error ("Release job $jobId failed: $message")
    }
}

Sync-ReleaseChannels
do {
    $claim = Invoke-PlatformJson -Method POST -Path "/api/release-worker/jobs/claim" -Body @{ workerId = "$env:COMPUTERNAME-$PID" }
    if ($null -ne $claim.job) { Complete-Job -Job $claim.job }
    if (-not $Once) { Start-Sleep -Seconds ([Math]::Max(5, $PollSeconds)) }
} while (-not $Once)
