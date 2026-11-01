param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$ExeName,
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Branch,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $false)][string]$ExpectedVersion = "",
  [Parameter(Mandatory = $false)][string]$ZipUrl = "",
  [Parameter(Mandatory = $false)][string]$MediaBase = "",
  [Parameter(Mandatory = $false)][int64]$MinExeBytes = 104857600
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$logPath = Join-Path $env:TEMP "CreatorStudioUpdate.log"
$backup = $null
$work = $null
$newExeName = $ExeName

function Write-Log([string]$Message) {
  $line = "[" + (Get-Date -Format "HH:mm:ss") + "] " + $Message
  Write-Host $line
  try {
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {}
}

function Download-File([string]$Url, [string]$Destination, [switch]$ShowProgress) {
  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
  }
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    # --retry is available in every curl shipped with Windows. It restarts a
    # failed transfer from the beginning, which is what the LFS media endpoint
    # needs because it ignores range requests.
    $progress = @("--silent")
    if ($ShowProgress) {
      $progress = @("--progress-bar")
    }
    & curl.exe --fail --location --retry 5 --retry-delay 2 @progress --show-error --output $Destination $Url
    if ($LASTEXITCODE -ne 0) {
      throw ("Download failed (curl exit " + $LASTEXITCODE + "): " + $Url)
    }
    if (-not (Test-Path -LiteralPath $Destination)) {
      throw ("Download did not produce a file: " + $Url)
    }
    return
  }
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Get-LfsPointerSize([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $buffer = New-Object byte[] 400
    $read = $stream.Read($buffer, 0, $buffer.Length)
    $text = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
  } finally {
    $stream.Dispose()
  }
  if (-not $text.StartsWith("version https://git-lfs.github.com/spec/v1")) { return $null }
  $match = [regex]::Match($text, "(?m)^size\s+(\d+)\s*$")
  if (-not $match.Success) { return $null }
  return [int64]$match.Groups[1].Value
}

function Download-LfsFile([string]$Url, [string]$Destination, [int64]$ExpectedSize, [switch]$ShowProgress) {
  Download-File $Url $Destination -ShowProgress:$ShowProgress
  $actual = (Get-Item -LiteralPath $Destination).Length
  if ($ExpectedSize -gt 0 -and $actual -ne $ExpectedSize) {
    Write-Log ("Size mismatch (" + $actual + " of " + $ExpectedSize + " bytes), retrying...")
    Download-File $Url $Destination -ShowProgress:$ShowProgress
    $actual = (Get-Item -LiteralPath $Destination).Length
  }
  if ($ExpectedSize -gt 0 -and $actual -ne $ExpectedSize) {
    throw ("The downloaded file " + [System.IO.Path]::GetFileName($Destination) + " is " + $actual + " bytes but the Git LFS pointer expects " + $ExpectedSize + " bytes. The large binary download did not complete.")
  }
  return $actual
}

function Find-AppExe([string]$Root, [string]$Preferred) {
  if ([string]::IsNullOrWhiteSpace($Root)) { return $null }
  if (-not (Test-Path -LiteralPath $Root)) { return $null }
  $preferredPath = Join-Path $Root $Preferred
  if (Test-Path -LiteralPath $preferredPath) {
    if ((Get-Item -LiteralPath $preferredPath).Length -ge $MinExeBytes) {
      return $preferredPath
    }
  }
  $candidates = @(Get-ChildItem -LiteralPath $Root -File -Filter "*.exe" |
    Where-Object { $_.Length -ge $MinExeBytes } |
    Sort-Object -Property Length -Descending)
  if ($candidates.Count -ge 1) {
    return $candidates[0].FullName
  }
  return $null
}

function Move-WithRetry([string]$Source, [string]$Destination) {
  $lastError = $null
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
      Move-Item -LiteralPath $Source -Destination $Destination -ErrorAction Stop
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 500
    }
  }
  throw $lastError
}

try {
  $Host.UI.RawUI.WindowTitle = "Creator Studio Update"
} catch {}

