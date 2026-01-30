// 工具函数模块
const { app } = require('electron');
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// 发送日志到渲染进程（带精准颜色类型）
function sendLog(content, type = null, mainWindow = null) {
    if (!content || !mainWindow || mainWindow.isDestroyed()) return;
    
    // 自动识别类型（如果未指定）
    const logType = type || getLogType(content);
    // 时间戳格式化（修复：补全毫秒，确保格式统一）
    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    const logWithTime = `[${timestamp}] ${content}`;
    
    // 发送到渲染进程
    mainWindow.webContents.send('comfy-log', { 
        content: logWithTime, 
        type: logType 
    });
    
    // 控制台同步输出（带颜色）
    console.log(`[${timestamp}] [${logType.toUpperCase()}] ${content}`);
}

// 【精准识别】日志类型判断（区分info/warning/error）
function getLogType(logContent) {
    // 错误关键词（红色）
    const errorKeywords = [
        'ERROR', 'Error', 'error', 'Failed', 'failed', 'FAIL', 'fail',
        'Exception', 'exception', 'Traceback', 'traceback', 'Permission denied',
        '拒绝访问', '找不到文件', '无法加载', '启动失败', '异常退出',
        'Blocked by policy', 'ImportError', 'SyntaxError', 'AttributeError'
    ];
    
    // 警告关键词（黄色）
    const warningKeywords = [
        'WARNING', 'Warning', 'warning', 'WARN', 'warn', 'FutureWarning',
        'DeprecationWarning', '⚠️', '注意', '提醒', 'Skipped', 'skipped',
        '检测到', '不推荐使用', 'incompatible', 'slowly', 'jankiness', 'unresponsiveness'
    ];
    
    // 信息关键词（绿色）
    const infoKeywords = [
        'INFO', 'Info', 'info', 'SUCCESS', 'Success', 'success',
        '✅', '🚀', '🎉', 'Starting server', 'Loaded', 'loaded',
        'Initialization', 'initialized', 'completed', 'Using', 'using',
        'Total VRAM', 'Python version', 'ComfyUI version', 'To see the GUI go to',
        '最终执行的启动命令', 'Python命令', 'BAT文件命令', '工作目录', '端口', '自定义参数' // 新增启动命令关键词
    ];

    // 优先级：error > warning > info
    if (errorKeywords.some(kw => logContent.includes(kw))) {
        return 'error'; // 红色
    } else if (warningKeywords.some(kw => logContent.includes(kw))) {
        return 'warning'; // 黄色
    } else if (infoKeywords.some(kw => logContent.includes(kw))) {
        return 'info'; // 绿色
    } else {
        return 'normal'; // 默认白色（普通信息）
    }
}

// ==================== 配置管理（存储在用户数据目录） ====================
// 获取配置文件路径（用户数据目录，可写）
function getConfigPath(userDataPath, configFileName) {
    return path.join(userDataPath, configFileName);
}

// 加载配置（启动时自动加载）
function loadConfig(userDataPath, configFileName) {
    const configPath = getConfigPath(userDataPath, configFileName);
    let config = {};
    
    try {
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            sendLog(`✅ 加载用户配置文件：${configPath}`, 'info');
        } else {
            // 默认配置
            config = {
                pythonPath: '',
                comfyuiDir: '',
                port: 8188,
                proxy: 'disabled',
                proxyUrl: 'http://127.0.0.1:7890',
                customCmd: '',
                pluginCheckDays: 7
            };
            sendLog('ℹ️ 首次启动，使用默认配置（未检测到用户配置文件）', 'info');
        }
    } catch (e) {
        config = {
            pythonPath: '',
            comfyuiDir: '',
            port: 8188,
            proxy: 'disabled',
            proxyUrl: 'http://127.0.0.1:7890',
            customCmd: '',
            pluginCheckDays: 7
        };
        sendLog(`⚠️ 配置文件加载失败，使用默认配置：${e.message}`, 'warning');
    }
    
    return config;
}

// 保存配置（存储到启动器目录）
function saveConfig(newConfig, userDataPath, configFileName) {
    const configPath = getConfigPath(userDataPath, configFileName);
    
    try {
        // 保持原有的配置并合并新配置
        let existingConfig = {};
        if (fs.existsSync(configPath)) {
            existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        
        const config = { ...existingConfig, ...newConfig };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        sendLog(`✅ 配置已保存到用户数据目录：${configPath}`, 'success');
        return config;
    } catch (e) {
        sendLog(`❌ 配置保存失败：${e.message}`, 'error');
        throw e;
    }
}

// ==================== 系统代理检测 ====================
// 检测系统代理设置
function detectSystemProxy() {
    try {
        if (process.platform === 'win32') {
            // Windows系统：从注册表获取代理设置
            const regQuery = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /reg:32 2>nul && reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /reg:32 2>nul', { encoding: 'utf8' });
            
            if (regQuery.includes('0x1')) { // 代理已启用
                const proxyMatch = regQuery.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
                if (proxyMatch && proxyMatch[1]) {
                    return proxyMatch[1].trim();
                }
            }
        } else if (process.platform === 'darwin') { // macOS
            try {
                const proxyData = execSync('defaults read ~/Library/Preferences/com.apple.networkConnect.plist 2>/dev/null', { encoding: 'utf8' });
                // 检查是否启用了代理
                if (proxyData.includes('Proxies')) {
                    // 简化的macOS代理检测
                    const httpProxy = execSync('scutil --proxy | grep Proxy', { encoding: 'utf8' });
                    if (httpProxy.includes('Port') && httpProxy.includes('Host')) {
                        const hostMatch = httpProxy.match(/ProxyHost[\s\t]+:\s+(.+)/i);
                        const portMatch = httpProxy.match(/ProxyPort[\s\t]+:\s+(\d+)/i);
                        if (hostMatch && portMatch) {
                            return `http://${hostMatch[1].trim()}:${portMatch[1].trim()}`;
                        }
                    }
                }
            } catch (e) {
                // macOS代理检测失败，忽略
            }
        } else { // Linux
            const envProxy = process.env.http_proxy || process.env.https_proxy;
            if (envProxy) {
                return envProxy;
            }
        }
    } catch (error) {
        // 检测失败，返回null
        console.log('无法检测系统代理设置:', error.message);
    }
    return null;
}

// ==================== 内存清理机制 ====================
function startMemoryCleanup() {
    // 设置定期垃圾回收和内存清理
    setInterval(() => {
        try {
            // 尝试触发垃圾回收（如果可用）
            if (global.gc) {
                global.gc();
                sendLog('🧹 执行内存垃圾回收', 'info');
            }
        } catch (e) {
            // 如果没有启用--expose-gc标志，忽略错误
            // sendLog('⚠️ 垃圾回收不可用', 'warning');
        }
    }, 300000); // 每5分钟执行一次
}

// ==================== 检查管理员权限 ====================
const isAdmin = require('is-admin');

// 检查是否以管理员身份运行
async function checkAdminRights() {
    try {
        const admin = await isAdmin();
        if (!admin) {
            sendLog('⚠️ 警告：未以管理员身份运行，某些功能可能受限', 'warning');
            sendLog('💡 建议：右键点击启动器并选择"以管理员身份运行"以获得最佳体验', 'info');
        } else {
            sendLog('✅ 应用正以管理员身份运行，所有功能可用', 'info');
        }
    } catch (error) {
        sendLog('⚠️ 无法检测管理员权限状态', 'warning');
    }
}

module.exports = {
    sendLog,
    getLogType,
    loadConfig,
    saveConfig,
    detectSystemProxy,
    startMemoryCleanup,
    checkAdminRights
};