[CmdletBinding()]
param(
  [switch]$List,
  [switch]$Uninstall,
  [string]$Dest = '',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Plugins = @()
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginsSrc = Join-Path $scriptDir 'plugins'
$destDir = if ($Dest) {
  $Dest
} elseif ($env:AGY_PLUGINS_DIR) {
  $env:AGY_PLUGINS_DIR
} else {
  Join-Path $env:USERPROFILE '.gemini\config\plugins'
}

$available = Get-ChildItem -Path $pluginsSrc -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'plugin.json') -PathType Leaf } |
  Sort-Object Name |
  Select-Object -ExpandProperty Name

if ($List) {
  Write-Output "Available plugins in Antigravity Power Pack ($($available.Count)):"
  foreach ($p in $available) {
    Write-Output "  - $p"
  }
  exit 0
}

$targets = if ($Plugins.Count -gt 0) { $Plugins } else { $available }

foreach ($name in $targets) {
  if ($available -notcontains $name) {
    [Console]::Error.WriteLine("ERROR: Unknown plugin '$name'. Run '.\install.ps1 -List' to see valid names.")
    exit 2
  }
}

if ($Uninstall) {
  foreach ($name in $targets) {
    $targetPath = Join-Path $destDir $name
    if (Test-Path $targetPath -PathType Container) {
      Remove-Item -Path $targetPath -Recurse -Force
      Write-Output "Removed: $targetPath"
    } else {
      Write-Output "Not installed (skipped): $name"
    }
  }
  exit 0
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
foreach ($name in $targets) {
  $srcPath = Join-Path $pluginsSrc $name
  $targetPath = Join-Path $destDir $name
  if (Test-Path $targetPath) {
    Remove-Item -Path $targetPath -Recurse -Force
  }
  Copy-Item -Path $srcPath -Destination $targetPath -Recurse -Force
  Write-Output "Installed: $name -> $targetPath"
}

Write-Output ''
Write-Output 'Done. Open Antigravity -> Customizations -> Plugins to enable your installed plugins.'
