// IPC通信模块
const { ipcMain, dialog } = require('electron');
const path = require('path');

// 创建IPC处理器
function createIPCHandlers(mainWindow, config, utils, processManager, userDataPath, configFileName) {
    const { sendLog } = utils;
    const { startComfyUI, killComfyUIProcesses } = processManager;
    const os = require('os');
    
    // 加载配置
    ipcMain.on('get-config', function() {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('config-loaded', config);
        }
    });

    // 保存配置
    ipcMain.on('save-config', function(_, newConfig) {
        try {
            const updatedConfig = utils.saveConfig(newConfig, userDataPath, configFileName);
            mainWindow.webContents.send('config-saved', true);
        } catch (e) {
            mainWindow.webContents.send('config-saved', false, e.message);
        }
    });

    // 选择路径（Python/ComfyUI目录）
    ipcMain.on('select-path', async function(_, type) {
        try {
            const dialogOptions = type === 'python' ? {
                title: '选择Python可执行文件',
                properties: ['openFile'],
                filters: [{ name: 'Python Executable', extensions: ['exe'] }]
            } : {
                title: '选择ComfyUI目录（含main.py）',
                properties: ['openDirectory']
            };
            const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
            if (!result.canceled && result.filePaths.length > 0) {
                mainWindow.webContents.send('path-selected', {
                    type: type,
                    path: result.filePaths[0]
                });
            } else {
                mainWindow.webContents.send('path-selected', null);
            }
        } catch (e) {
            sendLog(`❌ 路径选择失败：${e.message}`, 'error');
            mainWindow.webContents.send('path-selected', null);
        }
    });

    // 启动/停止ComfyUI
    ipcMain.on('start-comfyui', async () => {
        try {
            await startComfyUI(os, userDataPath, configFileName, 'start_comfyui.bat');
        } catch (error) {
            sendLog(`❌ 启动ComfyUI时发生错误: ${error.message}`, 'error');
        }
    });
    ipcMain.on('stop-comfyui', function() {
        // 【修复】异步调用清理函数，兼容旧版语法，增加防重复调用
        killComfyUIProcesses().then(function() {
            sendLog('✅ ComfyUI已停止', 'success');
        }).catch(function(err) {
            sendLog(`⚠️ 停止ComfyUI时发生错误: ${err.message}`, 'error');
        });
    });

    // 检测系统代理
    ipcMain.on('detect-system-proxy', function(event) {
        const systemProxy = utils.detectSystemProxy();
        if (systemProxy) {
            event.sender.send('system-proxy-detected', { success: true, proxy: systemProxy });
        } else {
            event.sender.send('system-proxy-detected', { success: false });
        }
    });

    // 手动加载ComfyUI界面（备用）
    ipcMain.on('load-comfyui-in-window', processManager.loadComfyUIInWindow);
}

module.exports = {
    createIPCHandlers
};