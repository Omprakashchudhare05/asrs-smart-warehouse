@echo off
cd /d "%~dp0"
if not exist node_modules\express echo First-time setup: installing backend packages...
if not exist node_modules\express call npm install
node server.js
pause
