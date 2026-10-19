#Requires -Version 7.0
param([switch]$ValidatePathsOnly)
$ErrorActionPreference = 'Stop'
# Fixed, bounded source-asset preparation. Does not install tools, load models,
# modify the H3 service, or register arbitrary files with DiskGuard.
$fixtureRoot = 'D:\ProgramFiles\program\gulong-agent-build'
$fixtureStage = Join-Path $fixtureRoot 'staging'
$fixtureCurrent = Join-Path $fixtureRoot 'current\probe-fixtures'
$fixtureFfmpeg = 'D:\program\MiniMaxH3\tools\ffmpeg\bin\ffmpeg.exe'
$fixtureFfprobe = 'D:\program\MiniMaxH3\tools\ffmpeg\bin\ffprobe.exe'
$fixtureExpectedHashes = @{
  'nasa-pose-source.jpg' = 'bf68496dd810ed43df4ef8a68008b22fada9800b56eb90e6bf7cc8d15c39ae7d'
  'jfk.flac' = '63a4b1e4c1dc655ac70961ffbf518acd249df237e5a0152faae9a4a836949715'
  'pose-16frames.mp4' = '3a2af643f2723ed16b0240a8d4e416b256d499320f143233a50ad89a6dfcd293'
}
function Assert-FixturePath([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { throw 'Empty fixture output path' }
  if (![IO.Path]::IsPathFullyQualified($value) -or $value -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Fixture output must be absolute and contain no traversal' }
  $full = [IO.Path]::GetFullPath($value)
  if (!$full.StartsWith($fixtureRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture path escaped controlled project root' }
  for ($parent = $full; $parent; $parent = [IO.Path]::GetDirectoryName($parent)) {
    if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Fixture path traverses a reparse point' }
  }
  return $full
}
if ($ValidatePathsOnly) {
  $rejected = 0
  foreach ($invalid in @('', 'D:', 'D:\', 'D:\ProgramFiles\program\gulong-agent-build-escape\file', (Join-Path $fixtureRoot 'current\..\staging'))) {
    try { [void](Assert-FixturePath $invalid); throw 'Unsafe path unexpectedly accepted' }
    catch { if ($_.Exception.Message -eq 'Unsafe path unexpectedly accepted') { throw }; $rejected++ }
  }
  $accepted = @(Join-Path $fixtureRoot 'current\fixture with spaces.bin'; Join-Path $fixtureRoot ('current\' + [char]0x4e2d + [char]0x6587 + '.bin'))
  foreach ($valid in $accepted) { [void](Assert-FixturePath $valid) }
  [pscustomobject]@{status='path-gate-tested';rejected=$rejected;accepted=$accepted.Count;files_created=0;model_requests=0;service_changes=0} | ConvertTo-Json
  return
}
function Read-FixtureIdentity([string]$path) {
  $item = Get-Item -LiteralPath (Assert-FixturePath $path)
  [pscustomobject][ordered]@{name=$item.Name;initialPath=$item.FullName;retainedPath=(Join-Path $fixtureCurrent $item.Name);bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();fileID=(& fsutil file queryfileid $path | Out-String).Trim();volume=(Get-Volume -DriveLetter D).UniqueId}
}
function Write-NewFixture([string]$path, [byte[]]$bytes) {
  $file = [IO.File]::Open((Assert-FixturePath $path), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}
function Fetch-Fixture([string]$url, [string]$name, [long]$expectedBytes) {
  $response = $fixtureClient.GetAsync($url,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  try {
    $response.EnsureSuccessStatusCode() | Out-Null
    if ($response.Content.Headers.ContentLength -ne $expectedBytes -or $expectedBytes -gt 4MB) { throw 'Fixture source changed its expected bounded size' }
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $memory = [IO.MemoryStream]::new()
    try {
      $buffer = [byte[]]::new(65536)
      while (($read = $stream.Read($buffer,0,$buffer.Length)) -gt 0) {
        if ($memory.Length + $read -gt $expectedBytes) { throw 'Fixture source exceeded its announced size' }
        $memory.Write($buffer,0,$read)
      }
      if ($memory.Length -ne $expectedBytes) { throw 'Fixture source was truncated' }
      Write-NewFixture (Join-Path $fixtureStage $name) $memory.ToArray()
    } finally { $stream.Dispose(); $memory.Dispose() }
  } finally { $response.Dispose() }
}
[void](Assert-FixturePath $fixtureStage)
[void](Assert-FixturePath $fixtureCurrent)
if ((Get-FileHash -LiteralPath $fixtureFfmpeg -Algorithm SHA256).Hash -ne '1326DDE4C84FF1F96FE6B8916C5BED29E163E9B5DCCF995F6F3DB069D143EC5E' -or
    (Get-FileHash -LiteralPath $fixtureFfprobe -Algorithm SHA256).Hash -ne 'B49CCC7C6547B141AD5A2F6EC69CC04323D7133D7704D70B331B904C63EECB07') { throw 'Installed media helper identity changed; do not select by version alone' }
$fixtureLock = [IO.File]::Open((Join-Path $fixtureRoot 'build.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$fixtureClient = [Net.Http.HttpClient]::new()
$fixtureClient.Timeout = [TimeSpan]::FromSeconds(45)
try {
  if (Test-Path -LiteralPath $fixtureCurrent) {
    $state = Get-Content -LiteralPath (Join-Path $fixtureCurrent 'FIXTURES_CURRENT.json') -Raw | ConvertFrom-Json
    if ($state.schema -ne 'gulong-probe-source-fixtures-v1' -or $state.recipe -ne 'nasa-pose-jfk-16frames-v1' -or @($state.files).Count -ne 3 -or
        @($state.files.name | Select-Object -Unique).Count -ne 3) { throw 'Unknown retained fixture payload; preserve for owner inspection' }
    foreach ($entry in $state.files) {
      if (!$fixtureExpectedHashes.ContainsKey($entry.name) -or $entry.sha256 -ne $fixtureExpectedHashes[$entry.name] -or
          (Get-FileHash -LiteralPath (Assert-FixturePath (Join-Path $fixtureCurrent $entry.name)) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw 'Retained fixture source hash mismatch; preserve evidence' }
    }
    [pscustomobject]@{status='reused-verified-current';root=$fixtureCurrent;files=$state.files.Count;bytes=($state.files | Measure-Object bytes -Sum).Sum} | ConvertTo-Json
    return
  }
  if (Test-Path -LiteralPath $fixtureStage) { throw 'Single staging slot is occupied; no new slot will be created' }
  if ((Get-PSDrive D).Free -lt 64MB) { throw 'Insufficient fixture preparation budget' }
  if (@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|npm|vite)(\.exe)?$' -and $_.CommandLine -like '*GulongAgent*' }).Count) { throw 'Website runtime/build is active; wait for its safe checkpoint' }
  $beforeRoot = @(Get-ChildItem -LiteralPath 'D:\' -Force | Select-Object -ExpandProperty Name)
  New-Item -ItemType Directory -Path $fixtureStage | Out-Null
  Fetch-Fixture 'https://www.nasa.gov/wp-content/uploads/2023/03/iss067e147098.jpg?w=1024' 'nasa-pose-source.jpg' 127056
  Fetch-Fixture 'https://raw.githubusercontent.com/openai/whisper/86098128c0b4f24f0e2aa2994de830614b474227/tests/jfk.flac' 'jfk.flac' 1152693
  foreach ($sourceName in @('nasa-pose-source.jpg','jfk.flac')) {
    if ((Get-FileHash -LiteralPath (Join-Path $fixtureStage $sourceName) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fixtureExpectedHashes[$sourceName]) { throw 'Fixture upstream content identity changed; preserve failed evidence and do not promote' }
  }
  # One still image repeated for a short full-frame plumbing probe; not a
  # benchmark or a claim of motion-quality/dynamic tracking validation.
  & $fixtureFfmpeg -hide_banner -loglevel error -nostdin -n -threads 1 -loop 1 -i (Join-Path $fixtureStage 'nasa-pose-source.jpg') -t 2 -vf 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white,fps=8' -an -c:v libx264 -threads 1 -pix_fmt yuv420p -movflags +faststart (Join-Path $fixtureStage 'pose-16frames.mp4')
  if ($LASTEXITCODE) { throw 'Bounded fixture encoding failed' }
  $video = (& $fixtureFfprobe -v error -count_frames -show_entries stream=codec_type,width,height,nb_read_frames -show_entries format=duration -of json (Join-Path $fixtureStage 'pose-16frames.mp4') | Out-String | ConvertFrom-Json)
  $audio = (& $fixtureFfprobe -v error -show_entries stream=codec_type,sample_rate,channels -show_entries format=duration -of json (Join-Path $fixtureStage 'jfk.flac') | Out-String | ConvertFrom-Json)
  if ($LASTEXITCODE -or @($video.streams).Count -ne 1 -or $video.streams[0].nb_read_frames -ne '16' -or [double]$video.format.duration -ne 2 -or
      @($audio.streams).Count -ne 1 -or $audio.streams[0].codec_type -ne 'audio' -or [double]$audio.format.duration -gt 12) { throw 'Fixture media metadata is not the bounded expected input' }
  $files = @(Get-ChildItem -LiteralPath $fixtureStage -File | ForEach-Object { Read-FixtureIdentity $_.FullName })
  foreach ($entry in $files) { if ($entry.sha256 -ne $fixtureExpectedHashes[$entry.name]) { throw 'Fixture encoded content identity changed; do not promote unverified payload' } }
  if (($files | Measure-Object bytes -Sum).Sum -gt 8MB) { throw 'Fixture preparation exceeded the eight-megabyte payload budget' }
  $state = [ordered]@{schema='gulong-probe-source-fixtures-v1';owner='/root:gulong-website';controlledRoot=$fixtureRoot;recipe='nasa-pose-jfk-16frames-v1';status='source-assets-prepared-not-model-verified';payloadBytes=($files | Measure-Object bytes -Sum).Sum;files=$files;video=$video;audio=$audio;createdAt=[DateTime]::UtcNow.ToString('o');model_requests=0;service_changes=0}
  Write-NewFixture (Join-Path $fixtureStage 'FIXTURES_CURRENT.json') ([Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Depth 10)))
  Move-Item -LiteralPath (Assert-FixturePath $fixtureStage) -Destination (Assert-FixturePath $fixtureCurrent)
  $afterRoot = @(Get-ChildItem -LiteralPath 'D:\' -Force | Select-Object -ExpandProperty Name)
  [pscustomobject]@{status=$state.status;root=$fixtureCurrent;bytes=($files | Measure-Object bytes -Sum).Sum;staging_exists=(Test-Path -LiteralPath $fixtureStage);drive_root_unchanged=!(Compare-Object $beforeRoot $afterRoot);model_requests=0;service_changes=0} | ConvertTo-Json
} finally { $fixtureClient.Dispose(); $fixtureLock.Dispose() }
