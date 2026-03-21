@echo off
setlocal
subst R: "D:\Enterprise-Suite-Prozip\Enterprise-Suite-Prozip"
cd /d R:\Enterprise-Suite-Pro\android
node --no-warnings --eval "require('expo/bin/autolinking')" expo-modules-autolinking resolve --platform android --json --project-root R:\Enterprise-Suite-Pro
set ERR=%ERRORLEVEL%
subst R: /d
exit /b %ERR%