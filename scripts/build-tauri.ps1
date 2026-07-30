$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path $PSScriptRoot -Parent
$package = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$cargoExe = Join-Path $cargoBin 'cargo.exe'
$xwinRoot = Join-Path $env:LOCALAPPDATA 'cargo-xwin\xwin'
$sdkUm = Join-Path $xwinRoot 'sdk\lib\um\x86_64'
$sdkUcrt = Join-Path $xwinRoot 'sdk\lib\ucrt\x86_64'
$crt = Join-Path $xwinRoot 'crt\lib\x86_64'
$portableSdkRoot = Join-Path $env:LOCALAPPDATA 'memehelper-tools\winsdk-10.0.26100.8249\package'
$portableRc = Join-Path $portableSdkRoot 'bin\10.0.26100.0\x64\rc.exe'

if (-not (Test-Path -LiteralPath $cargoExe)) {
  throw 'Rust/Cargo is not installed. Install the stable Windows Rust toolchain first.'
}

$env:Path = "$cargoBin;$env:Path"
if ((Test-Path -LiteralPath $sdkUm) -and (Test-Path -LiteralPath $sdkUcrt) -and (Test-Path -LiteralPath $crt)) {
  $env:RUSTFLAGS = @(
    '-C linker=rust-lld.exe'
    "-L native=$sdkUm"
    "-L native=$sdkUcrt"
    "-L native=$crt"
  ) -join ' '
  $env:INCLUDE = @(
    (Join-Path $xwinRoot 'sdk\include\shared')
    (Join-Path $xwinRoot 'sdk\include\um')
    (Join-Path $xwinRoot 'sdk\include\ucrt')
    (Join-Path $xwinRoot 'sdk\include\winrt')
  ) -join ';'
}
if (Test-Path -LiteralPath $portableRc) {
  $env:RC = $portableRc
}

Push-Location $projectRoot
try {
  & npm.cmd run build:tauri
  if ($LASTEXITCODE -ne 0) { throw "Tauri build exited with code $LASTEXITCODE" }

  $sourceExe = Join-Path $projectRoot 'src-tauri\target\release\MemeHelper.exe'
  if (-not (Test-Path -LiteralPath $sourceExe)) {
    throw "Built executable does not exist: $sourceExe"
  }

  $releaseRoot = Join-Path $projectRoot 'release-tauri'
  $releaseDirectory = Join-Path $releaseRoot "MemeHelper-$($package.version)"
  $resolvedProject = [IO.Path]::GetFullPath($projectRoot).TrimEnd('\')
  $resolvedRelease = [IO.Path]::GetFullPath($releaseDirectory)
  if (-not $resolvedRelease.StartsWith("$resolvedProject\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a release directory outside the project: $resolvedRelease"
  }
  if (Test-Path -LiteralPath $releaseDirectory) {
    Remove-Item -LiteralPath $releaseDirectory -Recurse -Force
  }
  New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null

  Copy-Item -LiteralPath $sourceExe -Destination (Join-Path $releaseDirectory 'MemeHelper.exe')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'src\bundled-templates.json') -Destination (Join-Path $releaseDirectory 'templates.json')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'config.json') -Destination (Join-Path $releaseDirectory 'config.json')

  $sevenZipPattern = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\7zip@*\*\bin\7za.exe'
  $sevenZip = Get-ChildItem -Path $sevenZipPattern -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($sevenZip) {
    $archivePath = Join-Path $releaseRoot "MemeHelper-$($package.version)-windows-x64.7z"
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    Push-Location $releaseDirectory
    try {
      & $sevenZip.FullName a -t7z -mx=9 -m0=lzma2 -ms=on -mmt=on $archivePath '.\*'
      if ($LASTEXITCODE -ne 0) { throw "7-Zip exited with code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
  }

  Write-Host "Created $releaseDirectory"
} finally {
  Pop-Location
}
