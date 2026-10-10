@echo off
rem ============================================================
rem  一键打包 APK（Debug + Release）
rem  用法：双击本文件，或在项目根目录执行 tools\build-apk.bat
rem  产物：android\app\build\outputs\apk\{debug,release}\
rem
rem  注意：APK 里装的是 android/app/src/main/assets/web/，
rem  改过 web/ 下的页面后必须重新同步，否则打出来的还是旧页面。
rem  这里已自动同步（等价于手工执行 node tools/sync-assets.js）。
rem ============================================================
chcp 65001 >nul
setlocal

rem --- 环境配置 ---
rem 本机路径放 tools\env.local.bat（不进版本库；格式见 env.local.example.bat）。
rem 先取环境变量，取不到用默认值，最后让 env.local.bat 覆盖。
if not defined JAVA_HOME    set "JAVA_HOME=C:\Program Files\Java\jdk-21"
if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if exist "%~dp0env.local.bat" call "%~dp0env.local.bat"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"

set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%"

rem --- Node：同步脚本用；未装受管版本时回落到 PATH 里的 node ---
rem 用 %USERPROFILE% 而不是把账号名写死：同一条路径，写死了就等于把本机账号名随仓库公开
set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE%" set "NODE=node"

echo.
echo [1/3] 同步 web/ 到 assets/web/ ...
"%NODE%" "%~dp0sync-assets.js"
if errorlevel 1 goto :fail

cd /d "%~dp0..\android"

echo.
echo [2/3] 构建 Debug APK ...
call gradlew.bat :app:assembleDebug --console=plain
if errorlevel 1 goto :fail

echo.
echo [3/3] 构建 Release APK ...
call gradlew.bat :app:assembleRelease --console=plain
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo  打包成功，产物位置：
echo    %cd%\app\build\outputs\apk\debug\app-debug.apk
echo    %cd%\app\build\outputs\apk\release\app-release.apk
echo ============================================================
goto :end

:fail
echo.
echo 打包失败，请查看上方 Gradle 错误信息。
exit /b 1

:end
endlocal
pause
