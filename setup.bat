@echo off
cd /d "%~dp0"
echo Installing dependencies...
call npm install
echo Linking ss command globally...
call npm link
echo.
echo Done. Run "ss --version" to verify.
