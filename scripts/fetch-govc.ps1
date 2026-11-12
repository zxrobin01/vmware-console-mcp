# Fetch govc (govmomi CLI) into tools/ for the ESXi backend.
# Usage: scripts\fetch-govc.ps1 [-Version v0.56.2] [-Dest D:\path\govc.exe]
param(
  [string]$Version = "v0.56.2",
  [string]$Dest = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $Dest) { $Dest = Join-Path $root "tools\govc.exe" }
$toolsDir = Split-Path -Parent $Dest
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$url = "https://github.com/vmware/govmomi/releases/download/$Version/govc_Windows_x86_64.zip"
$expectedSha256 = "c9a050960da949317da230b0def5aa480a4138db96968d6919afd0c9a19f6b40"
$zip = Join-Path $toolsDir "govc.zip"

Write-Host "Downloading govc $Version ..."
try {
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
} catch {
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe --ssl-no-revoke -L --retry 3 -o $zip $url
    if ($LASTEXITCODE -ne 0) { throw "curl failed to download govc" }
  } else { throw }
}

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $expectedSha256) {
  throw "govc checksum mismatch: expected $expectedSha256, got $hash. Refusing to install."
}

Expand-Archive -Path $zip -DestinationPath $toolsDir -Force
Remove-Item $zip -Force
& $Dest version
Write-Host "govc installed at $Dest"
