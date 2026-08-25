# PatchProof one-command installer for Windows (PowerShell 5.1+).
#
# Recommended (download first, inspect, then run):
#   Invoke-WebRequest https://raw.githubusercontent.com/kwlck/PatchProof/main/install/install.ps1 -OutFile install-patchproof.ps1
#   powershell -ExecutionPolicy Bypass -File .\install-patchproof.ps1
#
# Installs the standalone PatchProof CLI into %USERPROFILE%\.patchproof, downloads
# a pinned standalone Node.js runtime when no suitable Node is present, verifies
# every download against published SHA-256 checksums, and puts patchproof on PATH.

$ErrorActionPreference = 'Stop'

$PatchProofRepo = 'kwlck/PatchProof'
$NodeVersion = '22.14.0'
$InstallRoot = if ($env:PATCHPROOF_HOME) { $env:PATCHPROOF_HOME } else { Join-Path $env:USERPROFILE '.patchproof' }
$BinDir = Join-Path $InstallRoot 'bin'
$LibDir = Join-Path $InstallRoot 'lib'
$RuntimeDir = Join-Path $InstallRoot 'runtime'

function Write-Log([string]$Message) { Write-Host "patchproof-install: $Message" }
function Fail([string]$Message) {
    Write-Host "patchproof-install: error: $Message" -ForegroundColor Red
    exit 1
}

function Get-NodeMajor {
    try {
        $version = (& node -v 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not $version) { return 0 }
        return [int]($version.TrimStart('v').Split('.')[0])
    } catch { return 0 }
}

function Ensure-Node {
    $major = Get-NodeMajor
    if ($major -ge 22) {
        Write-Log "using existing Node.js $(& node -v)"
        $script:NodeExe = (Get-Command node).Source
        return
    }
    if ($major -eq 0) { Write-Log 'Node.js not found' } else { Write-Log "Node.js v$major is too old" }
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        'ARM64' { 'arm64' }
        'AMD64' { 'x64' }
        default { 'x86' }
    }
    $archive = "node-v$NodeVersion-win-$arch.zip"
    $url = "https://nodejs.org/dist/v$NodeVersion/$archive"
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Write-Log "downloading Node.js v$NodeVersion ($arch)"
    $archivePath = Join-Path $RuntimeDir $archive
    Invoke-WebRequest -Uri $url -OutFile $archivePath -UseBasicParsing
    $shasumsPath = Join-Path $RuntimeDir 'SHASUMS256.txt'
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $shasumsPath -UseBasicParsing
    $entry = (Get-Content $shasumsPath) | Where-Object { $_ -match ([regex]::Escape(" $archive") + '$') } | Select-Object -First 1
    if (-not $entry) { Fail "Node checksum entry not found for $archive" }
    $expected = ($entry.Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { Fail 'Node.js download failed checksum verification' }
    Expand-Archive -Path $archivePath -DestinationPath $RuntimeDir -Force
    Remove-Item -LiteralPath $archivePath -Force
    Remove-Item -LiteralPath $shasumsPath -Force
    $script:NodeExe = Join-Path $RuntimeDir "node-v$NodeVersion-win-$arch\node.exe"
    if (-not (Test-Path $script:NodeExe)) { Fail 'downloaded Node.js binary is missing' }
    $env:Path = (Split-Path $script:NodeExe) + ';' + $env:Path
    Write-Log "installed Node.js v$NodeVersion into $RuntimeDir"
}

function Resolve-Version {
    if ($env:PATCHPROOF_VERSION) {
        $script:ReleaseTag = $env:PATCHPROOF_VERSION
    } else {
        Write-Log 'resolving the latest release'
        try {
            $payload = Invoke-RestMethod -Uri "https://api.github.com/repos/$PatchProofRepo/releases/latest" -UseBasicParsing
        } catch { Fail 'cannot reach GitHub releases; set PATCHPROOF_VERSION=<tag> and retry' }
        $script:ReleaseTag = [string]$payload.tag_name
    }
    if (-not $script:ReleaseTag) { Fail 'could not determine a release tag' }
    $script:Version = $script:ReleaseTag.TrimStart('v')
    Write-Log "installing PatchProof $script:ReleaseTag"
}

