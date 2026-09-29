@echo off
chcp 65001 >nul
rem 此脚本从项目目录调用后端重启工具，失败时保留窗口便于查看原因。
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-backend.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
