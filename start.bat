@echo off
rem One-click launcher for the patrol-sim console.
rem Double-click this file, or run:  start.bat -Port 9000 -Lan
setlocal
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "code=%ERRORLEVEL%"
popd
if not "%code%"=="0" (
  echo.
  echo Startup failed with code %code%.
  pause
)
endlocal