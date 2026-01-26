// 引入Electron核心模块
const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite'); // 解决Windows中文日志乱码

// 全局变量
let mainWindow = null;         // 主窗口实例（日志/ComfyUI视图切换）
let comfyProcess = null;       // ComfyUI进程实例
let config = {};               // 配置对象
const configFileName = 'comfyui-config.json'; // 配置文件（存储在启动器目录）
const startFileName = 'start_comfyui.bat';    // 启动文件（存储在启动器目录）
let isComfyUISuccessStarted = false; // ComfyUI是否启动成功
let currentView = 'log'; // 当前视图：log（日志）/comfyui（界面）
const appDir = app.getAppPath(); // 启动器目录（软件目录）
let isKillingProcess = false;   // 【新增】进程清理状态标记，防止重复调用
let performanceMonitorInterval = null; // 性能监控定时器

// ==================== 性能监控功能 ====================
function startPerformanceMonitoring() {
    if (performanceMonitorInterval) {
        clearInterval(performanceMonitorInterval);
    }
    
    performanceMonitorInterval = setInterval(() => {
        if (comfyProcess && !comfyProcess.killed) {
            const { exec } = require('child_process');
            const os = require('os');
            
            // 获取系统资源使用情况
            const cpuUsage = process.cpuUsage();
            const memoryUsage = process.memoryUsage();
            
            // 获取系统总体内存信息
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(2);
            
            // 获取ComfyUI进程资源使用情况（仅在Windows上）
            if (process.platform === 'win32') {
                exec(`tasklist /FI "PID eq ${comfyProcess.pid}" /FO CSV /NH`, (err, stdout) => {
                    if (!err && stdout) {
                        // 解析输出获取CPU和内存使用情况
                        const lines = stdout.trim().split('\r\n');
                        if (lines.length > 0) {
                            const processInfo = lines[0];
                            // 发送性能信息到前端（如果需要显示）
                            // mainWindow.webContents.send('performance-update', {
                            //     cpu: cpuUsage.percent,
                            //     memory: memoryUsage.heapUsed,
                            //     systemMemory: memUsagePercent,
                            //     processInfo: processInfo
                            // });
                        }
                    }
                });
            }
        }
    }, 5000); // 每5秒更新一次
}

function stopPerformanceMonitoring() {
    if (performanceMonitorInterval) {
        clearInterval(performanceMonitorInterval);
        performanceMonitorInterval = null;
    }
}

