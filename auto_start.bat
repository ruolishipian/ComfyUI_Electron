@echo off
chcp 65001 > nul
set PYTHONIOENCODING=utf-8
set LC_ALL=en_US.UTF-8

:: Basic checks
if not exist "D:\ai\ComfyUI\python_embeded\python.exe" (
    echo [ERROR] Python not found: D:\ai\ComfyUI\python_embeded\python.exe
    pause
    exit /b 1
)

if not exist "D:\ai\ComfyUI\ComfyUI\main.py" (
    echo [ERROR] main.py not found: D:\ai\ComfyUI\ComfyUI\main.py
    pause
    exit /b 1
)

:: Proxy config
set http_proxy=
set https_proxy=
set HF_ENDPOINT=https://hf-mirror.com

:: Install dependencies if needed
if exist "D:\ai\ComfyUI_Electron\comfyui_checker.py" (
    echo [INFO] Checking dependencies...
    "D:\ai\ComfyUI\python_embeded\python.exe" "D:\ai\ComfyUI_Electron\comfyui_checker.py" "D:\ai\ComfyUI\ComfyUI"
)

:: Start ComfyUI
cd /d "D:\ai\ComfyUI\ComfyUI"
if errorlevel 1 (
    echo [ERROR] Failed to enter directory: D:\ai\ComfyUI\ComfyUI
    pause
    exit /b 1
)

echo [INFO] Starting ComfyUI on port 8188...
"D:\ai\ComfyUI\python_embeded\python.exe" -s main.py --lowvram --listen 127.0.0.1 --port 8188

echo [INFO] ComfyUI stopped.
pause > nul