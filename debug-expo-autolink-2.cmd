@echo off
setlocal
subst R: "D:\Enterprise-Suite-Prozip\Enterprise-Suite-Prozip\Enterprise-Suite-Pro"
cd /d R:\android
node --no-warnings --eval "require('expo/bin/autolinking')" expo-modules-autolinking resolve --platform android --json --project-root R:\android\..
set ERR=%ERRORLEVEL%
subst R: /d
exit /b %ERR%