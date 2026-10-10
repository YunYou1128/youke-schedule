@echo off
rem ============================================================
rem  build-apk.bat 的本机环境配置 —— 示例文件
rem
rem  用法：把本文件复制一份、改名为 env.local.bat，再填上你本机的真实路径。
rem        env.local.bat 不进版本库（见 .gitignore），因为路径因人而异。
rem
rem  不填也能跑：build-apk.bat 会先取环境变量，再回落到下面这两条默认值。
rem ============================================================

rem JDK 根目录
set "JAVA_HOME=C:\Program Files\Java\jdk-21"

rem Android SDK 根目录（常见落点是 %LOCALAPPDATA%\Android\Sdk）
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
