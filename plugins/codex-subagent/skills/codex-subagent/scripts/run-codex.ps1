[CmdletBinding()]
param(
  [ValidateSet('exec', 'review', 'resume', 'accounts', 'init-account')]
  [string]$Mode = 'exec',

  [string]$Account = '',
  [string]$CodexHome = '',

  [ValidateSet('read-only', 'workspace-write')]
  [string]$Sandbox = 'read-only',

  [string]$WorkingDir = (Get-Location).Path,
  [string]$Model = '',
  [int]$TimeoutSeconds = 300,
  [string]$SessionId = '',
  [switch]$Last,
  [switch]$Uncommitted,
  [string]$Base = '',
  [string]$Commit = '',
  [switch]$KeepSession,
  [switch]$Worktree,
  [string[]]$Image = @(),
  [string]$OutputSchema = '',
  [switch]$Trust,
  [string]$Prompt = '',
  [string]$PromptFile = ''
)

$ErrorActionPreference = 'Stop'

function Write-Stderr {
  param([string]$Message)
  [Console]::Error.WriteLine($Message)
}

if ($TimeoutSeconds -le 0) {
  Write-Stderr "ERROR: -TimeoutSeconds must be a positive integer in seconds, got: $TimeoutSeconds"
  exit 2
}

$codexExe = Get-Command codex.exe -ErrorAction SilentlyContinue
$codexCmd = if ($codexExe) { $codexExe } else { Get-Command codex -ErrorAction SilentlyContinue }
if (-not $codexCmd) {
  Write-Stderr "ERROR: codex CLI not found in Windows PATH. Install OpenAI Codex CLI and run 'codex login' first."
  exit 127
}

function Resolve-CodexLauncher {
  param([System.Management.Automation.CommandInfo]$Cmd)
  $targetExe = $Cmd.Source
  $prefixArgs = [System.Collections.Generic.List[string]]::new()
  if ($targetExe -match '\.(ps1|cmd|bat)$') {
    $shimDir = Split-Path $targetExe -Parent
    $codexJs = Join-Path $shimDir 'node_modules\@openai\codex\bin\codex.js'
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ((Test-Path $codexJs) -and $nodeCmd) {
      $targetExe = $nodeCmd.Source
      $prefixArgs.Add($codexJs)
    } elseif ($targetExe -match '\.ps1$') {
      $pwshCmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
      $targetExe = if ($pwshCmd) { $pwshCmd.Source } else { 'powershell.exe' }
      $prefixArgs.Add('-NoProfile')
      $prefixArgs.Add('-File')
      $prefixArgs.Add($Cmd.Source)
    }
  }
  return @{ Exe = $targetExe; PrefixArgs = $prefixArgs }
}

function Resolve-CodexHomePath {
  param([string]$Acc, [string]$CustomHome)
  if ($CustomHome) { return $CustomHome }
  if (-not $Acc) {
    if ($env:CODEX_HOME) { return $env:CODEX_HOME }
    return (Join-Path $env:USERPROFILE '.codex')
  }
  if ($Acc -eq 'default' -or $Acc -eq '1') {
    return (Join-Path $env:USERPROFILE '.codex')
  }
  if ($Acc -notmatch '^[A-Za-z0-9._-]+$') {
    Write-Stderr "ERROR: Invalid account alias '$Acc' (allowed characters: A-Z, a-z, 0-9, '.', '_', '-')."
    exit 2
  }
  $legacyDir = Join-Path $env:USERPROFILE ".codex-$Acc"
  if (Test-Path $legacyDir -PathType Container) { return $legacyDir }
  return (Join-Path (Join-Path $env:USERPROFILE '.codex-accounts') $Acc)
}

