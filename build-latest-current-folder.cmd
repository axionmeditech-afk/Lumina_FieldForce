@echo off
setlocal EnableExtensions
set MOUNT=D:\Enterprise-Suite-Prozip\Enterprise-Suite-Prozip
set PROJ=D:\Enterprise-Suite-Prozip\Enterprise-Suite-Prozip\Enterprise-Suite-Pro
set SHORT=R:\p
set APK=R:\p\android\app\build\outputs\apk\release\app-release.apk

subst R: "%MOUNT%"
if errorlevel 1 goto fail

if exist R:\p (
  if not exist R:\p\package.json rmdir R:\p
)
if not exist R:\p\package.json mklink /J R:\p "%PROJ%"
if errorlevel 1 goto restore_fail

copy /Y D:\e\android\autolinking.fixed.json R:\p\android\autolinking.fixed.json >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='R:\p\android\autolinking.fixed.json'; $c=Get-Content $p -Raw; $c=$c.Replace('D:\\e','R:\\p'); $c=$c.Replace('D:/e','R:/p'); Set-Content -Path $p -Value $c -NoNewline"
if errorlevel 1 goto restore_fail

robocopy D:\e\node_modules\@react-native-async-storage\async-storage\android\build\generated\source\codegen R:\p\node_modules\@react-native-async-storage\async-storage\android\build\generated\source\codegen /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
robocopy D:\e\node_modules\react-native-gesture-handler\android\build\generated\source\codegen R:\p\node_modules\react-native-gesture-handler\android\build\generated\source\codegen /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
robocopy D:\e\node_modules\react-native-keyboard-controller\android\build\generated\source\codegen R:\p\node_modules\react-native-keyboard-controller\android\build\generated\source\codegen /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
robocopy D:\e\node_modules\react-native-reanimated\android\build\generated\source\codegen R:\p\node_modules\react-native-reanimated\android\build\generated\source\codegen /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
robocopy D:\e\node_modules\react-native-safe-area-context\android\build\generated\source\codegen R:\p\node_modules\react-native-safe-area-context\android\build\generated\source\codegen /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
robocopy D:\e\node_modules\react-native-screens\android\build\generated\source\codegen R:\p\node_modules\react-native-screens\android\build\generated\source\codegen /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
robocopy D:\e\node_modules\react-native-svg\android\build\generated\source\codegen R:\p\node_modules\react-native-svg\android\build\generated\source\codegen /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
robocopy D:\e\node_modules\react-native-webview\android\build\generated\source\codegen R:\p\node_modules\react-native-webview\android\build\generated\source\codegen /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
robocopy D:\e\node_modules\react-native-worklets\android\build\generated\source\codegen R:\p\node_modules\react-native-worklets\android\build\generated\source\codegen /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul

if exist D:\x rmdir /s /q D:\x
if exist R:\p\android\build rmdir /s /q R:\p\android\build
if exist R:\p\android\app\build rmdir /s /q R:\p\android\app\build
if exist R:\p\node_modules\react-native-reanimated\android\.cxx rmdir /s /q R:\p\node_modules\react-native-reanimated\android\.cxx
if exist R:\p\node_modules\react-native-safe-area-context\android\.cxx rmdir /s /q R:\p\node_modules\react-native-safe-area-context\android\.cxx
if exist R:\p\node_modules\react-native-svg\android\.cxx rmdir /s /q R:\p\node_modules\react-native-svg\android\.cxx
if exist R:\p\node_modules\react-native-worklets\android\.cxx rmdir /s /q R:\p\node_modules\react-native-worklets\android\.cxx
if exist R:\p\node_modules\expo-modules-core\android\.cxx rmdir /s /q R:\p\node_modules\expo-modules-core\android\.cxx
if exist R:\p\node_modules\react-native-screens\android\.cxx rmdir /s /q R:\p\node_modules\react-native-screens\android\.cxx

cd /d R:\p\android
set NODE_ENV=production
set EXPO_PROJECT_ROOT=R:\p
call gradlew.bat assembleRelease --no-daemon
set BUILD_ERR=%ERRORLEVEL%

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='R:\p\android\autolinking.fixed.json'; $c=Get-Content $p -Raw; $c=$c.Replace('R:\\p','D:\\Enterprise-Suite-Prozip\\Enterprise-Suite-Prozip\\Enterprise-Suite-Pro'); $c=$c.Replace('R:/p','D:/Enterprise-Suite-Prozip/Enterprise-Suite-Prozip/Enterprise-Suite-Pro'); Set-Content -Path $p -Value $c -NoNewline"

if not "%BUILD_ERR%"=="0" goto cleanup_fail
if not exist "%APK%" goto cleanup_fail
for %%I in ("%APK%") do echo APK_OK %%~fI %%~zI %%~tI
subst R: /d
exit /b 0

:cleanup_fail
subst R: /d
exit /b %BUILD_ERR%

:restore_fail
subst R: /d
exit /b 2

:fail
exit /b 1
