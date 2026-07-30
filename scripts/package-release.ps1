$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path $PSScriptRoot -Parent
$package = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$releaseDirectory = Join-Path $projectRoot 'release'
$sourceDirectory = Join-Path $releaseDirectory 'win-unpacked'
$sevenZipPattern = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\7zip@*\*\bin\7za.exe'
$sevenZip = Get-ChildItem -Path $sevenZipPattern -File -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not (Test-Path -LiteralPath $sourceDirectory)) {
  throw "Build directory does not exist: $sourceDirectory"
}

if ($sevenZip) {
  $archivePath = Join-Path $releaseDirectory "MemeHelper-$($package.version)-windows-x64.7z"
  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  Push-Location $sourceDirectory
  try {
    & $sevenZip.FullName a -t7z -mx=9 -m0=lzma2 -ms=on -mmt=on $archivePath '.\*'
    if ($LASTEXITCODE -ne 0) { throw "7-Zip exited with code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
} else {
  $archivePath = Join-Path $releaseDirectory "MemeHelper-$($package.version)-windows-x64.zip"
  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  Compress-Archive -Path (Join-Path $sourceDirectory '*') -DestinationPath $archivePath -CompressionLevel Optimal
}

Write-Host "Created $archivePath"
