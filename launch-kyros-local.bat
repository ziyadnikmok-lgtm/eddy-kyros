@echo off
setlocal
cd /d "%~dp0"
set "KYROS_FORCE_LOCAL=1"
set "REMOTE_URL="
node electron\launch.js
