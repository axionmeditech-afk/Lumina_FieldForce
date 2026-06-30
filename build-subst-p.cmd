@echo off
setlocal EnableExtensions

set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot"
set "PATH=%JAVA_HOME%\bin;%PATH%"

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PROJ=%SCRIPT_DIR%"

echo ===== STEP 1: Kill stale Gradle daemons and Java =====
call "%PROJ%\android\gradlew.bat" --stop 2>nul
taskkill /F /IM java.exe 2>nul

echo ===== STEP 2: Clean CMake staging dir D:\x =====
if exist "D:\x" rmdir /S /Q "D:\x"
mkdir "D:\x"

echo ===== STEP 3: Map drive P: to project directory =====
subst P: /d 2>nul
subst P: "%PROJ%"
if errorlevel 1 (
  echo Failed to map drive P: to %PROJ%
  exit /b 1
)

cd /d "P:\android" || (
  subst P: /d
  exit /b 1
)

set NODE_ENV=production
set EXPO_PROJECT_ROOT=P:\

echo ===== STEP 4: Run codegen for native modules =====
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

echo ===== STEP 5: Build release APK =====
call gradlew.bat assembleRelease --no-daemon --no-build-cache
if errorlevel 1 (
  echo BUILD FAILED
  subst P: /d
  exit /b %errorlevel%
)

set "APK_SHORT=P:\android\app\build\outputs\apk\release\app-release.apk"
set "APK_REAL=%PROJ%\android\app\build\outputs\apk\release\app-release.apk"
set "APK_LATEST=%PROJ%\LuminaFieldForce-latest.apk"

if not exist "%APK_SHORT%" (
  echo Release APK was not produced at %APK_SHORT%
  subst P: /d
  exit /b 2
)

if not exist "%PROJ%\android\app\build\outputs\apk\release" mkdir "%PROJ%\android\app\build\outputs\apk\release"
copy /Y "%APK_SHORT%" "%APK_REAL%" >nul
copy /Y "%APK_SHORT%" "%APK_LATEST%" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Item '%APK_REAL%').LastWriteTime = Get-Date"
powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Item '%APK_LATEST%').LastWriteTime = Get-Date"

subst P: /d

echo.
echo ============================================
echo   APK READY at:
echo   %APK_LATEST%
echo ============================================
exit /b 0
