@echo off
setlocal EnableExtensions

set "MOUNT=D:\Enterprise-Suite-Prozip\Enterprise-Suite-Prozip"
set "PROJ=D:\Enterprise-Suite-Prozip\Enterprise-Suite-Prozip\Enterprise-Suite-Pro"
set "SHORT=R:\p"
set "APK_SHORT=R:\p\android\app\build\outputs\apk\release\app-release.apk"
set "APK_REAL=%PROJ%\android\app\build\outputs\apk\release\app-release.apk"

cd /d "%PROJ%\android" || exit /b 1
call gradlew.bat ^
  :react-native-async-storage_async-storage:generateCodegenArtifactsFromSchema ^
  :react-native-gesture-handler:generateCodegenArtifactsFromSchema ^
  :react-native-webview:generateCodegenArtifactsFromSchema ^
  :react-native-safe-area-context:generateCodegenArtifactsFromSchema ^
  :react-native-screens:generateCodegenArtifactsFromSchema ^
  :react-native-svg:generateCodegenArtifactsFromSchema ^
  --no-daemon
if errorlevel 1 exit /b %errorlevel%

subst R: "%MOUNT%"
if errorlevel 1 exit /b 1

if exist R:\p (
  if not exist R:\p\package.json rmdir R:\p
)
if not exist R:\p\package.json mklink /J R:\p "%PROJ%"
if errorlevel 1 (
  subst R: /d
  exit /b 1
)

cd /d "R:\p\android" || exit /b 1
set NODE_ENV=production
set EXPO_PROJECT_ROOT=%SHORT%
call gradlew.bat assembleRelease --no-daemon
if errorlevel 1 (
  subst R: /d
  exit /b %errorlevel%
)

if not exist "%APK_SHORT%" (
  subst R: /d
  echo Release APK was not produced at %APK_SHORT%
  exit /b 2
)

if not exist "%PROJ%\android\app\build\outputs\apk\release" mkdir "%PROJ%\android\app\build\outputs\apk\release"
copy /Y "%APK_SHORT%" "%APK_REAL%" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Item '%APK_REAL%').LastWriteTime = Get-Date"
subst R: /d

echo.
echo APK ready at:
echo %APK_REAL%
exit /b 0
