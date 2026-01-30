// 菜单模块
const { Menu } = require('electron');
 
// 创建中文菜单
function createChineseMenu(mainWindow, processManager, sendLogFn, currentViewRef, userDataPath, configFileName) {
    const { killComfyUIProcesses, loadComfyUIInWindow, startComfyUI } = processManager;

    // 【修复】定义异步函数，兼容旧版Node/Electron
    async function stopComfyUIHandler() {
        await killComfyUIProcesses();
    }

    let isMenuExiting = false; // 防止菜单重复退出
    async function exitAppHandler(app) {
        if (isMenuExiting) {
            return; // 防止重复处理退出
        }
        
        isMenuExiting = true; // 标记正在退出
        sendLogFn(`ℹ️ 应用退出中，正在清理ComfyUI进程...`, 'info');
        await killComfyUIProcesses(); // 等待进程清理完成
        // 不在此处调用app.quit()，而是依赖app的before-quit事件
    }

    const menuTemplate = [
        {
            label: '视图',
            submenu: [
                { 
                    label: '切换到日志视图', 
                    click: function() {
                        if (currentViewRef.value !== 'log') {
                            currentViewRef.value = 'log';
                            mainWindow.webContents.send('switch-view', 'log');
                            mainWindow.setTitle('ComfyUI启动器 - 日志视图');
                        }
                    }
                },
                { 
                    label: '切换到ComfyUI界面', 
                    click: loadComfyUIInWindow
                },
                { type: 'separator' },
                { 
                    label: '全屏', 
                    accelerator: 'F11', 
                    click: function() {
                        mainWindow.setFullScreen(!mainWindow.isFullScreen());
                    }
                },
                { 
                    label: '刷新', 
                    accelerator: 'F5', 
                    click: function() {
                        if (currentViewRef.value === 'log') mainWindow.webContents.reload();
                        else loadComfyUIInWindow();
                    }
                }
            ]
        },
        {
            label: '操作',
            submenu: [
                { 
                    label: '启动ComfyUI', 
                    click: async function() {
                        const os = require('os');
                        try {
                            await startComfyUI(os, userDataPath, configFileName, 'start_comfyui.bat');
                        } catch (error) {
                            sendLogFn(`❌ 启动ComfyUI时发生错误: ${error.message}`, 'error');
                        }
                    }
                },
                { 
                    label: '停止ComfyUI', 
                    click: stopComfyUIHandler // 【修复】使用预定义的异步函数
                },
                { 
                    label: '配置中心', 
                    click: function() {
                        mainWindow.webContents.send('show-config');
                    }
                },
                { type: 'separator' },
                { 
                    label: '退出', 
                    accelerator: 'Alt+F4', 
                    click: function() {
                        exitAppHandler(require('electron').app);
                    }
                }
            ]
        },
        {
            label: '帮助',
            submenu: [
                { 
                    label: '关于ComfyUI', 
                    click: function() {
                        mainWindow.webContents.loadURL('https://github.com/comfyanonymous/ComfyUI');
                    }
                }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

module.exports = {
    createChineseMenu
};