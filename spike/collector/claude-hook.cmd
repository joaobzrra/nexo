@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if not defined NEXO_USER_DATA set "NEXO_USER_DATA=%APPDATA%\Nexo"
if not defined NEXO_EXECUTABLE goto installed
"%NEXO_EXECUTABLE%" "%~dp0claude-hook.mjs"
exit /b %ERRORLEVEL%

:installed
"%~dp0..\..\..\Nexo.exe" "%~dp0claude-hook.mjs"
exit /b %ERRORLEVEL%
