@echo off
title 시공현장 자료 수집 시스템 - 로컬 서버

rem Run from this file's own folder, so double-clicking works regardless of
rem where Explorer thinks the current directory is.
cd /d "%~dp0"

echo.
echo  ============================================================
echo   시공현장 자료 수집 시스템 - 로컬 서버
echo  ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 goto NONODE

if not exist "node_modules\" goto INSTALL
goto CHECKENV

:NONODE
echo  [오류] Node.js 가 설치되어 있지 않습니다.
echo         https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
echo.
pause
exit /b 1

:INSTALL
echo  최초 실행입니다. 필요한 파일을 내려받는 중입니다. 몇 분 걸립니다.
echo.
call npm install
if errorlevel 1 goto INSTALLFAIL
echo.
goto CHECKENV

:INSTALLFAIL
echo.
echo  [오류] 설치에 실패했습니다. 인터넷 연결을 확인해 주세요.
pause
exit /b 1

:CHECKENV
if exist "apps\sigong-upload\.env" goto RUN
echo  [알림] 설정 파일이 없어 예시 파일을 복사합니다.
copy "apps\sigong-upload\.env.example" "apps\sigong-upload\.env" >nul
echo.

:RUN
echo  서버를 시작합니다. 잠시 후 브라우저가 자동으로 열립니다.
echo.
echo  * 이 창을 닫으면 서버도 함께 종료됩니다.
echo  * 종료하려면 이 창에서 Ctrl+C 를 누르세요.
echo.

rem Give the server a head start so the browser does not land on a dead port.
rem Fully-qualified so a shadowed "timeout" on PATH cannot break the delay.
start "" /b cmd /c "%SystemRoot%\System32	imeout.exe /t 7 /nobreak >nul & start http://localhost:3000"

call npm run dev

echo.
echo  서버가 종료되었습니다.
pause
