# Owner runs this once (and again after every Instagram token refresh) to give the cloud bots their keys.
#   powershell -ExecutionPolicy Bypass -File W:\Projects\recall-poster-reels\set-secrets.ps1
# It reads IG_ACCESS_TOKEN from W:\Projects\recallengine-ig-bot\.env and CLAUDE_API_KEY from
# W:\Projects\recall-engine\.env.local, checks the Instagram token works, then writes each value
# straight into 'gh secret set' through stdin (exact bytes, no BOM, no newline). Values are never printed.
$ErrorActionPreference = 'Stop'
$Repo = 'icehacer-sys/recall-poster'

function Read-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path $Path)) { throw "$Path not found" }
  $line = Get-Content -LiteralPath $Path -Encoding UTF8 | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -Last 1
  if (-not $line) { throw "$Name not found in $Path" }
  $v = ($line -replace "^\s*$Name\s*=", '').Trim().Trim('"').Trim("'").Trim()
  $v = $v.TrimStart([char]0xFEFF)
  if (-not $v) { throw "$Name is empty in $Path" }
  return $v
}

function Set-GhSecret([string]$Name, [string]$Value) {
  $gh = (Get-Command gh).Source
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $gh
  $psi.Arguments = "secret set $Name --repo $Repo"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($Value)
  $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $p.StandardInput.Close()
  $null = $p.StandardOutput.ReadToEnd()
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "gh secret set $Name failed: $err" }
  Write-Host "  set $Name"
}

$ig = Read-EnvValue 'W:\Projects\recallengine-ig-bot\.env' 'IG_ACCESS_TOKEN'
$claude = Read-EnvValue 'W:\Projects\recall-engine\.env.local' 'CLAUDE_API_KEY'
if ($ig -match '[^\x21-\x7E]' -or $claude -match '[^\x21-\x7E]') { throw 'A value has spaces or non-ASCII characters. Check the .env files.' }

# The Instagram token must work and belong to @recallengine before it goes to the cloud.
try {
  $me = Invoke-RestMethod -Uri 'https://graph.instagram.com/v21.0/me?fields=username' -Headers @{ Authorization = "Bearer $ig" }
} catch { throw 'The Instagram token in recallengine-ig-bot\.env does not work. Create a new one first (npm run token:url).' }
if ($me.username -ne 'recallengine') { throw "The Instagram token belongs to @$($me.username), not @recallengine." }
Write-Host 'Instagram token works for @recallengine.'

Set-GhSecret 'IG_ACCESS_TOKEN' $ig
Set-GhSecret 'CLAUDE_API_KEY' $claude
$ig = $null; $claude = $null

Write-Host "`nSecrets in ${Repo}:"
gh secret list --repo $Repo
Write-Host "`nDone. The reels and comments workflows go live on their next scheduled run."
Write-Host "Stop both at any time: gh variable set CLOUD_BOTS --body off --repo $Repo"
