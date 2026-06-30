@echo off
setlocal EnableExtensions

set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot"
set "PATH=%JAVA_HOME%\bin;%PATH%"

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PROJ=%SCRIPT_DIR%"
set "SHORT=D:\p"
set "APK_SHORT=D:\p\android\app\build\outputs\apk\release\app-release.apk"
set "APK_REAL=%PROJ%\android\app\build\outputs\apk\release\app-release.apk"

echo ===== STEP 1: Kill stale Gradle daemons =====
call "%SHORT%\android\gradlew.bat" --stop 2>nul
taskkill /F /IM java.exe 2>nul

echo ===== STEP 2: Clean CMake staging dir D:\x =====
if exist "D:\x" rmdir /S /Q "D:\x"
mkdir "D:\x"

echo ===== STEP 3: Remove old junction =====
if exist "%SHORT%" (
  rmdir "%SHORT%" 2>nul
)

echo ===== STEP 4: Create short-path junction =====
mklink /J "%SHORT%" "%PROJ%"
if errorlevel 1 (
  echo Failed to create short-path junction at %SHORT%
  exit /b 1
)

cd /d "%SHORT%\android" || exit /b 1
set NODE_ENV=production
set EXPO_PROJECT_ROOT=%SHORT%

echo ===== STEP 5: Run codegen for native modules =====
call gradlew.bat ^
  :react-native-reanimated:generateCodegenArtifactsFromSchema ^
  :react-native-worklets:generateCodegenArtifactsFromSchema ^
  :react-native-async-storage_async-storage:generateCodegenArtifactsFromSchema ^
  :react-native-gesture-handler:generateCodegenArtifactsFromSchema ^
  :react-native-webview:generateCodegenArtifactsFromSchema ^
  :react-native-safe-area-context:generateCodegenArtifactsFromSchema ^
  :react-native-screens:generateCodegenArtifactsFromSchema ^
  :react-native-svg:generateCodegenArtifactsFromSchema ^
  --no-daemon --no-build-cache
if errorlevel 1 (
  echo [WARN] Codegen had errors, continuing anyway...
)

echo ===== STEP 6: Build release APK =====
call gradlew.bat assembleRelease --no-daemon --no-build-cache
if errorlevel 1 (
  echo BUILD FAILED
  exit /b %errorlevel%
)

if not exist "%APK_SHORT%" (
  echo Release APK was not produced at %APK_SHORT%
  exit /b 2
)

if not exist "%PROJ%\android\app\build\outputs\apk\release" mkdir "%PROJ%\android\app\build\outputs\apk\release"
copy /Y "%APK_SHORT%" "%APK_REAL%" >nul
copy /Y "%APK_SHORT%" "%PROJ%\LuminaFieldForce-latest.apk" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Item '%APK_REAL%').LastWriteTime = Get-Date"

echo.
echo ============================================
echo   APK READY at:
echo   %APK_REAL%
echo ============================================
exit /b 0
