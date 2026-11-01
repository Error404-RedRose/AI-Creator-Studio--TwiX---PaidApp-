@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Creator Studio - Installer

rem ---------------------------------------------------------------------------
rem  Creator Studio installer
rem
rem  GitHub stores "Creator Studio.exe" with Git LFS because it is larger than
rem  100 MB. Downloading the repository as a ZIP gives you a tiny LFS pointer
rem  instead of the real executable. Run this file from the extracted folder and
rem  it will restore the complete build, then start the app.
rem
rem  Primary method : git clone + git lfs pull (full, verified build)
rem  Fallback      : direct download of the executable from GitHub's LFS media
rem                  endpoint, for PCs without Git installed
rem ---------------------------------------------------------------------------

set "REPO=Error404-RedRose/AI-Creator-Studio--TwiX---PaidApp-"
set "BRANCH=main"
set "APP=Creator Studio.exe"
set "MIN_EXE_BYTES=100000000"
set "GITHUB_URL=https://github.com/Error404-RedRose/AI-Creator-Studio--TwiX---PaidApp-"
set "MEDIA_URL=https://media.githubusercontent.com/media/Error404-RedRose/AI-Creator-Studio--TwiX---PaidApp-/main"
set "CLONE=%TEMP%\creator-studio-install-%RANDOM%%RANDOM%"
set "EXITCODE=0"
set "COMPLETE=0"

echo ============================================================
echo   Creator Studio - Installer
echo ============================================================
echo.
echo   Folder : %~dp0
echo   Source : %GITHUB_URL%
echo.

call :ExistingExeIsComplete
if "%COMPLETE%"=="1" goto :LaunchExisting

echo The executable in this folder is incomplete (a Git LFS pointer or a missing file).
echo The installer will now download the complete build from GitHub.
echo.

echo Checking Git and Git LFS...
where git >nul 2>&1
if errorlevel 1 goto :NoGit
git lfs version >nul 2>&1
if errorlevel 1 goto :NoLfs
echo Git and Git LFS were found.
goto :CloneRepo

:NoGit
echo.
echo Git was not found on this PC.
goto :OfferDirect

:NoLfs
echo.
echo Git LFS was not found on this PC.
echo   Install it with:  winget install --id GitHub.GitLFS -e
echo   Then run:         git lfs install
goto :OfferDirect

:OfferDirect
echo.
echo The installer can download the executable directly from GitHub instead.
echo.
choice /c YN /n /m "Download Creator Studio.exe directly from GitHub? [Y/N] "
if errorlevel 2 goto :AbortMissingTools
goto :DirectDownload

:AbortMissingTools
echo.
echo Installer stopped. Install Git for Windows and Git LFS, then run this file again.
echo Or download Creator Studio.exe manually from:
echo   %GITHUB_URL%
set "EXITCODE=1"
goto :end

:CloneRepo
set "GIT_LFS_SKIP_SMUDGE=1"
set "GIT_TERMINAL_PROMPT=0"
if exist "%CLONE%" rmdir /s /q "%CLONE%" >nul 2>&1
echo.
echo Cloning the published build (shallow clone, about 1 GB)...
echo This can take several minutes. Leave this window open.
echo.
git clone --depth 1 --branch %BRANCH% "https://github.com/%REPO%.git" "%CLONE%"
if errorlevel 1 goto :CloneFailed

echo.
echo Downloading the large executable with Git LFS (about 238 MB)...
echo.
git -C "%CLONE%" lfs install --local >nul 2>&1
git -C "%CLONE%" lfs pull
if errorlevel 1 goto :CloneFailed

:InstallFromClone
if not exist "%CLONE%\%APP%" goto :CloneFailed
set "CLONE_BYTES="
for %%F in ("%CLONE%\%APP%") do set "CLONE_BYTES=%%~zF"
if not defined CLONE_BYTES goto :CloneFailed
if %CLONE_BYTES% LSS %MIN_EXE_BYTES% goto :CloneFailed
echo Verified the downloaded executable: %CLONE_BYTES% bytes.

