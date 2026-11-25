@echo off
rem Double-click to start Musicplayer, then open http://localhost:4321
cd /d "%~dp0"
start "" http://localhost:4321
node server\index.js
pause
