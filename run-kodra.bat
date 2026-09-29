@echo off
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
call npm run dev
if %ERRORLEVEL% neq 0 (
    echo.
    echo [Kodra] Bir hata olustu. Pencereyi kapatmak icin bir tusa basin.
    pause
)