// ==================== 核心工具函数 ====================
// 【新增】清理终端ANSI转义码（颜色/光标移动等格式代码）
function clearAnsiCodes(text) {
    // 匹配所有ANSI转义序列，覆盖绝大多数终端格式代码
    const ansiPattern = /\x1B(?:[@-Z\\-_]|\[.*?[a-zA-Z])/g;
    return text.replace(ansiPattern, '');
}

// 【终极修复】自动检测编码，解决所有乱码问题
function convertToUtf8(buffer) {
    try {
        // 方案1：优先尝试UTF-8解码（Python默认输出UTF-8）
        let result = iconv.decode(buffer, 'utf-8');
        // 移除不可见控制字符
        result = result.replace(/[\x00-\x1F\x7F]/g, '').trim();
        
        // 校验：如果UTF-8解码后无GBK典型乱码（如"鉁、鍚"），直接使用
        const gbkGarbagePattern = /[鉁鍚閰嶅鈿狅笍]/g;
        if (!gbkGarbagePattern.test(result)) {
            return clearAnsiCodes(result);
        }

        // 方案2：尝试GBK解码（Windows CMD原生编码，适配BAT脚本输出）
        result = iconv.decode(buffer, 'gbk');
        result = result.replace(/[\x00-\x1F\x7F]/g, '').trim();
        
        // 校验：如果GBK解码后无UTF-8典型乱码（如"Ã¦、Ã¥"），直接使用
        const utf8GarbagePattern = /Ã¦|Ã¥|Ã¤|Ã¶|Ã¼|ÃŸ|â€œ|â€ |â€˜|â€™/g;
        if (!utf8GarbagePattern.test(result)) {
            return clearAnsiCodes(result);
        }

        // 方案3：尝试GB2312解码（GBK子集，适配老系统输出）
        result = iconv.decode(buffer, 'gb2312');
        result = result.replace(/[\x00-\x1F\x7F]/g, '').trim();
        if (!utf8GarbagePattern.test(result)) {
            return clearAnsiCodes(result);
        }

        // 方案4：最后尝试CP1252解码（西方编码，兜底兼容）
        result = iconv.decode(buffer, 'cp1252');
        result = result.replace(/[\x00-\x1F\x7F]/g, '').trim();
        return clearAnsiCodes(result);

    } catch (e) {
        // 所有解码失败时，直接用UTF-8原始内容兜底
        const fallback = buffer.toString('utf8').replace(/[\x00-\x1F\x7F]/g, '').trim();
        return clearAnsiCodes(fallback);
    }
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

// 发送日志到渲染进程（带精准颜色类型）
function sendLog(content, type = null) {
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

// ==================== 配置管理（存储在软件目录） ====================
// 获取配置文件路径（启动器目录）
function getConfigPath() {
    return path.join(appDir, configFileName);
}

// 加载配置（启动时自动加载）
function loadConfig() {
    const configPath = getConfigPath();
    try {
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            sendLog(`✅ 加载配置文件：${configPath}`, 'info');
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
            sendLog('ℹ️ 首次启动，使用默认配置（未检测到配置文件）', 'info');
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
}

// 保存配置（存储到启动器目录）
function saveConfig(newConfig) {
    try {
        config = { ...config, ...newConfig };
        fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
        sendLog(`✅ 配置已保存到：${getConfigPath()}`, 'success');
    } catch (e) {
        sendLog(`❌ 配置保存失败：${e.message}`, 'error');
        throw e;
    }
}

// ==================== 启动文件生成（启动器目录下） ====================
// 生成ComfyUI启动文件（bat）：GBK编码+CRLF换行+适配带空格路径
function generateStartFile() {
    const startPath = path.join(appDir, startFileName);
    const port = config.port || 8188;
    const cmdArgs = ['main.py', `--port=${port}`];
    
    // 解析自定义命令：支持带引号的路径
    if (config.customCmd && config.customCmd.trim()) {
        const cmdParts = config.customCmd.trim().match(/"[^"]+"|\S+/g) || [];
        // 移除引号，添加到参数列表
        cmdArgs.push(...cmdParts.map(part => part.replace(/"/g, '')));
    }

    // 构建bat内容：CRLF换行+GBK编码+chcp 936（适配Windows CMD）
    let batContent = `@echo off\r\n`; // 强制CRLF换行
    batContent += `chcp 936 >nul\r\n`; // 改用GBK（Windows CMD原生编码）
    batContent += `mode con cp select=936 >nul\r\n`; // 确保控制台编码一致
    batContent += `cd /d "${config.comfyuiDir}"\r\n`; // 切换到ComfyUI目录（支持带空格路径）
    
    // 添加代理环境变量
    if (config.proxy === 'auto') {
        batContent += `set HTTP_PROXY=http://127.0.0.1:7890\r\n`;
        batContent += `set HTTPS_PROXY=http://127.0.0.1:7890\r\n`;
    } else if (config.proxy === 'custom' && config.proxyUrl) {
        batContent += `set HTTP_PROXY=${config.proxyUrl}\r\n`;
        batContent += `set HTTPS_PROXY=${config.proxyUrl}\r\n`;
    }
    
    // 启动命令（支持带空格的Python路径/参数）
    // 使用用户配置的参数，不再自动添加性能优化参数
    let optimizedCmdArgs = [...cmdArgs];
    
    // 检查是否已有性能相关的参数，避免重复（仅作为检查，不自动添加）
    const hasCpuVae = optimizedCmdArgs.some(arg => arg.includes("--cpu-vae"));
    const hasLowVram = optimizedCmdArgs.some(arg => arg.includes("--lowvram")); 
    const hasForceFp16 = optimizedCmdArgs.some(arg => arg.includes("--force-fp16"));
    const hasFastMode = optimizedCmdArgs.some(arg => arg.includes("--fast"));
    const hasDisableMetadata = optimizedCmdArgs.some(arg => arg.includes("--disable-metadata"));
    const hasAutoLaunch = optimizedCmdArgs.some(arg => arg.includes("--auto-launch"));
    const hasAsyncProcessing = optimizedCmdArgs.some(arg => arg.includes("--async-processing"));
    const hasPinSharedMemory = optimizedCmdArgs.some(arg => arg.includes("--pin-shared-memory"));
    
    // 不再自动添加性能参数，让用户在自定义参数中自行添加
    // 仅保留必要的参数：端口和用户自定义参数
    if (config.customCmd && config.customCmd.trim()) {
        const cmdParts = config.customCmd.trim().match(/"[^"]+"|\S+/g) || [];
        optimizedCmdArgs.push(...cmdParts.map(part => part.replace(/"/g, '')));
    }
    
    batContent += `"${config.pythonPath}" ${optimizedCmdArgs.join(' ')}\r\n`;
    batContent += `pause\r\n`; // 保留暂停，便于查看错误

    // GBK编码写入
    try {
        const gbkContent = iconv.encode(batContent, 'gbk');
        fs.writeFileSync(startPath, gbkContent, { flag: 'w' });
        sendLog(`✅ 生成启动文件：${startPath}（GBK编码+CRLF换行）`, 'info');
        return { startPath, cmdArgs }; // 【修改】返回cmdArgs，用于构建启动命令
    } catch (e) {
        sendLog(`❌ 生成启动文件失败：${e.message}`, 'error');
        throw e;
    }
}

// ==================== 进程管理（精准启停+修复提前终止问题） ====================
// 终止ComfyUI进程：【核心修复】改为Promise异步函数+重复调用防护
function killComfyUIProcesses() {
    // 防止重复调用清理逻辑
    if (isKillingProcess) {
        sendLog(`ℹ️ 进程清理已在执行中，请勿重复操作`, 'warning');
        return Promise.resolve();
    }
    // 无进程需要清理时直接返回
    if (!comfyProcess || comfyProcess.killed) {
        isComfyUISuccessStarted = false;
        // 停止性能监控
        stopPerformanceMonitoring();
        return Promise.resolve();
    }

    isKillingProcess = true; // 标记为清理中
    isComfyUISuccessStarted = false;
    sendLog('⏹️ 开始停止ComfyUI...', 'info');

    return new Promise((resolve) => {
        let cleanupSteps = 0; // 清理步骤计数器
        const totalSteps = 2; // 总清理步骤：主进程终止 + 端口进程清理

        // 步骤1：终止直接启动的进程（分步：温和终止→强制终止）
        const killMainProcess = () => {
            return new Promise((resolveStep) => {
                if (!comfyProcess || comfyProcess.killed) {
                    sendLog(`ℹ️ ComfyUI主进程已终止`, 'info');
                    cleanupSteps++;
                    resolveStep();
                    return;
                }

                try {
                    const pid = comfyProcess.pid;
                    // 空PID防护
                    if (!pid) {
                        sendLog(`ℹ️ ComfyUI主进程PID为空，跳过温和终止`, 'info');
                        comfyProcess = null;
                        // 停止性能监控
                        stopPerformanceMonitoring();
                        cleanupSteps++;
                        resolveStep();
                        return;
                    }

                    // 第一步：温和终止（模拟Ctrl+C）
                    comfyProcess.kill('SIGINT');
                    sendLog(`ℹ️ 尝试温和终止ComfyUI主进程（PID：${pid}）`, 'info');

                    // 第二步：1秒后检查，未终止则强制终止（含子进程）
                    setTimeout(() => {
                        if (comfyProcess && !comfyProcess.killed) {
                            exec(`taskkill /F /T /PID ${pid}`, (err, stdout, stderr) => {
                                if (!err) {
                                    sendLog(`✅ 终止ComfyUI主进程及子进程（PID：${pid}）`, 'success');
                                } else {
                                    // 解码错误信息
                                    const errMsg = convertToUtf8(stderr || Buffer.from(err.message));
                                    sendLog(`⚠️ 终止主进程失败：${errMsg}（建议以管理员身份运行启动器）`, 'warning');
                                }
                                comfyProcess = null;
                                // 停止性能监控
                                stopPerformanceMonitoring();
                                cleanupSteps++;
                                resolveStep();
                            });
                        } else {
                            comfyProcess = null;
                            // 停止性能监控
                            stopPerformanceMonitoring();
                            cleanupSteps++;
                            resolveStep();
                        }
                    }, 1000);
                } catch (e) {
                    sendLog(`⚠️ 终止主进程异常：${convertToUtf8(Buffer.from(e.message))}`, 'warning');
                    comfyProcess = null;
                    // 停止性能监控
                    stopPerformanceMonitoring();
                    cleanupSteps++;
                    resolveStep();
                }
            });
        };

        // 步骤2：兜底清理端口进程
        const killPortProcesses = () => {
            return new Promise((resolveStep) => {
                const port = config.port || 8188;
                // 切换CMD编码为GBK，避免netstat输出乱码
                exec(`chcp 936 >nul && netstat -ano | findstr :${port}`, (err, stdout, stderr) => {
                    if (!err && stdout) {
                        // 解析PID并去重（避免重复查杀同一PID）
                        const pidMatches = stdout.match(/\s+(\d+)$/gm) || [];
                        const pidList = [...new Set(pidMatches.map(pid => pid.trim()))].filter(pid => pid && pid !== '0');

                        if (pidList.length === 0) {
                            sendLog(`ℹ️ 端口${port}未被占用，无需终止额外进程`, 'info');
                            cleanupSteps++;
                            resolveStep();
                            return;
                        }

                        sendLog(`ℹ️ 检测到端口${port}被PID：${pidList.join(', ')} 占用，开始终止...`, 'info');
                        let killedCount = 0;

                        // 逐个校验PID是否存在，再终止
                        pidList.forEach(pid => {
                            // 先检查PID是否存在
                            exec(`tasklist /FI "PID eq ${pid}" | findstr /I ${pid}`, (checkErr) => {
                                if (checkErr) {
                                    sendLog(`ℹ️ PID ${pid} 已退出，无需终止`, 'info');
                                    killedCount++;
                                    if (killedCount === pidList.length) {
                                        cleanupSteps++;
                                        resolveStep();
                                    }
                                    return;
                                }
                                // 终止存在的PID
                                exec(`taskkill /F /PID ${pid}`, (killErr, killStdout, killStderr) => {
                                    if (!killErr) {
                                        sendLog(`✅ 终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                    } else {
                                        // 解码错误信息
                                        const killErrMsg = convertToUtf8(killStderr || Buffer.from(killErr.message));
                                        sendLog(`⚠️ 终止端口进程${pid}失败：${killErrMsg}（建议以管理员身份运行）`, 'warning');
                                    }
                                    killedCount++;
                                    if (killedCount === pidList.length) {
                                        cleanupSteps++;
                                        resolveStep();
                                    }
                                });
                            });
                        });
                    } else if (err) {
                        sendLog(`⚠️ 检测端口${port}占用失败：${convertToUtf8(stderr || Buffer.from(err.message))}`, 'warning');
                        cleanupSteps++;
                        resolveStep();
                    } else {
                        sendLog(`ℹ️ 端口${port}无占用进程`, 'info');
                        cleanupSteps++;
                        resolveStep();
                    }
                });
            });
        };

        // 并行执行清理步骤
        Promise.all([killMainProcess(), killPortProcesses()]).then(() => {
            // 切换回日志视图
            if (currentView === 'comfyui') {
                currentView = 'log';
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('switch-view', 'log');
                    mainWindow.setTitle('ComfyUI启动器 - 日志视图');
                }
            }

            // 最终状态提示
            setTimeout(() => {
                sendLog('✅ ComfyUI进程清理完成（未终止的PID为已退出的无效进程）', 'success');
                isKillingProcess = false; // 重置状态标记
                resolve(true);
            }, 1000);
        });
    });
}

// 检测ComfyUI启动成功（精准匹配日志关键词）
function checkComfyUIStartSuccess(logContent) {
    const successKeywords = ['To see the GUI go to:', 'Running on local URL', 'Starting server'];
    return successKeywords.some(kw => logContent.includes(kw));
}

// 校验自定义命令参数完整性
function validateCustomCmd(customCmd) {
    if (!customCmd || !customCmd.trim()) return { valid: true, msg: '' };
    // 带值参数列表（必须跟参数值）
    const valueRequiredParams = [
        '--extra-model-paths-config', '--port', '--base-directory', '--output-directory',
        '--temp-directory', '--input-directory', '--cuda-device', '--default-device',
        '--preview-size', '--cache-lru', '--reserve-vram', '--async-offload',
        '--verbose', '--front-end-version', '--front-end-root', '--user-directory',
        '--comfy-api-base', '--database-url', '--max-upload-size'
    ];
    // 解析参数（支持带引号的路径）
    const cmdParts = customCmd.trim().match(/"[^"]+"|\S+/g) || [];
    for (let i = 0; i < cmdParts.length; i++) {
        const param = cmdParts[i].replace(/"/g, '');
        if (valueRequiredParams.includes(param)) {
            // 检查下一个元素是否是参数值（不是以--开头）
            if (i + 1 >= cmdParts.length || cmdParts[i+1].startsWith('--')) {
                return {
                    valid: false,
                    msg: `❌ 自定义命令参数不完整：${param} 需要指定对应的值（如文件路径/数字）`
                };
            }
        }
    }
    return { valid: true, msg: '' };
}

// 启动ComfyUI：修复提前终止问题+精准日志类型+【新增】显示启动命令
function startComfyUI() {
    // 基础配置校验
    if (!config.pythonPath || !fs.existsSync(config.pythonPath) || !config.pythonPath.endsWith('.exe')) {
        sendLog('❌ 启动失败：Python路径无效，请选择正确的python.exe', 'error');
        return;
    }
    if (!config.comfyuiDir || !fs.existsSync(config.comfyuiDir) || !fs.existsSync(path.join(config.comfyuiDir, 'main.py'))) {
        sendLog('❌ 启动失败：ComfyUI目录无效（未找到main.py）', 'error');
        return;
    }
    const port = config.port || 8188;
    if (isNaN(port) || port < 1 || port > 65535) {
        sendLog('❌ 启动失败：端口必须是1-65535之间的数字', 'error');
        return;
    }
    // 校验自定义命令参数完整性
    const cmdValidate = validateCustomCmd(config.customCmd);
    if (!cmdValidate.valid) {
        sendLog(cmdValidate.msg, 'error');
        return;
    }
    // 防止重复启动
    if (comfyProcess && !comfyProcess.killed) {
        sendLog('⚠️ ComfyUI已在运行中，无需重复启动', 'warning');
        return;
    }

    try {
        // 生成启动文件（【修改】接收返回的cmdArgs）
        const { startPath, cmdArgs } = generateStartFile();
        
        // 【新增核心】构建并输出完整的启动命令（清晰展示所有参数）
        sendLog(`🚀 开始启动ComfyUI...`, 'info');
        sendLog(`==================================== 启动命令详情 ====================================`, 'info');
        sendLog(`📝 最终执行的启动命令：`, 'info');
        sendLog(`   → Python路径：${config.pythonPath}`, 'info');
        sendLog(`   → 启动参数：${cmdArgs.join(' ')}`, 'info');
        sendLog(`   → 完整Python命令："${config.pythonPath}" ${cmdArgs.join(' ')}`, 'info');
        sendLog(`   → BAT文件路径：${startPath}`, 'info');
        sendLog(`   → BAT执行命令：cmd.exe /q /c "${startPath}"`, 'info');
        sendLog(`   → 工作目录：${config.comfyuiDir}`, 'info');
        sendLog(`   → 端口：${port}`, 'info');
        sendLog(`   → 代理模式：${config.proxy === 'disabled' ? '禁用' : (config.proxy === 'auto' ? '自动(127.0.0.1:7890)' : `自定义(${config.proxyUrl})`)}`, 'info');
        if (config.customCmd) {
            sendLog(`   → 自定义参数：${config.customCmd}`, 'info');
        }
        sendLog(`====================================================================================`, 'info');
        
        // 优化进程启动：使用绝对路径执行cmd.exe以避免ENOENT错误
        const cmdPath = process.env.windir ? path.join(process.env.windir, 'System32', 'cmd.exe') : 'cmd.exe';
        
        // 定义启动函数
        const startProcess = () => {
            comfyProcess = spawn(cmdPath, ['/q', '/c', startPath], {
                cwd: config.comfyuiDir, // 使用ComfyUI目录作为工作目录
                shell: false, // 禁用shell，避免参数解析错误
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { 
                    ...process.env, 
                    CHCP: '936', // 强制GBK编码
                    PYTHONIOENCODING: 'utf-8' // Python输出编码
                },
                windowsHide: true, // 隐藏CMD窗口
                detached: false
            });
        };
        
        // 尝试启动进程，如果失败则使用备选方案
        try {
            startProcess();
        } catch (e) {
            sendLog(`⚠️ CMD启动失败: ${e.message}，尝试直接执行Python...`, 'warning');
            // 直接执行Python命令作为备选方案
            const cmdArgs = ['main.py', `--port=${port}`];
            if (config.customCmd && config.customCmd.trim()) {
                const customArgs = config.customCmd.trim().match(/"[^"]+"|\S+/g) || [];
                cmdArgs.push(...customArgs.map(arg => arg.replace(/"/g, '')));
            }
            comfyProcess = spawn(config.pythonPath, cmdArgs, {
                cwd: config.comfyuiDir,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { 
                    ...process.env, 
                    PYTHONIOENCODING: 'utf-8'
                },
                windowsHide: true
            });
            
            // 注意：事件监听器将在统一位置添加
        }

        // 启动性能监控
        startPerformanceMonitoring();
        
        // 为当前的comfyProcess添加通用事件监听器
        // 监听标准输出（日志）：精准类型识别
        comfyProcess.stdout.on('data', (data) => {
            const log = convertToUtf8(data);
            if (log && !log.trim().startsWith('chcp 936')) { // 过滤bat自身的chcp输出
                sendLog(log); // 自动识别类型
                // 检测启动成功，自动切换到ComfyUI视图
                if (!isComfyUISuccessStarted && checkComfyUIStartSuccess(log)) {
                    isComfyUISuccessStarted = true;
                    sendLog('🎉 ComfyUI启动成功，正在窗口内加载界面...', 'info');
                    setTimeout(() => loadComfyUIInWindow(), 2000); // 延迟2秒，确保服务就绪
                    
                    // 额外延迟，再次确保界面加载
                    setTimeout(() => {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('switch-view', 'comfyui', `http://localhost:${config.port || 8188}`);
                        }
                    }, 5000); // 5秒后再次确保界面加载
                }
            }
        });

        // 监听错误输出：精准类型识别（不再全部标红）
        comfyProcess.stderr.on('data', (data) => {
            const rawLog = convertToUtf8(data);
            if (rawLog && rawLog.trim()) {
                sendLog(rawLog); // 自动识别类型（不再强制error）
                // 补充检测启动成功
                if (!isComfyUISuccessStarted && checkComfyUIStartSuccess(rawLog)) {
                    isComfyUISuccessStarted = true;
                    sendLog('🎉 ComfyUI启动成功，正在窗口内加载界面...', 'info');
                    setTimeout(() => loadComfyUIInWindow(), 2000);
                }
            }
        });

        // 进程退出事件
        comfyProcess.on('exit', (code) => {
            const log = code === 0 
                ? `✅ ComfyUI正常退出（退出码：${code}）` 
                : `❌ ComfyUI异常退出（退出码：${code}）`;
            sendLog(log, code === 0 ? 'info' : 'error');
            comfyProcess = null;
            isComfyUISuccessStarted = false;
            // 停止性能监控
            stopPerformanceMonitoring();
            // 退出后切回日志视图
            if (currentView === 'comfyui' && mainWindow && !mainWindow.isDestroyed()) {
                currentView = 'log';
                mainWindow.webContents.send('switch-view', 'log');
                mainWindow.setTitle('ComfyUI启动器 - 日志视图');
            }
        });

        // 进程启动错误
        comfyProcess.on('error', (err) => {
            // 检查是否是ENOENT错误（无法找到cmd.exe）
            if (err.code === 'ENOENT' && err.path === cmdPath) {
                sendLog(`❌ 启动失败：无法找到CMD命令处理器，尝试直接执行Python...`, 'error');
                // 直接执行Python命令作为备选方案
                try {
                    const cmdArgs = ['main.py', `--port=${port}`];
                    if (config.customCmd && config.customCmd.trim()) {
                        const customArgs = config.customCmd.trim().match(/"[^"]+"|\S+/g) || [];
                        cmdArgs.push(...customArgs.map(arg => arg.replace(/"/g, '')));
                    }
                    comfyProcess = spawn(config.pythonPath, cmdArgs, {
                        cwd: config.comfyuiDir,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        env: { 
                            ...process.env, 
                            PYTHONIOENCODING: 'utf-8'
                        },
                        windowsHide: true
                    });
                    
                    // 注意：事件监听器将在错误处理之外统一添加
                    // 启动性能监控
                    startPerformanceMonitoring();
                } catch (directExecErr) {
                    sendLog(`❌ 直接执行Python也失败：${directExecErr.message}`, 'error');
                    stopPerformanceMonitoring();
                    killComfyUIProcesses();
                }
            } else {
                sendLog(`❌ 启动失败：${err.message}\n排查建议：1. 检查Python路径 2. 端口是否占用 3. 启动文件是否生成 4. 自定义命令参数是否完整`, 'error');
                // 停止性能监控
                stopPerformanceMonitoring();
                killComfyUIProcesses();
            }
        });

    } catch (e) {
        sendLog(`❌ 启动异常：${e.message}`, 'error');
        // 停止性能监控
        stopPerformanceMonitoring();
        // 修复：仅在启动异常时终止进程，避免提前终止
        if (comfyProcess && !comfyProcess.killed) {
            killComfyUIProcesses();
        }
    }
}

// ==================== 视图管理（窗口内加载ComfyUI） ====================
// 在Electron窗口内加载ComfyUI界面
function loadComfyUIInWindow() {
    if (!isComfyUISuccessStarted) {
        sendLog('⚠️ ComfyUI未启动成功，无法加载界面', 'warning');
        return;
    }
    const port = config.port || 8188;
    const comfyUrl = `http://localhost:${port}`;
    currentView = 'comfyui';

    // 延迟加载，确保服务器完全就绪
    setTimeout(() => {
        // 通知渲染进程切换到ComfyUI视图
        mainWindow.webContents.send('switch-view', 'comfyui', comfyUrl);
        mainWindow.setTitle(`ComfyUI - 端口${port}`);
        
        // 添加加载状态监控
        setTimeout(() => {
            // 检查是否成功加载
            mainWindow.webContents.send('check-comfyui-load-status');
        }, 5000); // 5秒后检查加载状态
        
        // 额外延迟检查，确保界面完全加载
        setTimeout(() => {
            mainWindow.webContents.send('check-comfyui-load-status');
        }, 10000); // 10秒后再检查一次
    }, 3000); // 增加延迟到3秒，确保服务完全就绪
    
    // 额外延迟，确保iframe正确初始化
    setTimeout(() => {
        mainWindow.webContents.send('ensure-iframe-ready');
    }, 1000); // 1秒后确保iframe准备就绪
}

// ==================== 主窗口创建（适配新版Electron） ====================
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1600, // 适配ComfyUI界面宽度
        height: 1000,
        minWidth: 1200,
        minHeight: 800,
        title: 'ComfyUI启动器 - 日志视图',
        webPreferences: {
            nodeIntegration: true,          // 允许渲染进程使用Node API
            contextIsolation: false,        // 关闭隔离，确保ipcRenderer可用
            sandbox: false,                 // 关闭沙箱，避免JS执行限制
            webSecurity: false,             // 允许加载本地网页（解决ComfyUI资源加载）
            allowRunningInsecureContent: true, // 允许加载http本地服务
            // 添加性能优化选项
            experimentalFeatures: false,     // 禁用实验性功能
            offscreen: false,               // 禁用离屏渲染
            spellcheck: false,              // 禁用拼写检查
            scrollBounce: false,            // 禁用弹性滚动效果
            enableWebSQL: false,            // 禁用WebSQL
            javascript: true,               // 启用JavaScript（必需）
            images: true,                   // 重新启用图像加载，这对UI很重要
            textAreasAreResizable: false,   // 禁用文本框缩放
            webgl: false,                   // 禁用WebGL以节省GPU资源
            backgroundThrottling: false,    // 禁用后台标签页节流
            // GPU相关设置
            hardwareAcceleration: false,    // 禁用硬件加速
            plugins: false,                 // 禁用插件
            java: false,                    // 禁用Java
            webaudio: false,                // 禁用Web Audio API
            webgl2: false                  // 禁用WebGL 2.0
        },
        // 确保窗口本身不使用硬件加速
        webgl: false,
        plugins: false,
        experimentalCanvasFeatures: false,
        hardwareAcceleration: false          // 禁用硬件加速
    });

    // 设置额外的性能优化
    mainWindow.setBackgroundColor('#1e1e1e'); // 设置背景色，减少渲染负担
    mainWindow.setAutoHideMenuBar(true); // 自动隐藏菜单栏
    mainWindow.setMenuBarVisibility(false); // 隐藏菜单栏
    
    // 配置session以允许iframe加载本地内容
    mainWindow.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        // 允许本地请求
        callback({});
    });

    // 在加载页面前应用额外的webPreferences
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Cross-Origin-Embedder-Policy': ['cors'],
                'Cross-Origin-Opener-Policy': ['same-origin'],
                'Access-Control-Allow-Origin': ['*'],
                'Access-Control-Allow-Methods': ['GET, POST, OPTIONS'],
                'Access-Control-Allow-Headers': ['*']
            }
        });
    });

    // 配置webPreferences以更好地支持iframe
    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        // 授予所有本地请求权限
        callback(true);
    });

    // 减少渲染进程资源使用
    mainWindow.webContents.setZoomFactor(1); // 设置缩放因子为1，避免不必要的计算

    // 加载日志页面（默认视图）
    mainWindow.loadFile('index.html')
        .catch((err) => {
            sendLog(`❌ 加载日志页面失败：${err.message}`, 'error');
        });

    // 【核心修复】窗口关闭事件：阻止默认行为，等待进程清理完成后再关闭
    mainWindow.on('close', function(e) {
        e.preventDefault(); // 阻止默认关闭
        sendLog(`ℹ️ 窗口关闭中，正在清理ComfyUI进程...`, 'info');
        // 调用异步清理函数，完成后关闭窗口
        killComfyUIProcesses().then(function() {
            mainWindow.destroy(); // 销毁窗口
            app.quit(); // 退出应用
        });
    });

    // 窗口销毁事件
    mainWindow.on('destroyed', function() {
        mainWindow = null;
    });

    // 双击标题栏最大化/还原
    mainWindow.on('double-click', function(e) {
        if (e.target === mainWindow.getTitlebarOverlay()) {
            mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
        }
    });
}

// ==================== 中文菜单（适配需求） ====================
function createChineseMenu() {
    // 【修复】定义异步函数，兼容旧版Node/Electron
    async function stopComfyUIHandler() {
        await killComfyUIProcesses();
    }

    async function exitAppHandler() {
        sendLog(`ℹ️ 应用退出中，正在清理ComfyUI进程...`, 'info');
        await killComfyUIProcesses(); // 等待进程清理完成
        app.quit(); // 退出应用
    }

    const menuTemplate = [
        {
            label: '视图',
            submenu: [
                { 
                    label: '切换到日志视图', 
                    click: function() {
                        if (currentView !== 'log') {
                            currentView = 'log';
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
                        if (currentView === 'log') mainWindow.webContents.reload();
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
                    click: startComfyUI 
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
                    click: exitAppHandler // 【修复】使用预定义的异步函数
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

// ==================== IPC通信（前后端交互） ====================
// 加载配置
ipcMain.on('get-config', function() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('config-loaded', config);
    }
});

// 保存配置
ipcMain.on('save-config', function(_, newConfig) {
    try {
        saveConfig(newConfig);
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
ipcMain.on('start-comfyui', startComfyUI);
ipcMain.on('stop-comfyui', function() {
    // 【修复】异步调用清理函数，兼容旧版语法
    killComfyUIProcesses().then(function() {});
});

// 手动加载ComfyUI界面（备用）
ipcMain.on('load-comfyui-in-window', loadComfyUIInWindow);

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

// ==================== 应用初始化 ====================
app.commandLine.appendSwitch('disable-smooth-scrolling'); // 禁用平滑滚动
app.commandLine.appendSwitch('prerender-from-omnibox', 'disabled'); // 禁用预渲染
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows', 'false'); // 禁用后台隐藏窗口
app.commandLine.appendSwitch('disable-ipc-flooding-protection'); // 禁用IPC洪水保护
app.commandLine.appendSwitch('disable-background-media-suspend'); // 禁用后台媒体暂停
app.commandLine.appendSwitch('disable-hang-monitor'); // 禁用挂起监视器
app.commandLine.appendSwitch('disable-presentation-api'); // 禁用演示API
app.commandLine.appendSwitch('disable-encryption-win'); // 禁用Windows加密
app.commandLine.appendSwitch('disable-quick-menu'); // 禁用快速菜单
app.commandLine.appendSwitch('memory-pressure-off'); // 禁用内存压力通知

// 启用CPU渲染（适度）
app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
app.commandLine.appendSwitch('disable-accelerated-mjpeg-decode');
app.commandLine.appendSwitch('disable-accelerated-video-encode');
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-features', 'TranslateUI,BlinkGenPropertyTrees,ImprovedVideoControls,Printing,PaymentRequest,WebBluetooth,BatteryStatusService');
app.commandLine.appendSwitch('disable-ipc-flooding-protection');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('force-fieldtrial-params', 'WebRTC-Audio-Red-For-Opus/Enabled/');
app.commandLine.appendSwitch('enable-features', 'VizDisplayCompositor');
app.commandLine.appendSwitch('memory-pressure-off');

// 减少内存使用
app.commandLine.appendSwitch('max_old_space_size', '1024'); // 限制V8堆大小
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1024'); // V8引擎内存限制

// 在应用准备就绪后执行
app.whenReady().then(createMainWindow);

// ==================== 应用生命周期（防多实例+进程清理） ====================
// 防止多实例启动
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', function() {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    // 应用就绪
    app.whenReady().then(function() {
        loadConfig();          // 加载配置
        createChineseMenu();   // 创建中文菜单
        startMemoryCleanup();  // 启动内存清理机制
        // 启动器就绪日志
        sendLog('✅ ComfyUI启动器就绪，请先完成配置再启动', 'info');
    });

    // 所有窗口关闭时退出
    app.on('window-all-closed', async function() {
        await killComfyUIProcesses(); // 等待进程清理完成
        if (process.platform !== 'darwin') app.quit();
    });

    // 【核心修复】应用退出前等待进程清理完成
    app.on('before-quit', function(e) {
        e.preventDefault(); // 阻止默认退出
        // 【修复】异步清理后强制退出
        killComfyUIProcesses().then(function() {
            app.exit(0); // 强制退出应用
        });
    });
}