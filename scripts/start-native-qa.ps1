param([switch]$Release, [ValidatePattern('^qa-[a-z0-9-]+$')][string]$ProfileName)
$ErrorActionPreference = 'Stop'
$qaOutputName = if ($Release) { 'qa-release' } else { 'qa-native' }
if ($ProfileName) { $qaOutputName = $ProfileName }
$qaBuildKind = if ($Release) { 'release' } else { 'debug' }
$qaRoot = Join-Path (Split-Path $PSScriptRoot -Parent) "artifacts\$qaOutputName"
$qaExe = Join-Path (Split-Path $PSScriptRoot -Parent) "src-tauri\target\$qaBuildKind\boshu.exe"
if (Get-Process boshu -ErrorAction SilentlyContinue) {
    throw 'A Boshu process is already running. Keep it intact; close the previous isolated test instance before launching another.'
}
if (-not (Test-Path -LiteralPath $qaExe)) { throw 'Build the debug desktop application first.' }
New-Item -ItemType Directory -Path $qaRoot -Force | Out-Null
$qaEnvironment = @{
    APPDATA = Join-Path $qaRoot 'appdata'
    WEBVIEW2_USER_DATA_FOLDER = Join-Path $qaRoot 'webview'
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
}
$qaPrevious = @{}
try {
    foreach ($qaKey in $qaEnvironment.Keys) {
        $qaPrevious[$qaKey] = [Environment]::GetEnvironmentVariable($qaKey, 'Process')
        [Environment]::SetEnvironmentVariable($qaKey, $qaEnvironment[$qaKey], 'Process')
    }
    $qaProcess = Start-Process -FilePath $qaExe -WorkingDirectory (Split-Path $PSScriptRoot -Parent) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $qaRoot 'stdout.log') -RedirectStandardError (Join-Path $qaRoot 'stderr.log')
    $qaProcess.Id | Set-Content -LiteralPath (Join-Path $qaRoot 'pid.txt')
    Write-Output "Isolated desktop test PID: $($qaProcess.Id); CDP: http://127.0.0.1:9223"
} finally {
    foreach ($qaKey in $qaEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($qaKey, $qaPrevious[$qaKey], 'Process')
    }
}