echo.
echo Copying the complete build into:
echo   %~dp0
echo Do not close this window.
robocopy "%CLONE%" "%~dp0." /E /COPY:DAT /R:1 /W:2 /XD "%CLONE%\.git" /XF "install.bat" ".gitattributes" /NFL /NDL /NJH /NJS /NP
set "ROBO=%ERRORLEVEL%"
if %ROBO% GEQ 8 goto :CopyFailed
rmdir /s /q "%CLONE%" >nul 2>&1
goto :VerifyInstall

:DirectDownload
if not exist "resources.pak" goto :MissingRuntime
if not exist "resources\app\dist\index.html" goto :MissingRuntime
echo.
where curl.exe >nul 2>&1
if errorlevel 1 goto :NoCurl
if not exist "resources" mkdir "resources" >nul 2>&1
del /f /q "%APP%" >nul 2>&1
echo Downloading Creator Studio.exe (about 238 MB)...
echo.
curl.exe --fail --location --retry 3 --output "%APP%" "%MEDIA_URL%/Creator%%20Studio.exe"
if errorlevel 1 goto :DownloadFailed
del /f /q "resources\elevate.exe" >nul 2>&1
curl.exe --fail --location --retry 3 --output "resources\elevate.exe" "%MEDIA_URL%/resources/elevate.exe"
if errorlevel 1 echo WARNING: resources\elevate.exe could not be downloaded. The app still runs without it.
call :ExistingExeIsComplete
if not "%COMPLETE%"=="1" goto :DownloadFailed
goto :VerifyInstall

:MissingRuntime
echo.
echo ERROR: This folder is missing the rest of the Creator Studio build.
echo Extract the release ZIP completely first, then run install.bat from inside it.
echo   %GITHUB_URL%
set "EXITCODE=1"
goto :end

:NoCurl
echo.
echo curl.exe is not available on this PC.
echo Opening the download page in your browser...
start "" "%GITHUB_URL%"
set "EXITCODE=1"
goto :end

:DownloadFailed
echo.
echo ERROR: The executable download did not finish.
echo Check the internet connection and run install.bat again.
echo Manual download: %GITHUB_URL%
set "EXITCODE=1"
goto :end

:VerifyInstall
call :ExistingExeIsComplete
if not "%COMPLETE%"=="1" goto :CopyFailed
if not exist "resources\app\dist\index.html" goto :CopyFailed
echo.
echo Install complete.
goto :Launch

:LaunchExisting
echo The executable in this folder is already complete (%EXE_BYTES% bytes).
echo.

:Launch
choice /c YN /n /m "Launch Creator Studio now? [Y/N] "
if errorlevel 2 goto :end
echo.
echo Starting Creator Studio...
start "" "%~dp0%APP%"
goto :end

:CloneFailed
echo.
echo ERROR: The build could not be downloaded with Git LFS.
echo   - Check that Git and Git LFS are installed and the PC is online.
echo   - Try again, or download Creator Studio.exe manually from:
echo     %GITHUB_URL%
if exist "%CLONE%" rmdir /s /q "%CLONE%" >nul 2>&1
set "EXITCODE=1"
goto :end

:CopyFailed
echo.
echo ERROR: The files could not be copied into this folder.
echo   - Close Creator Studio if it is running from this folder.
echo   - Move the folder somewhere writable, such as Documents, then run again.
if exist "%CLONE%" rmdir /s /q "%CLONE%" >nul 2>&1
set "EXITCODE=1"
goto :end

:ExistingExeIsComplete
set "COMPLETE=0"
set "EXE_BYTES="
if not exist "%APP%" goto :eof
for %%F in ("%APP%") do set "EXE_BYTES=%%~zF"
if not defined EXE_BYTES goto :eof
if %EXE_BYTES% LSS %MIN_EXE_BYTES% goto :eof
set "COMPLETE=1"
goto :eof

:end
echo.
if not "%EXITCODE%"=="0" (
  echo Installer finished with errors. Read the messages above.
) else (
  echo Done.
)
pause
exit /b %EXITCODE%