function Ensure-AccountDir {
  param([string]$Dir)
  if (-not (Test-Path $Dir -PathType Container)) {
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  }
  $cfg = Join-Path $Dir 'config.toml'
  if (-not (Test-Path $cfg -PathType Leaf)) {
    [System.IO.File]::WriteAllText($cfg, "cli_auth_credentials_store = `"file`"`n", [System.Text.UTF8Encoding]::new($false))
  } else {
    $raw = Get-Content -Raw -Encoding UTF8 $cfg
    if ($raw -notmatch '(?m)^\s*cli_auth_credentials_store\s*=') {
      [System.IO.File]::AppendAllText($cfg, "`ncli_auth_credentials_store = `"file`"`n", [System.Text.UTF8Encoding]::new($false))
    }
  }
}

function Get-AccountStatusLine {
  param([string]$Label, [string]$Dir, [hashtable]$Launcher)
  $prevHome = $env:CODEX_HOME
  try {
    $env:CODEX_HOME = $Dir
    $allArgs = @($Launcher.PrefixArgs) + @('login', 'status')
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = (& $Launcher.Exe @allArgs 2>&1 | Out-String).Trim()
    $rc = $LASTEXITCODE
    $ErrorActionPreference = $prevPref
    if ($rc -eq 0) {
      return ('{0,-14} | {1,-48} | {2}' -f $Label, $Dir, $out)
    }
    return ('{0,-14} | {1,-48} | NOT LOGGED IN ({2})' -f $Label, $Dir, ($out -replace '\r?\n', ' '))
  } finally {
    if ($null -eq $prevHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME = $prevHome }
  }
}

$launcher = Resolve-CodexLauncher -Cmd $codexCmd

if ($Mode -eq 'accounts') {
  Write-Output 'ACCOUNT        | CODEX_HOME                                       | STATUS'
  Write-Output '---------------+--------------------------------------------------+------------------------------'
  Write-Output (Get-AccountStatusLine -Label 'default' -Dir (Join-Path $env:USERPROFILE '.codex') -Launcher $launcher)
  $accRoot = Join-Path $env:USERPROFILE '.codex-accounts'
  if (Test-Path $accRoot -PathType Container) {
    Get-ChildItem $accRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Output (Get-AccountStatusLine -Label $_.Name -Dir $_.FullName -Launcher $launcher)
    }
  }
  Get-ChildItem $env:USERPROFILE -Directory -Filter '.codex-*' -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -ne '.codex-accounts' -and (
      (Test-Path (Join-Path $_.FullName 'config.toml') -PathType Leaf) -or
      (Test-Path (Join-Path $_.FullName 'auth.json') -PathType Leaf)
    )
  } | ForEach-Object {
    Write-Output (Get-AccountStatusLine -Label ($_.Name -replace '^\.codex-', '') -Dir $_.FullName -Launcher $launcher)
  }
  exit 0
}

$targetHome = Resolve-CodexHomePath -Acc $Account -CustomHome $CodexHome

