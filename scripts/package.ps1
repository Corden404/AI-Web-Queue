$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageInfo = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$releaseRoot = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$archivePath = Join-Path $releaseRoot ("chatgpt-web-queue-v{0}.zip" -f $packageInfo.version)
if (Test-Path -LiteralPath $archivePath) {
    $trashRoot = Join-Path $projectRoot '.trash'
    New-Item -ItemType Directory -Path $trashRoot -Force | Out-Null
    Move-Item -LiteralPath $archivePath -Destination (Join-Path $trashRoot ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + (Split-Path -Leaf $archivePath)))
}
Compress-Archive -Path (Join-Path $projectRoot 'dist\*') -DestinationPath $archivePath
Write-Output $archivePath
