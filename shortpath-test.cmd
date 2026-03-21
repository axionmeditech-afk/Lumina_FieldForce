@echo off
setlocal
subst R: "D:\Enterprise-Suite-Prozip\Enterprise-Suite-Prozip\Enterprise-Suite-Pro"
if errorlevel 1 exit /b 1
if exist R:\android\gradlew.bat (
  echo OK_SHORT_DRIVE
) else (
  echo MISSING_SHORT_DRIVE
  exit /b 2
)
subst R: /d
endlocal