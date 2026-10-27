@echo off
setlocal
cd /d "%~dp0"

if exist ".env" (
    echo ERROR: .env already exists. Existing file was not changed.
    pause
    exit /b 1
)

echo Generating a new authentication token...

for /f "delims=" %%T in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set "TOKEN=%%T"

if not defined TOKEN (
    echo ERROR: Failed to generate token. Make sure Node.js is installed.
    pause
    exit /b 1
)

(
    echo AGENT_TOKEN=%TOKEN%
) > ".env"

if errorlevel 1 (
    echo ERROR: Could not create .env file.
    pause
    exit /b 1
)

echo.
echo Successfully created .env with a new random token.
echo Restart your host agent to apply the new token.
echo.
pause