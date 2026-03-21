@echo off
setlocal
subst R: "D:\Enterprise-Suite-Prozip\Enterprise-Suite-Prozip\Enterprise-Suite-Pro"
cd /d R:\
node --no-warnings --eval "require('expo/bin/autolinking')" expo-modules-autolinking resolve --platform android --json
set ERR=%ERRORLEVEL%
subst R: /d
exit /b %ERR%