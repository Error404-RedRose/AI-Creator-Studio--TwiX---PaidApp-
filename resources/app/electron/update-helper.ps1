param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$ExeName,
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Branch,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $false)][string]$ExpectedVersion = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$logPath = Join-Path $env:TEMP "CreatorStudioUpdate.log"
$backup = $null

function Write-Log([string]$Message) {
  $line = "[" + (Get-Date -Format "HH:mm:ss") + "] " + $Message
  Write-Host $line
  try {
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {}
}

function Download-File([string]$Url, [string]$Destination) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & curl.exe --fail --location --retry 3 --silent --show-error --output $Destination $Url
    if ($LASTEXITCODE -ne 0) {
      throw ("Download failed: " + $Url)
    }
    return
  }
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Test-LfsPointer([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $buffer = New-Object byte[] 200
    $read = $stream.Read($buffer, 0, $buffer.Length)
    $text = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
    return $text.StartsWith("version https://git-lfs.github.com/spec/v1")
  } finally {
    $stream.Dispose()
  }
}

function Move-WithRetry([string]$Source, [string]$Destination) {
  $lastError = $null
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
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
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $work = Join-Path $parent (".creator-studio-update-" + $stamp)
  $zip = Join-Path $work "repo.zip"
  $extract = Join-Path $work "extract"

  New-Item -ItemType Directory -Path $work -Force | Out-Null
  New-Item -ItemType Directory -Path $extract -Force | Out-Null

  $zipUrl = "https://codeload.github.com/" + $Repo + "/zip/refs/heads/" + $Branch
  Write-Log ("Downloading update package from " + $zipUrl)
  Download-File $zipUrl $zip
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

  $mediaBase = "https://media.githubusercontent.com/media/" + $Repo + "/" + $Branch + "/"
  $exeFiles = @(Get-ChildItem -LiteralPath $newRoot -Recurse -File -Filter "*.exe")
  foreach ($exe in $exeFiles) {
    if (-not (Test-LfsPointer $exe.FullName)) {
      continue
    }
    $relative = $exe.FullName.Substring($newRoot.Length + 1).Replace("\", "/")
    $encoded = (($relative.Split("/")) | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/"
    $mediaUrl = $mediaBase + $encoded
    Write-Log ("Downloading binary " + $relative + "...")
    Download-File $mediaUrl $exe.FullName
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

  $newExe = Join-Path $newRoot $ExeName
  if (-not (Test-Path -LiteralPath $newExe)) {
    throw ("The update package does not contain " + $ExeName + ".")
  }
  $exeSize = (Get-Item -LiteralPath $newExe).Length
  if ($exeSize -lt 50MB) {
    throw ("The downloaded executable is only " + $exeSize + " bytes. The Git LFS download may have failed.")
  }
  if (-not (Test-Path -LiteralPath (Join-Path $newRoot "resources\app\dist\index.html"))) {
    throw "The update package is missing the renderer build."
  }
  Write-Log ("Verified executable: " + [math]::Round($exeSize / 1MB, 1) + " MB.")

  $backup = Join-Path $parent ("Creator Studio backup " + $stamp)
  if (Test-Path -LiteralPath $backup) {
    throw ("A backup folder already exists: " + $backup)
  }

  Write-Log "Replacing application files..."
  Move-WithRetry $InstallDir $backup
  try {
    Move-WithRetry $newRoot $InstallDir
  } catch {
    if (Test-Path -LiteralPath $backup) {
      Move-WithRetry $backup $InstallDir
    }
    throw
  }

  $newExePath = Join-Path $InstallDir $ExeName
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

  $oldExe = Join-Path $InstallDir $ExeName
  if (Test-Path -LiteralPath $oldExe) {
    try {
      Start-Process -FilePath $oldExe -WorkingDirectory $InstallDir
    } catch {}
  }

  Write-Host ("Log: " + $logPath)
  Read-Host "Press Enter to close"
  exit 1
}
