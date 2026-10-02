param([Parameter(Mandatory = $true)][string]$Installer, [string]$PreviousInstaller)
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
# NSIS uses KnownFolder rather than the APPDATA environment override. Both it
# and the Rust CLI must use the same disposable runner profile for uninstall QA.
$profileDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
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
function Invoke-AssociationCli {
  param([string[]]$Arguments)
  $process = Start-Process -FilePath $expectedExe -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  try { Wait-InstallerExit -Process $process -Step "Association CLI $($Arguments -join ' ')" }
  finally { $process.Dispose() }
}
function Assert-Associations {
  param([string[]]$Extensions)
  $saved = Get-Content -LiteralPath $choicesPath -Raw | ConvertFrom-Json
  if ($saved.version -ne 1 -or (@($saved.extensions | Sort-Object) -join ',') -ne (@($Extensions | Sort-Object) -join ',')) {
    throw 'Persisted association choices differ from the selected set.'
  }
  foreach ($extension in @('txt', 'lua', 'md', 'json')) {
    $progId = "Boshu.$extension"
    $registered = Test-Path -LiteralPath "HKCU:\Software\Classes\$progId\shell\open\command"
    if ($registered -ne ($Extensions -contains $extension)) { throw "Unexpected registration for .$extension" }
    if ($registered) {
      $command = (Get-Item -LiteralPath "HKCU:\Software\Classes\$progId\shell\open\command").GetValue('')
      if ($command -ne "`"$expectedExe`" `"%1`"") { throw "Registration for .$extension has a stale installation path." }
      $icon = (Get-Item -LiteralPath "HKCU:\Software\Classes\$progId\DefaultIcon").GetValue('')
      $iconName = if ($extension -eq 'lua') { 'file-code.ico' } else { 'file-text.ico' }
      if ($icon -ne "`"$(Join-Path (Split-Path -Parent $expectedExe) "icons\$iconName")`",0") { throw "Wrong icon for .$extension" }
      $capability = (Get-Item -LiteralPath 'HKCU:\Software\Boshu\Capabilities\FileAssociations').GetValue(".$extension")
      if ($capability -ne $progId) { throw "Missing capability for .$extension" }
      $openWith = Get-Item -LiteralPath "HKCU:\Software\Classes\.$extension\OpenWithProgids"
      if ($openWith.GetValueNames() -notcontains $progId) { throw "Missing OpenWith entry for .$extension" }
    }
  }
}
function Install-Quietly {
  param([string]$SetupPath, [string]$Directory, [string[]]$Extra = @())
  $process = Start-Process -FilePath $SetupPath -ArgumentList (@('/S') + $Extra + "/D=$Directory") -WindowStyle Hidden -PassThru
  $script:installerProcesses += $process
  Wait-InstallerExit -Process $process -Step 'Silent installation'
}
function Uninstall-KeepingData {
  $directory = Split-Path -Parent $expectedExe
  $process = Start-Process -FilePath (Join-Path $directory 'uninstall.exe') -ArgumentList @('/S', "_?=$directory") -WindowStyle Hidden -PassThru
  $script:installerProcesses += $process
  Wait-InstallerExit -Process $process -Step 'Uninstall preserving data'
  if (Test-Path -LiteralPath $expectedExe) { throw 'Uninstaller left the application executable behind.' }
  foreach ($extension in @('txt', 'lua', 'md', 'json')) {
    if (Test-Path -LiteralPath "HKCU:\Software\Classes\Boshu.$extension") { throw "Uninstaller left invalid .$extension registration behind." }
  }
  if (-not (Test-Path -LiteralPath $choicesPath)) { throw 'Keep-data uninstall deleted association preferences.' }
}
try {
  $env:APPDATA = $profileDirectory
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $testRoot 'webview'
  $settingsPath = Join-Path $profileDirectory 'Boshu\settings.json'
  $settingsText = '{"workbench.language":"en","updates.autoDownload":false,"updates.intervalHours":720,"updates.lastCheckedAt":4102444800000}'
  $choicesPath = Join-Path $profileDirectory 'Boshu\associations.json'
  if (Test-Path -LiteralPath $choicesPath) { throw 'Disposable runner unexpectedly has existing association preferences.' }
  if (Test-Path -LiteralPath 'HKCU:\Software\Classes\Applications\boshu.exe') { throw 'Disposable runner unexpectedly has an existing Boshu installation.' }
  [IO.File]::WriteAllText($settingsPath, $settingsText)
  $documentPath = Join-Path $testRoot 'user-document.txt'
  [IO.File]::WriteAllText($documentPath, 'Installer must preserve this user document.')
  $documentHash = (Get-FileHash -LiteralPath $documentPath -Algorithm SHA256).Hash

  $initial = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$installDirectory") -WindowStyle Hidden -PassThru
  $installerProcesses += $initial
  Wait-InstallerExit -Process $initial -Step 'Silent first installation'
  if (-not (Test-Path -LiteralPath $expectedExe)) { throw 'Silent first installation did not create the executable.' }
  if (@(& $ownedProcesses).Count -ne 0) { throw 'First installation unexpectedly launched the application.' }
  if (Test-Path -LiteralPath $choicesPath) { throw 'Silent first installation created association preferences without a user choice.' }
  if (Test-Path -LiteralPath 'HKCU:\Software\Classes\Boshu.txt') { throw 'Silent first installation registered file types.' }
  Invoke-AssociationCli -Arguments @('--register-assoc', 'txt,lua')
  Assert-Associations -Extensions @('txt', 'lua')
  # A saved partial set must remain authoritative over stray registrations.
  $selectedChoicesText = [IO.File]::ReadAllText($choicesPath)
  Invoke-AssociationCli -Arguments @('--register-assoc', 'md')
  [IO.File]::WriteAllText($choicesPath, $selectedChoicesText)
  # A persisted choice must repair stale commands on in-place upgrade.
  Set-Item -LiteralPath 'HKCU:\Software\Classes\Boshu.txt\shell\open\command' -Value '"C:\obsolete\boshu.exe" "%1"'
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
  Assert-Associations -Extensions @('txt', 'lua')
  foreach ($owned in @(& $ownedProcesses)) {
    Stop-Process -Id $owned.ProcessId
    Wait-Process -Id $owned.ProcessId -ErrorAction SilentlyContinue
  }

  Uninstall-KeepingData
  if ([IO.File]::ReadAllText($settingsPath) -ne $settingsText) { throw 'Keep-data uninstall changed settings.' }
  $installDirectory = Join-Path $testRoot 'moved-application'
  $expectedExe = Join-Path $installDirectory 'boshu.exe'
  Install-Quietly -SetupPath $setup -Directory $installDirectory
  Assert-Associations -Extensions @('txt', 'lua')

  Invoke-AssociationCli -Arguments @('--unregister-assoc', 'txt')
  Assert-Associations -Extensions @('lua')
  Invoke-AssociationCli -Arguments @('--unregister-assoc', 'all')
  Assert-Associations -Extensions @()
  Uninstall-KeepingData
  Install-Quietly -SetupPath $setup -Directory $installDirectory
  Assert-Associations -Extensions @()

  # Exercise the 0.2.0 migration path: registry exists without a preference file.
  Invoke-AssociationCli -Arguments @('--register-assoc', 'txt,lua')
  Remove-Item -LiteralPath $choicesPath
  Install-Quietly -SetupPath $setup -Directory $installDirectory -Extra @('/UPDATE')
  Assert-Associations -Extensions @('txt', 'lua')

  if ($PreviousInstaller) {
    Uninstall-KeepingData
    Remove-Item -LiteralPath $choicesPath
    $older = (Resolve-Path -LiteralPath $PreviousInstaller).Path
    Install-Quietly -SetupPath $older -Directory $installDirectory
    Invoke-AssociationCli -Arguments @('--register-assoc', 'txt,lua')
    if (Test-Path -LiteralPath $choicesPath) { throw 'Historical installer fixture unexpectedly persists choices.' }
    Install-Quietly -SetupPath $setup -Directory $installDirectory -Extra @('/UPDATE')
    Assert-Associations -Extensions @('txt', 'lua')
  }
  # The fixed-path data deletion CLI is also exercised on this disposable runner.
  Invoke-AssociationCli -Arguments @('--cleanup-assoc')
  Invoke-AssociationCli -Arguments @('--delete-assoc-data')
  if (Test-Path -LiteralPath (Join-Path $profileDirectory 'Boshu')) { throw 'Explicit data deletion retained app data.' }
  if ((Get-FileHash -LiteralPath $documentPath -Algorithm SHA256).Hash -ne $documentHash) { throw 'Association/uninstall QA changed the user document.' }
  Write-Output 'PASS silent first install, shared selected types, stale-path repair, upgrade/restart, keep-data uninstall, moved reinstall, explicit empty set, legacy migration, and data deletion on disposable runner.'
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