if ($Mode -eq 'init-account') {
  if (-not $Account -and -not $CodexHome) {
    Write-Stderr 'ERROR: init-account mode requires -Account <name> or -CodexHome <dir>.'
    exit 2
  }
  Ensure-AccountDir -Dir $targetHome
  Write-Output "Initialized account directory: $targetHome"
  $lbl = if ($Account) { $Account } else { 'custom' }
  Write-Output (Get-AccountStatusLine -Label $lbl -Dir $targetHome -Launcher $launcher)
  Write-Output 'If not yet logged in, run the following in your interactive terminal:'
  Write-Output "  `$env:CODEX_HOME = `"$targetHome`"; codex login"
  exit 0
}

if (-not (Test-Path $targetHome -PathType Container)) {
  $hintAcc = if ($Account) { $Account } else { '2' }
  Write-Stderr "ERROR: Account directory does not exist: $targetHome (run '-Mode init-account -Account $hintAcc' and log in first)."
  exit 2
}

if (-not (Test-Path $WorkingDir -PathType Container)) {
  Write-Stderr "ERROR: Working directory does not exist: $WorkingDir"
  exit 2
}

if ($OutputSchema -and -not (Test-Path $OutputSchema -PathType Leaf)) {
  Write-Stderr "ERROR: File specified by -OutputSchema does not exist: $OutputSchema"
  exit 2
}

$imageList = @($Image | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($imageList.Count -gt 0) {
  if ($Mode -eq 'review') {
    Write-Stderr 'ERROR: -Image is not supported in review mode; use "-Mode exec -Sandbox read-only" for image-assisted analysis.'
    exit 2
  }
  foreach ($img in $imageList) {
    if (-not (Test-Path $img -PathType Leaf)) {
      Write-Stderr "ERROR: File specified by -Image does not exist: $img"
      exit 2
    }
  }
}

if ($PromptFile) {
  if (-not (Test-Path $PromptFile -PathType Leaf)) {
    Write-Stderr "ERROR: File specified by -PromptFile does not exist: $PromptFile"
    exit 2
  }
  $Prompt = Get-Content -Raw -Encoding UTF8 -Path $PromptFile
} elseif ([string]::IsNullOrEmpty($Prompt) -and [Console]::IsInputRedirected) {
  $Prompt = [Console]::In.ReadToEnd()
}

# Normalize whitespace-only stdin so an empty pipe is not treated as a custom prompt
if ([string]::IsNullOrWhiteSpace($Prompt)) {
  $Prompt = ''
}

if ($Mode -eq 'review') {
  $reviewScopeCount = 0
  if ($Uncommitted) { $reviewScopeCount++ }
  if ($Base) { $reviewScopeCount++ }
  if ($Commit) { $reviewScopeCount++ }

  if ($reviewScopeCount -gt 1) {
    Write-Stderr 'ERROR: In review mode, -Uncommitted, -Base, and -Commit are mutually exclusive; specify at most one.'
    exit 2
  }
  if ($reviewScopeCount -gt 0 -and -not [string]::IsNullOrEmpty($Prompt)) {
    Write-Stderr 'ERROR: In review mode, -Uncommitted / -Base / -Commit cannot be combined with a custom prompt. Use "-Mode exec -Sandbox read-only" for custom review instructions, or pass a prompt without scope flags.'
    exit 2
  }
}

if ($Mode -eq 'resume') {
  if (-not $Last -and -not $SessionId) {
    Write-Stderr 'ERROR: resume mode requires -Last or -SessionId <id>.'
    exit 2
  }
  if ($Last -and $SessionId) {
    Write-Stderr 'ERROR: In resume mode, -Last and -SessionId are mutually exclusive; specify only one.'
    exit 2
  }
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-subagent-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir | Out-Null
$prevCodexHome = $env:CODEX_HOME

try {
  $env:CODEX_HOME = $targetHome
  $outFile = Join-Path $tmpDir 'last_message.md'
  $inFile = Join-Path $tmpDir 'prompt.txt'
  $stdoutFile = Join-Path $tmpDir 'stdout.log'
  $stderrFile = Join-Path $tmpDir 'stderr.log'

  # Top-level exec flags must appear after 'exec' and before any subcommand (review/resume)
  $argsList = [System.Collections.Generic.List[string]]::new()
  foreach ($pa in $launcher.PrefixArgs) { $argsList.Add($pa) }
  $argsList.Add('exec')
  $argsList.Add('--color'); $argsList.Add('never')
  $argsList.Add('-C'); $argsList.Add($WorkingDir)
  $argsList.Add('--skip-git-repo-check')

  if ($Mode -eq 'exec' -or $Mode -eq 'resume') {
    $argsList.Add('--sandbox'); $argsList.Add($Sandbox)
  }
  if ($Model) {
    $argsList.Add('-m'); $argsList.Add($Model)
  }
  if ($Worktree) {
    $argsList.Add('--worktree')
  }
  if ($Trust) {
    $argsList.Add('--trust')
  }
  if ($OutputSchema) {
    $argsList.Add('--output-schema'); $argsList.Add($OutputSchema)
  }
  # Apply --ephemeral by default for exec/review unless -KeepSession is set; resume preserves continuity
  if (($Mode -eq 'exec' -or $Mode -eq 'review') -and -not $KeepSession) {
    $argsList.Add('--ephemeral')
  }
  # Place -i before -o in exec mode so variadic <FILE>... does not greedily consume positional "-"
  if ($Mode -eq 'exec' -and $imageList.Count -gt 0) {
    foreach ($img in $imageList) {
      $argsList.Add('-i'); $argsList.Add($img)
    }
  }
  $argsList.Add('-o'); $argsList.Add($outFile)

  switch ($Mode) {
    'exec' {
    }
    'review' {
      $argsList.Add('review')
      if ($Uncommitted) { $argsList.Add('--uncommitted') }
      if ($Base) { $argsList.Add('--base'); $argsList.Add($Base) }
      if ($Commit) { $argsList.Add('--commit'); $argsList.Add($Commit) }
    }
    'resume' {
      $argsList.Add('resume')
      if ($imageList.Count -gt 0) {
        foreach ($img in $imageList) {
          $argsList.Add('-i'); $argsList.Add($img)
        }
      }
      if ($Last) { $argsList.Add('--last') }
      if ($SessionId) { $argsList.Add($SessionId) }
    }
  }

  $startParams = @{
    FilePath               = $launcher.Exe
    WorkingDirectory       = $WorkingDir
    NoNewWindow            = $true
    PassThru               = $true
    RedirectStandardOutput = $stdoutFile
    RedirectStandardError  = $stderrFile
  }

  if (-not [string]::IsNullOrEmpty($Prompt)) {
    [System.IO.File]::WriteAllText($inFile, $Prompt, [System.Text.UTF8Encoding]::new($false))
    $argsList.Add('-')
    $startParams['RedirectStandardInput'] = $inFile
  }

  $startParams['ArgumentList'] = $argsList
  $proc = Start-Process @startParams

  if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
    try { & taskkill.exe /T /F /PID $proc.Id 2>$null | Out-Null } catch {}
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    Write-Stderr "ERROR: CODEX_TIMEOUT: Process exceeded ${TimeoutSeconds}s and was terminated."
    if (Test-Path $stderrFile) {
      Get-Content $stderrFile -Tail 40 | ForEach-Object { Write-Stderr $_ }
    }
    exit 124
  }

  $proc.WaitForExit()
  if ((Test-Path $outFile) -and (Get-Item $outFile).Length -gt 0) {
    Get-Content -Raw -Encoding UTF8 -Path $outFile | Write-Output
  }

  if ($proc.ExitCode -ne 0) {
    Write-Stderr "=== CODEX_FAILED (exit=$($proc.ExitCode), CODEX_HOME=$targetHome) ==="
    if (Test-Path $stderrFile) {
      Get-Content $stderrFile -Tail 60 | ForEach-Object { Write-Stderr $_ }
    }
    exit $proc.ExitCode
  }
} finally {
  if ($null -eq $prevCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME = $prevCodexHome }
  Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