function Download-Release {
    New-Item -ItemType Directory -Force -Path $LibDir, $BinDir | Out-Null
    $base = "https://github.com/$PatchProofRepo/releases/download/$ReleaseTag"
    $tgzName = "patchproof-$Version.tgz"
    Write-Log "downloading $tgzName"
    $tgzPath = Join-Path $LibDir $tgzName
    $sumsPath = Join-Path $LibDir 'SHA256SUMS'
    Invoke-WebRequest -Uri "$base/$tgzName" -OutFile $tgzPath -UseBasicParsing
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing
    $entry = (Get-Content $sumsPath) | Where-Object { $_ -match ([regex]::Escape(" $tgzName") + '$') } | Select-Object -First 1
    if (-not $entry) { Fail "checksum entry not found for $tgzName" }
    $expected = ($entry.Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tgzPath).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { Fail 'PatchProof download failed checksum verification' }
    tar -xzf $tgzPath -C $LibDir
    if ($LASTEXITCODE -ne 0) { Fail 'failed to extract the release archive' }
    $bundle = Join-Path $LibDir 'package\bin\patchproof.js'
    if (-not (Test-Path $bundle)) { Fail 'release archive has an unexpected layout' }
    Move-Item -LiteralPath $bundle -Destination (Join-Path $LibDir 'patchproof.js') -Force
    Remove-Item -LiteralPath (Join-Path $LibDir 'package') -Recurse -Force
    Remove-Item -LiteralPath $tgzPath, $sumsPath -Force
}

function Write-Launcher {
    $launcher = Join-Path $BinDir 'patchproof.cmd'
    @"
@echo off
if defined PATCHPROOF_NODE (
  "%PATCHPROOF_NODE%" "$LibDir\patchproof.js" %*
) else (
  "$NodeExe" "$LibDir\patchproof.js" %*
)
"@ | Set-Content -LiteralPath $launcher -Encoding ASCII
}

function Add-ToUserPath {
    $sessionPath = [Environment]::GetEnvironmentVariable('Path', 'Process')
    if ((';' + $sessionPath + ';').Contains(';' + $BinDir + ';')) { return }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -contains $BinDir) {
        $env:Path = "$BinDir;$env:Path"
        return
    }
    [Environment]::SetEnvironmentVariable('Path', ("$userPath;$BinDir").Trim(';'), 'User')
    $env:Path = "$BinDir;$env:Path"
    Write-Log "added $BinDir to your user PATH (open a new terminal to pick it up)"
}

function Test-DockerReady {
    try {
        $null = & docker version 2>$null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Offer-Docker {
    if (Test-DockerReady) { return }
    Write-Host ''
    Write-Log 'Docker is required for production runs and was not found.'
    if ([Console]::IsInputRedirected) {
        Write-Log 'non-interactive shell: install Docker from https://docs.docker.com/get-docker/'
        return
    }
    $answer = Read-Host 'Install Docker Desktop now via winget? [y/N]'
    if ($answer -match '^(y|yes)$') {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            & winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements
            Write-Log 'launch Docker Desktop once and accept its license; a sign-out may be required'
        } else {
            Write-Log 'winget unavailable; install Docker from https://docs.docker.com/get-docker/'
        }
    } else {
        Write-Log 'skipped. install Docker from https://docs.docker.com/get-docker/'
    }
}

Ensure-Node
Resolve-Version
Download-Release
Write-Launcher
Add-ToUserPath
Offer-Docker

Write-Log 'verifying the installation'
patchproof setup --check
if ($LASTEXITCODE -ne 0) {
    Write-Log 'environment check reported problems above; fix them, then run: patchproof setup --demo'
} else {
    Write-Host ''
    Write-Host 'PatchProof is installed.'
    Write-Host 'Next steps:'
    Write-Host '  patchproof setup --demo        # prove the full pipeline in ~30 seconds'
    Write-Host '  patchproof init <directory>    # start your own scenario'
    Write-Host '  patchproof --help              # all commands'
}