try {
  Write-Log "Creator Studio update started."
  Write-Log ("Waiting for process " + $ParentPid + " to close...")

  $deadline = (Get-Date).AddMinutes(2)
  while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    throw "Creator Studio did not close in time. Close the app and try again."
  }

  Start-Sleep -Milliseconds 800
  $InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
  $parent = Split-Path -Parent $InstallDir

  # The update console is often started from the application folder, which makes
  # that folder the process working directory. Windows cannot rename a directory
  # that a process is sitting in, so move the helper out of it first.
  try {
    Set-Location -LiteralPath $env:TEMP
    [System.IO.Directory]::SetCurrentDirectory($env:TEMP)
  } catch {}
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $work = Join-Path $parent (".creator-studio-update-" + $stamp)
  $zip = Join-Path $work "repo.zip"
  $extract = Join-Path $work "extract"

  New-Item -ItemType Directory -Path $work -Force | Out-Null
  New-Item -ItemType Directory -Path $extract -Force | Out-Null

  $zipUrlEffective = $ZipUrl
  if ([string]::IsNullOrWhiteSpace($zipUrlEffective)) {
    $zipUrlEffective = "https://codeload.github.com/" + $Repo + "/zip/refs/heads/" + $Branch
  }
  $mediaBaseEffective = $MediaBase
  if ([string]::IsNullOrWhiteSpace($mediaBaseEffective)) {
    $mediaBaseEffective = "https://media.githubusercontent.com/media/" + $Repo + "/" + $Branch + "/"
  } elseif (-not $mediaBaseEffective.EndsWith("/")) {
    $mediaBaseEffective = $mediaBaseEffective + "/"
  }

  Write-Log ("Downloading update package from " + $zipUrlEffective)
  Download-File $zipUrlEffective $zip -ShowProgress
  Write-Log ("Downloaded " + [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1) + " MB.")

  Write-Log "Extracting update package..."
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) {
    & tar.exe -xf $zip -C $extract
    if ($LASTEXITCODE -ne 0) {
      throw "The update package could not be extracted."
    }
  } else {
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  }

  $roots = @(Get-ChildItem -LiteralPath $extract -Directory)
  if ($roots.Count -lt 1) {
    throw "The update package was empty."
  }
  $newRoot = $roots[0].FullName

  # GitHub stores every *.exe with Git LFS. The ZIP contains small pointer files,
  # so each one has to be replaced with the real binary from the LFS media
  # endpoint and checked against the exact byte size written in the pointer.
  $exeFiles = @(Get-ChildItem -LiteralPath $newRoot -Recurse -File -Filter "*.exe")
  $lfsCount = 0
  foreach ($exe in $exeFiles) {
    $pointerSize = Get-LfsPointerSize $exe.FullName
    if ($null -eq $pointerSize) {
      continue
    }
    $lfsCount += 1
    $relative = $exe.FullName.Substring($newRoot.Length + 1).Replace("\", "/")
    $encoded = (($relative.Split("/")) | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/"
    $mediaUrl = $mediaBaseEffective + $encoded
    Write-Log ("Downloading Git LFS binary " + $relative + " (" + [math]::Round($pointerSize / 1MB, 1) + " MB)...")
    $actual = Download-LfsFile $mediaUrl ($exe.FullName) $pointerSize -ShowProgress:($pointerSize -gt 10MB)
    Write-Log ("Verified " + $relative + ": " + $actual + " bytes.")
  }
  if ($lfsCount -eq 0) {
    Write-Log "No Git LFS pointer files were found in the update package."
  }

  $packagePath = Join-Path $newRoot "resources\app\package.json"
  if (-not (Test-Path -LiteralPath $packagePath)) {
    throw "The update package is missing resources\app\package.json."
  }
  $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
  $newVersion = [string]$package.version
  if ($ExpectedVersion -and $newVersion -ne $ExpectedVersion) {
    throw ("The downloaded version " + $newVersion + " does not match the expected version " + $ExpectedVersion + ".")
  }
  Write-Log ("Update package version: " + $newVersion)

  $newExePath = Find-AppExe -Root $newRoot -Preferred $ExeName
  if (-not $newExePath) {
    throw ("The update package does not contain " + $ExeName + " or any executable larger than " + [math]::Round($MinExeBytes / 1MB) + " MB. The Git LFS download may have failed.")
  }
  $newExeName = Split-Path -Leaf $newExePath
  if ($newExeName -ne $ExeName) {
    Write-Log ("Expected " + $ExeName + " but found " + $newExeName + "; using " + $newExeName + ".")
  }
  $exeSize = (Get-Item -LiteralPath $newExePath).Length
  if ($exeSize -lt $MinExeBytes) {
    throw ("The downloaded executable is only " + $exeSize + " bytes. The Git LFS download may have failed.")
  }
  if (-not (Test-Path -LiteralPath (Join-Path $newRoot "resources\app\dist\index.html"))) {
    throw "The update package is missing the renderer build."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $newRoot "resources\app\electron\main.cjs"))) {
    throw "The update package is missing the Electron entry point."
  }
  Write-Log ("Verified executable " + $newExeName + ": " + [math]::Round($exeSize / 1MB, 1) + " MB.")

  $backup = Join-Path $parent ("Creator Studio backup " + $stamp)
  if (Test-Path -LiteralPath $backup) {
    throw ("A backup folder already exists: " + $backup)
  }

  Write-Log "Replacing application files..."
  try {
    Move-WithRetry $InstallDir $backup
  } catch {
    throw ("Windows could not rename " + $InstallDir + ". Close any Explorer window showing that folder, then try the update again. " + $_.Exception.Message)
  }
  try {
    Move-WithRetry $newRoot $InstallDir
  } catch {
    if (Test-Path -LiteralPath $backup) {
      Move-WithRetry $backup $InstallDir
    }
    throw
  }

  $newExePath = Join-Path $InstallDir $newExeName
  if (-not (Test-Path -LiteralPath $newExePath)) {
    throw ("The new build was installed but " + $newExeName + " is missing from " + $InstallDir + ".")
  }
  Write-Log ("Starting " + $newExePath)
  Start-Process -FilePath $newExePath -WorkingDirectory $InstallDir
  Write-Log ("Update complete. Previous build saved to " + $backup)
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  $message = [string]$_.Exception.Message
  Write-Log ("UPDATE FAILED: " + $message)
  Write-Host ""
  Write-Host "Creator Studio could not be updated." -ForegroundColor Red
  Write-Host ("Details: " + $message)

  if ($backup -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $InstallDir)) {
    try {
      Move-WithRetry $backup $InstallDir
      Write-Log "Restored the previous build."
    } catch {
      Write-Log ("Could not restore the previous build: " + $_.Exception.Message)
    }
  }

  if (Test-Path -LiteralPath $InstallDir) {
    $oldExePath = Find-AppExe -Root $InstallDir -Preferred $ExeName
    if ($oldExePath) {
      try {
        Start-Process -FilePath $oldExePath -WorkingDirectory $InstallDir
      } catch {}
    }
    if ($work -and (Test-Path -LiteralPath $work)) {
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  if ($message -match "denied|UnauthorizedAccess") {
    Write-Host "Windows blocked writing to the application folder. Move Creator Studio to Documents (or another folder you own) and try the update again." -ForegroundColor Yellow
  }

  Write-Host ("Log: " + $logPath)
  Read-Host "Press Enter to close"
  exit 1
}
