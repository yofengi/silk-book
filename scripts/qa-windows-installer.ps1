param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
# NSIS writes product registrations even with /D. This check must never run in a
# developer's normal profile; GitHub-hosted runners are disposable.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true') {
  throw 'Installer smoke tests are restricted to disposable GitHub Actions runners.'
}
$setup = (Resolve-Path -LiteralPath $Installer).Path
$runnerRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$testRoot = [IO.Path]::GetFullPath((Join-Path $runnerRoot 'silk-book-installer-smoke'))
if (-not $testRoot.StartsWith($runnerRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installer test directory escaped the runner temporary directory.'
}
$installDirectory = Join-Path $testRoot 'application'
$profileDirectory = Join-Path $testRoot 'profile'
New-Item -ItemType Directory -Path $installDirectory, (Join-Path $profileDirectory 'Boshu') -Force | Out-Null
$previousAppData = $env:APPDATA
$previousWebview = $env:WEBVIEW2_USER_DATA_FOLDER
$expectedExe = Join-Path $installDirectory 'boshu.exe'
$ownedProcesses = { Get-CimInstance Win32_Process -Filter "Name = 'boshu.exe'" | Where-Object { $_.ExecutablePath -eq $expectedExe } }
$installerProcesses = @()
function Wait-InstallerExit {
  param([Diagnostics.Process]$Process, [string]$Step, [int]$TimeoutSeconds = 120)
  # Start-Process -Wait waits for the entire process tree. /R intentionally
  # launches a persistent app; wait only for the installer process we started.
  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
    throw "$Step installer did not exit within $TimeoutSeconds seconds (PID $($Process.Id))."
  }
  $Process.Refresh()
  if ($Process.ExitCode -ne 0) { throw "$Step installer failed with exit code $($Process.ExitCode)." }
}
try {
  $env:APPDATA = $profileDirectory
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $testRoot 'webview'
  $settingsPath = Join-Path $profileDirectory 'Boshu\settings.json'
  $settingsText = '{"workbench.language":"en","updates.autoDownload":false,"updates.intervalHours":720}'
  [IO.File]::WriteAllText($settingsPath, $settingsText)
  $documentPath = Join-Path $testRoot 'user-document.txt'
  [IO.File]::WriteAllText($documentPath, 'Installer must preserve this user document.')
  $documentHash = (Get-FileHash -LiteralPath $documentPath -Algorithm SHA256).Hash

  $initial = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$installDirectory") -WindowStyle Hidden -PassThru
  $installerProcesses += $initial
  Wait-InstallerExit -Process $initial -Step 'Silent first installation'
  if (-not (Test-Path -LiteralPath $expectedExe)) { throw 'Silent first installation did not create the executable.' }
  if (@(& $ownedProcesses).Count -ne 0) { throw 'First installation unexpectedly launched the application.' }
  $binaryHash = (Get-FileHash -LiteralPath $expectedExe -Algorithm SHA256).Hash
  # These are the flags the official updater uses for quiet NSIS upgrades and restart.
  $upgrade = Start-Process -FilePath $setup -ArgumentList @('/S', '/UPDATE', '/R', "/D=$installDirectory") -WindowStyle Hidden -PassThru
  $installerProcesses += $upgrade
  Wait-InstallerExit -Process $upgrade -Step 'Silent in-place upgrade'
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $running = @(& $ownedProcesses)
    if ($running.Count -gt 0) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($running.Count -ne 1) { throw 'Upgrade did not restart exactly one installed application.' }
  Start-Sleep -Seconds 3
  if (@(& $ownedProcesses).Count -ne 1) { throw 'Installed application exited during startup.' }
  if ((Get-FileHash -LiteralPath $expectedExe -Algorithm SHA256).Hash -ne $binaryHash) { throw 'Upgrade installed unexpected executable bytes.' }
  if ([IO.File]::ReadAllText($settingsPath) -ne $settingsText) { throw 'Upgrade changed existing user settings.' }
  if ((Get-FileHash -LiteralPath $documentPath -Algorithm SHA256).Hash -ne $documentHash) { throw 'Upgrade changed the user document.' }
  Write-Output 'PASS silent first install, in-place upgrade, restart, and settings/document preservation on disposable runner.'
} finally {
  foreach ($installerProcess in $installerProcesses) {
    try { if (-not $installerProcess.HasExited) { $installerProcess.Kill() } }
    catch { Write-Warning "Could not close owned installer process $($installerProcess.Id): $_" }
    finally { $installerProcess.Dispose() }
  }
  foreach ($owned in @(& $ownedProcesses)) { Stop-Process -Id $owned.ProcessId -ErrorAction SilentlyContinue }
  $env:APPDATA = $previousAppData
  $env:WEBVIEW2_USER_DATA_FOLDER = $previousWebview
}
