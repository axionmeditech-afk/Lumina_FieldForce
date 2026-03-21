@echo off
setlocal EnableExtensions

set "PROJ=D:\Enterprise-Suite-Prozip\Enterprise-Suite-Prozip\Enterprise-Suite-Pro"
set "SHORT=D:\ep"
set "APK_SHORT=D:\ep\android\app\build\outputs\apk\release\app-release.apk"
set "APK_REAL=%PROJ%\android\app\build\outputs\apk\release\app-release.apk"

if exist "%SHORT%" (
  if exist "%SHORT%\package.json" rmdir "%SHORT%"
)

mklink /J "%SHORT%" "%PROJ%"
if errorlevel 1 (
  echo Failed to create short-path junction at %SHORT%
  exit /b 1
)

cd /d "%SHORT%\android" || exit /b 1
set NODE_ENV=production
set EXPO_PROJECT_ROOT=%SHORT%

call gradlew.bat ^
  :react-native-async-storage_async-storage:generateCodegenArtifactsFromSchema ^
  :react-native-gesture-handler:generateCodegenArtifactsFromSchema ^
  :react-native-webview:generateCodegenArtifactsFromSchema ^
  :react-native-safe-area-context:generateCodegenArtifactsFromSchema ^
  :react-native-screens:generateCodegenArtifactsFromSchema ^
  :react-native-svg:generateCodegenArtifactsFromSchema ^
  --no-daemon
if errorlevel 1 exit /b %errorlevel%

call gradlew.bat assembleRelease --no-daemon
if errorlevel 1 exit /b %errorlevel%

if not exist "%APK_SHORT%" (
  echo Release APK was not produced at %APK_SHORT%
  exit /b 2
)

if not exist "%PROJ%\android\app\build\outputs\apk\release" mkdir "%PROJ%\android\app\build\outputs\apk\release"
copy /Y "%APK_SHORT%" "%APK_REAL%" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Item '%APK_REAL%').LastWriteTime = Get-Date"

echo.
echo APK ready at:
echo %APK_REAL%
exit /b 0
