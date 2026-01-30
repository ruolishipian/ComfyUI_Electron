// 引入Electron核心模块
const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os'); // 获取系统信息
const iconv = require('iconv-lite'); // 解决Windows中文日志乱码

// 引入进程管理模块和工具模块
const processManager = require('./modules/processManager');
const utils = require('./modules/utils');

// 全局变量
let mainWindow = null;         // 主窗口实例（日志/ComfyUI视图切换）
let config = {};               // 配置对象
const configFileName = 'comfyui-config.json'; // 配置文件（存储在启动器目录）
const startFileName = 'start_comfyui.bat';    // 启动文件（存储在启动器目录）
let currentView = 'log'; // 当前视图：log（日志）/comfyui（界面）
const userDataPath = app.getPath('userData'); // 用户数据目录（可写）

// 性能监控功能已移至processManager.js

// 核心工具函数已移至processManager.js和utils.js

// 配置管理功能已移至utils.js

// 启动文件生成功能已移至processManager.js

// ==================== 进程管理（精准启停+修复提前终止问题） ====================
// 终止ComfyUI进程：【核心修复】改为Promise异步函数+重复调用防护
function killComfyUIProcesses() {
    // 防止重复调用清理逻辑
    if (isKillingProcess) {
        sendLog(`ℹ️ 进程清理已在执行中，请勿重复操作`, 'warning');
        return Promise.resolve();
    }
    
    // 检查是否有任何需要终止的进程（包括记录的PID）
    if ((!comfyProcess || comfyProcess.killed) && !comfyProcessPid) {
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
                // 检查是否有记录的PID需要终止，即使comfyProcess不存在
                const pid = comfyProcessPid || (comfyProcess ? comfyProcess.pid : null);
                
                if (!comfyProcess || comfyProcess.killed) {
                    // 如果记录的PID存在，尝试终止它
                    if (pid) {
                        sendLog(`ℹ️ ComfyUI主进程已无响应，尝试终止PID ${pid}...`, 'info');
                        
                        exec(`taskkill /F /T /PID ${pid}`, (err, stdout, stderr) => {
                            if (!err) {
                                sendLog(`✅ 终止ComfyUI主进程及子进程（PID：${pid}）`, 'success');
                            } else {
                                // 尝试不带/T的命令
                                exec(`taskkill /F /PID ${pid}`, (simpleErr, simpleStdout, simpleStderr) => {
                                    if (!simpleErr) {
                                        sendLog(`✅ 终止ComfyUI主进程（PID：${pid}）`, 'success');
                                    } else {
                                        // 尝试使用wmic命令
                                        exec(`wmic process where ProcessId=${pid} call terminate`, (wmicErr, wmicOut, wmicErrOut) => {
                                            if (!wmicErr) {
                                                sendLog(`✅ 通过WMIC终止ComfyUI主进程（PID：${pid}）`, 'success');
                                            } else {
                                                // 最后的手段：尝试使用PowerShell终止进程
                                                exec(`powershell -Command "Stop-Process -Id ${pid} -Force"`, (psErr, psOut, psErrOut) => {
                                                    if (!psErr) {
                                                        sendLog(`✅ 通过PowerShell终止ComfyUI主进程（PID：${pid}）`, 'success');
                                                    } else {
                                                        sendLog(`⚠️ 终止主进程失败：无法终止PID ${pid}（建议以管理员身份运行启动器）`, 'warning');
                                                    }
                                                });
                                            }
                                        });
                                    }
                                });
                            }
                            comfyProcess = null;
                            comfyProcessPid = null;
                            // 停止性能监控
                            stopPerformanceMonitoring();
                            cleanupSteps++;
                            resolveStep();
                        });
                    } else {
                        sendLog(`ℹ️ ComfyUI主进程已终止`, 'info');
                        comfyProcess = null;
                        comfyProcessPid = null;
                        cleanupSteps++;
                        resolveStep();
                        return;
                    }
                } else {
                    try {
                        // 空PID防护
                        if (!pid) {
                            sendLog(`ℹ️ ComfyUI主进程PID为空，跳过温和终止`, 'info');
                            comfyProcess = null;
                            comfyProcessPid = null;
                            // 停止性能监控
                            stopPerformanceMonitoring();
                            cleanupSteps++;
                            resolveStep();
                            return;
                        }

                        // 第一步：温和终止（模拟Ctrl+C）
                        // 检查进程是否仍然存在
                        exec(`tasklist /FI "PID eq ${pid}" | findstr /I ${pid}`, (checkErr) => {
                            if (checkErr) {
                                // 如果进程已不存在，直接清理内部状态
                                sendLog(`ℹ️ ComfyUI主进程（PID：${pid}）已不存在，清理内部状态`, 'info');
                                comfyProcess = null;
                                comfyProcessPid = null;
                                stopPerformanceMonitoring();
                                cleanupSteps++;
                                resolveStep();
                            } else {
                                // 进程存在，尝试终止
                                try {
                                    comfyProcess.kill('SIGINT');
                                    sendLog(`ℹ️ 尝试温和终止ComfyUI主进程（PID：${pid}）`, 'info');
                                } catch (e) {
                                    sendLog(`ℹ️ 主进程已无响应，跳过温和终止`, 'info');
                                }

                                // 第二步：立即执行强制终止（含子进程）
                                setTimeout(() => {
                                    exec(`taskkill /F /T /PID ${pid}`, (err, stdout, stderr) => {
                                        if (!err) {
                                            sendLog(`✅ 终止ComfyUI主进程及子进程（PID：${pid}）`, 'success');
                                        } else {
                                            // 尝试不带/T的命令
                                            exec(`taskkill /F /PID ${pid}`, (simpleErr, simpleStdout, simpleStderr) => {
                                                if (!simpleErr) {
                                                    sendLog(`✅ 终止ComfyUI主进程（PID：${pid}）`, 'success');
                                                } else {
                                                    // 尝试最基础的终止命令
                                                    exec(`wmic process where ProcessId=${pid} call terminate`, (wmicErr, wmicOut, wmicErrOut) => {
                                                        if (!wmicErr) {
                                                            sendLog(`✅ 通过WMIC终止ComfyUI主进程（PID：${pid}）`, 'success');
                                                        } else {
                                                            // 使用更简单的错误消息，避免复杂的编码转换
                                                            sendLog(`⚠️ 终止主进程失败：无法终止PID ${pid}（建议以管理员身份运行启动器）`, 'warning');
                                                        }
                                                    });
                                                }
                                            });
                                        }
                                        comfyProcess = null;
                                        comfyProcessPid = null;
                                        // 停止性能监控
                                        stopPerformanceMonitoring();
                                        cleanupSteps++;
                                        resolveStep();
                                    });
                                });
                            }
                        });
                    } catch (e) {
                        sendLog(`⚠️ 终止主进程异常：${convertToUtf8(Buffer.from(e.message))}`, 'warning');
                        comfyProcess = null;
                        comfyProcessPid = null;
                        // 停止性能监控
                        stopPerformanceMonitoring();
                        cleanupSteps++;
                        resolveStep();
                    }
                }
            });
        };

        // 步骤2：兜底清理端口进程
        const killPortProcesses = () => {
            return new Promise((resolveStep) => {
                const port = config.port || 8188;
                // 使用wmic命令代替netstat，更准确地获取端口占用的PID
                exec(`wmic process where "CommandLine like '%:${port}%'" get ProcessId 2>nul`, (err, stdout, stderr) => {
                    if (!err && stdout && stdout.includes('ProcessId')) {
                        // 解析PID并去重
                        const pidMatches = stdout.match(/\d+/g) || [];
                        const pidList = [...new Set(pidMatches)].filter(pid => pid && pid !== '0' && parseInt(pid) !== process.pid);
        
                        if (pidList.length === 0) {
                            sendLog(`ℹ️ 端口${port}未被占用，无需终止额外进程`, 'info');
                            cleanupSteps++;
                            resolveStep();
                            return;
                        }
        
                        sendLog(`ℹ️ 检测到端口${port}被PID：${pidList.join(', ')} 占用，开始终止...`, 'info');
                        let killedCount = 0;
        
                        // 逐个终止PID
                        pidList.forEach(pid => {
                            // 终止存在的PID
                            exec(`taskkill /F /T /PID ${pid}`, (killErr, killStdout, killStderr) => {
                                if (!killErr) {
                                    sendLog(`✅ 终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                } else {
                                    // 尝试使用更简单的taskkill命令
                                    exec(`taskkill /PID ${pid} /F`, (simpleKillErr, simpleKillStdout, simpleKillStderr) => {
                                        if (!simpleKillErr) {
                                            sendLog(`✅ 终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                        } else {
                                            // 解码错误信息
                                            const killErrMsg = convertToUtf8(simpleKillStderr || Buffer.from(simpleKillErr.message));
                                            sendLog(`⚠️ 终止端口进程${pid}失败：${killErrMsg}（建议以管理员身份运行）`, 'warning');
                                        }
                                    });
                                }
                                killedCount++;  
                                if (killedCount === pidList.length) {
                                    cleanupSteps++;
                                    resolveStep();
                                }
                            });
                        });
                    } else {
                        // 如果wmic命令失败，回退到原来的netstat方法
                        exec(`netstat -ano | findstr :${port}`, (err2, stdout2, stderr2) => {
                            if (!err2 && stdout2) {
                                // 解析PID并去重
                                const lines = stdout2.trim().split('\r\n');
                                const pidList = [...new Set(lines.map(line => {
                                    const parts = line.trim().split(/\s+/);
                                    return parts.length > 4 ? parts[4] : null; // PID通常在第5列
                                }).filter(pid => pid && pid !== '0' && parseInt(pid) !== process.pid))];
        
                                if (pidList.length === 0) {
                                    sendLog(`ℹ️ 端口${port}未被占用，无需终止额外进程`, 'info');
                                    cleanupSteps++;
                                    resolveStep();
                                    return;
                                }
        
                                sendLog(`ℹ️ 检测到端口${port}被PID：${pidList.join(', ')} 占用，开始终止...`, 'info');
                                let killedCount = 0;
        
                                pidList.forEach(pid => {
                                    exec(`taskkill /F /T /PID ${pid}`, (killErr, killStdout, killStderr) => {
                                        if (!killErr) {
                                            sendLog(`✅ 终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                        } else {
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
                            } else {
                                sendLog(`ℹ️ 未检测到端口${port}占用或检测失败`, 'info');
                                cleanupSteps++;
                                resolveStep();
                            }
                        });
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
        sendLog(`   → 代理模式：${config.proxy === 'disabled' ? '禁用' : (config.proxy === 'auto' ? '自动代理' : `自定义代理: ${config.proxyUrl}`)}`, 'info');
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
                    PYTHONIOENCODING: 'utf-8', // Python输出编码
                    // 检测系统代理设置，避免ComfyUI Manager错误使用代理
                    // 如果系统设置了代理，传递给ComfyUI以正确处理
                    ...(process.env.HTTP_PROXY || process.env.HTTPS_PROXY ? {
                        HTTP_PROXY: process.env.HTTP_PROXY,
                        HTTPS_PROXY: process.env.HTTPS_PROXY,
                        NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1,::1'
                    } : {
                        // 如果没有系统代理，显式禁用代理以避免自动探测
                        HTTP_PROXY: '',
                        HTTPS_PROXY: '',
                        NO_PROXY: 'localhost,127.0.0.1,::1'
                    }),
                    // ComfyUI Manager特定设置
                    COMFYUI_MANAGER_DISABLE_HOST_CHECK: 'true'
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
                    PYTHONIOENCODING: 'utf-8',
                    // 检测系统代理设置，避免ComfyUI Manager错误使用代理
                    // 如果系统设置了代理，传递给ComfyUI以正确处理
                    ...(process.env.HTTP_PROXY || process.env.HTTPS_PROXY ? {
                        HTTP_PROXY: process.env.HTTP_PROXY,
                        HTTPS_PROXY: process.env.HTTPS_PROXY,
                        NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1,::1'
                    } : {
                        // 如果没有系统代理，显式禁用代理以避免自动探测
                        HTTP_PROXY: '',
                        HTTPS_PROXY: '',
                        NO_PROXY: 'localhost,127.0.0.1,::1'
                    }),
                    // ComfyUI Manager特定设置
                    COMFYUI_MANAGER_DISABLE_HOST_CHECK: 'true'
                },
                windowsHide: true
            });
            
            // 注意：事件监听器将在统一位置添加
        }

        // 记录主进程PID
        if (comfyProcess.pid) {
            comfyProcessPid = comfyProcess.pid;
            sendLog(`ℹ️ ComfyUI主进程已启动，PID：${comfyProcessPid}`, 'info');
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
                            mainWindow.webContents.send('switch-view', 'comfyui', `http://localhost:${(config && config.port) || 8188}`);
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
            comfyProcessPid = null; // 清除记录的PID
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
                        const customArgs = config.customCmd.trim().match(/"[^\"]+"|\S+/g) || [];
                        cmdArgs.push(...customArgs.map(arg => arg.replace(/"/g, '')));
                    }
                    comfyProcess = spawn(config.pythonPath, cmdArgs, {
                        cwd: config.comfyuiDir,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        env: { 
                            ...process.env, 
                            PYTHONIOENCODING: 'utf-8',
                            // 检测系统代理设置，避免ComfyUI Manager错误使用代理
                            // 如果系统设置了代理，传递给ComfyUI以正确处理
                            ...(process.env.HTTP_PROXY || process.env.HTTPS_PROXY ? {
                                HTTP_PROXY: process.env.HTTP_PROXY,
                                HTTPS_PROXY: process.env.HTTPS_PROXY,
                                NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1,::1'
                            } : {
                                // 如果没有系统代理，显式禁用代理以避免自动探测
                                HTTP_PROXY: '',
                                HTTPS_PROXY: '',
                                NO_PROXY: 'localhost,127.0.0.1,::1'
                            }),
                            // ComfyUI Manager特定设置
                            COMFYUI_MANAGER_DISABLE_HOST_CHECK: 'true'
                        },
                        windowsHide: true
                    });
                            
                    // 记录主进程PID
                    if (comfyProcess.pid) {
                        comfyProcessPid = comfyProcess.pid;
                        sendLog(`ℹ️ ComfyUI主进程已启动，PID：${comfyProcessPid}`, 'info');
                    }
                            
                    // 注意：事件监听器将在错误处理之外统一添加
                    // 启动性能监控
                    startPerformanceMonitoring();
                } catch (directExecErr) {
                    sendLog(`❌ 直接执行Python也失败：${directExecErr.message}`, 'error');
                    stopPerformanceMonitoring();
                    comfyProcess = null;
                    comfyProcessPid = null;
                    killComfyUIProcesses();
                }
            } else {
                sendLog(`❌ 启动失败：${err.message}\n排查建议：1. 检查Python路径 2. 端口是否占用 3. 启动文件是否生成 4. 自定义命令参数是否完整`, 'error');
                // 停止性能监控
                stopPerformanceMonitoring();
                comfyProcess = null;
                comfyProcessPid = null;
                killComfyUIProcesses();
            }
        });

    } catch (e) {
        sendLog(`❌ 启动异常：${e.message}`, 'error');
        // 停止性能监控
        stopPerformanceMonitoring();
        comfyProcess = null;
        comfyProcessPid = null;
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
    const port = (config && config.port) || 8188;
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
            allowFileAccess: true,          // 允许文件访问（解决ComfyUI Manager问题）
            nodeIntegrationInWorker: true,  // 允许Web Workers中使用Node.js
            webviewTag: true,               // 启用webview标签（可能需要用于插件）
            additionalArguments: ['--disable-web-security', '--allow-file-access-from-files', '--allow-cross-origin-auth-prompt', '--disable-features=site-per-process'], // 额外的安全参数
            // 添加性能优化选项
            experimentalFeatures: false,     // 禁用实验性功能
            offscreen: false,               // 禁用离屏渲染
            spellcheck: false,              // 禁用拼写检查
            scrollBounce: false,            // 禁用弹性滚动效果
            enableWebSQL: false,            // 禁用WebSQL
            javascript: true,               // 启用JavaScript（必需）
            images: true,                   // 启用图像加载，确保图标正常显示
            textAreasAreResizable: false,   // 禁用文本框缩放
            webgl: true,                    // 启用WebGL，提高渲染性能
            backgroundThrottling: false,    // 禁用后台标签页节流
            // GPU相关设置
            hardwareAcceleration: true,    // 启用硬件加速，提高渲染性能
            plugins: false,                 // 禁用插件
            java: false,                    // 禁用Java
            webaudio: false,                // 禁用Web Audio API
            webgl2: false                  // 禁用主窗口WebGL 2.0
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
    
    // 配置session以允许iframe加载本地内容和特定目录访问
    mainWindow.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        // 允许本地请求和ComfyUI相关目录访问
        if (details.url.startsWith('file:')) {
            // 检查是否是ComfyUI相关目录
            const isComfyUIDir = details.url.includes('ComfyUI') && 
                             (details.url.includes('custom_nodes') || 
                              details.url.includes('models') || 
                              details.url.includes('input') || 
                              details.url.includes('output'));
            if (isComfyUIDir) {
                callback({}); // 允许ComfyUI相关目录访问
            } else {
                callback({}); // 其他文件访问也允许
            }
        } else {
            callback({});
        }
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
                'Access-Control-Allow-Headers': ['*'],
                'Access-Control-Allow-Private-Network': ['true']
            }
        });
    });

    // 配置webPreferences以更好地支持iframe和ComfyUI插件访问
    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, details, callback) => {
        // 特别处理ComfyUI相关的权限请求
        const requestingUrl = details.requestingUrl || '';
        const isComfyUIRelated = requestingUrl.includes('ComfyUI') || requestingUrl.includes('localhost') || requestingUrl.includes('127.0.0.1');
        
        if (isComfyUIRelated) {
            // 对ComfyUI相关请求授予所需权限
            callback(true);
        } else {
            // 其他请求也授予权限，确保功能正常
            callback(true);
        }
    });

    // 减少渲染进程资源使用
    mainWindow.webContents.setZoomFactor(1); // 设置缩放因子为1，避免不必要的计算

    // 加载日志页面（默认视图）
    mainWindow.loadFile('index.html')
        .catch((err) => {
            utils.sendLog(`❌ 加载日志页面失败：${err.message}`, 'error', mainWindow);
        });

    // 【核心修复】窗口关闭事件：阻止默认行为，等待进程清理完成后再关闭
    mainWindow.on('close', function(e) {
        e.preventDefault(); // 阻止默认关闭
        utils.sendLog(`ℹ️ 窗口关闭中，正在清理ComfyUI进程...`, 'info', mainWindow);
        // 调用异步清理函数，完成后关闭窗口
        processManager.killComfyUIProcesses().then(function() {
            mainWindow.destroy(); // 销毁窗口
            app.quit(); // 退出应用
        });
    });
    
    // 【修复】确保主窗口引用可用于停止进程
    global.mainWindow = mainWindow;  // 将主窗口引用设为全局，便于其他函数访问

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
        await processManager.killComfyUIProcesses();
    }

    async function exitAppHandler() {
        utils.sendLog(`ℹ️ 应用退出中，正在清理ComfyUI进程...`, 'info', mainWindow);
        await processManager.killComfyUIProcesses(); // 等待进程清理完成
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
                    click: function() {
                        processManager.startComfyUI(os, userDataPath, configFileName, startFileName);
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
        const updatedConfig = utils.saveConfig(newConfig, userDataPath, configFileName);
        config = updatedConfig;
        processManager.setConfig(config);
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
        utils.sendLog(`❌ 路径选择失败：${e.message}`, 'error', mainWindow);
        mainWindow.webContents.send('path-selected', null);
    }
});

// 启动/停止ComfyUI
ipcMain.on('start-comfyui', function() {
    processManager.startComfyUI(os, userDataPath, configFileName, startFileName);
});
ipcMain.on('stop-comfyui', function() {
    processManager.killComfyUIProcesses();
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
ipcMain.on('load-comfyui-in-window', loadComfyUIInWindow);

// 内存清理机制、检查管理员权限和系统代理检测已移至utils.js

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

// 网络请求配置
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('ignore-certificate-errors-spki-list');
app.commandLine.appendSwitch('allow-running-insecure-content');
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('allow-file-access-from-files');

// 减少内存使用
app.commandLine.appendSwitch('max_old_space_size', '1024'); // 限制V8堆大小
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1024'); // V8引擎内存限制

// 在应用准备就绪后执行
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

    // 设置应用级别的安全策略
    app.commandLine.appendSwitch('disable-web-security');
    app.commandLine.appendSwitch('allow-file-access-from-files');
    app.commandLine.appendSwitch('allow-universal-access-from-files');
    app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
    
    app.on('web-contents-created', (event, contents) => {
        contents.on('will-navigate', (event, navigationUrl) => {
            // 允许导航到本地文件、localhost和ComfyUI相关路径
            const isLocalhost = navigationUrl.startsWith('http://localhost') || navigationUrl.startsWith('http://127.0.0.1');
            const isFile = navigationUrl.startsWith('file://');
            const isComfyUI = navigationUrl.includes('ComfyUI');
            const isCustomNodes = navigationUrl.includes('custom_nodes');
            
            if (!(isLocalhost || isFile || isComfyUI || isCustomNodes)) {
                event.preventDefault();
            }
        });
        
        // 设置权限请求处理器
        contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
            const url = webContents.getURL();
            // 对ComfyUI相关请求授权，包括网络请求和自定义节点访问
            if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('ComfyUI') || 
                url.includes('custom_nodes') || permission === 'media' || permission === 'geolocation' || 
                permission === 'notifications' || permission === 'midi' || 
                permission === 'clipboard-read' || permission === 'clipboard-write' ||
                permission === 'filesystem' || permission === 'openExternal' ||
                permission === 'display-capture' || permission === 'pointerLock') {
                callback(true); // 授予权限
            } else {
                callback(false); // 拒绝权限
            }
        });
        
        // 设置文件系统权限
        contents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
            // 空值检查：防止webContents为null
            if (!webContents || !webContents.getURL) {
                return false;
            }
            const url = webContents.getURL();
            // 允许ComfyUI和自定义节点相关的文件系统访问
            if (url.includes('ComfyUI') || url.includes('custom_nodes') || url.includes('ComfyUI-Manager')) {
                return true;
            }
            
            // 特别处理：如果请求的是本地文件路径且包含custom_nodes
            if (details && details.securityOrigin && (details.securityOrigin.includes('custom_nodes') || details.securityOrigin.includes('ComfyUI-Manager'))) {
                return true;
            }
            
            // 额外增强：允许所有本地文件访问（用于ComfyUI Manager）
            if (url.startsWith('file://') && (url.includes('custom_nodes') || url.includes('ComfyUI-Manager'))) {
                return true;
            }
            // 特殊处理：如果details中有custom_nodes相关路径
            if (details && details.securityOrigin && (details.securityOrigin.includes('custom_nodes') || details.securityOrigin.includes('ComfyUI-Manager'))) {
                return true;
            }
            return false;
        });
        
        // 设置文件路径过滤器 - Electron 28+中setFilePathPermissionCheckHandler已被移除
        // 使用setPermissionCheckHandler替代
        // contents.session.setFilePathPermissionCheckHandler((webContents, filePath, permission) => {
        //     // 允许访问ComfyUI相关目录
        //     if (filePath.includes('ComfyUI') && (filePath.includes('custom_nodes') || filePath.includes('ComfyUI-Manager'))) {
        //         return true;
        //     }
        //     return false;
        // });
        
        // 处理安全策略违规
        contents.on('did-attach-webview', (event, webPreferences, params) => {
            // 为webview设置适当的安全选项
            webPreferences.nodeIntegration = true;
            webPreferences.contextIsolation = false;
            webPreferences.webSecurity = false;
        });
        
        // 处理安全策略违规事件
        contents.on('render-process-gone', (event, details) => {
            console.log('Render process gone:', details.reason);
        });
        
        // 处理CSP违规
        contents.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
            // 忽略证书错误以允许本地访问
            event.preventDefault();
            callback(true);
        });
    });
    
    // 应用就绪
    app.whenReady().then(async function() {
        await utils.checkAdminRights();  // 检查管理员权限
        config = utils.loadConfig(userDataPath, configFileName);          // 加载配置
        
        // 创建主窗口
        createMainWindow();    // 创建主窗口
        
        // 初始化processManager（必须在createMainWindow之后执行，因为需要mainWindow实例）
        processManager.setMainWindow(mainWindow);
        processManager.setConfig(config);
        processManager.setSendLogFn((content, type) => utils.sendLog(content, type, mainWindow));
        
        // 检测系统代理设置并自动配置（仅在自动代理模式下）
        if (config.proxy === 'auto') {
            const systemProxy = utils.detectSystemProxy();
            if (systemProxy) {
                // 如果检测到系统代理，在日志中提示但不改变配置模式
                utils.sendLog(`💡 自动代理模式：检测到系统代理: ${systemProxy}，将在启动时应用`, 'info', mainWindow);
            } else {
                utils.sendLog(`ℹ️ 自动代理模式：未检测到系统代理，将使用直连模式`, 'info', mainWindow);
            }
        }
        
        createChineseMenu();   // 创建中文菜单
        utils.startMemoryCleanup();  // 启动内存清理机制
        // 启动器就绪日志
        utils.sendLog('✅ ComfyUI启动器就绪，请先完成配置再启动', 'info', mainWindow);
    });

    // 所有窗口关闭时退出
    app.on('window-all-closed', async function() {
        await processManager.killComfyUIProcesses(); // 等待进程清理完成
        if (process.platform !== 'darwin') app.quit();
    });

    // 【核心修复】应用退出前等待进程清理完成
    app.on('before-quit', function(e) {
        e.preventDefault(); // 阻止默认退出
        // 【修复】异步清理后强制退出
        processManager.killComfyUIProcesses().then(function() {
            app.exit(0); // 强制退出应用
        });
    });
}