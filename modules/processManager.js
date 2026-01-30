// 进程管理模块
const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite'); // 解决Windows中文日志乱码
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads'); // 添加Worker Threads支持

// 全局变量（需要从主进程中传入）
let mainWindow = null;
let comfyProcess = null;
let comfyProcessPid = null;
let config = {};
let isComfyUISuccessStarted = false;
let currentView = 'log';
let isKillingProcess = false;
let isStartingProcess = false; // 标识是否正在启动中
let startupTimeout = null; // 启动超时定时器
let lastOutputTime = null; // 最后一次收到输出信息的时间
let performanceMonitorInterval = null;
let sendLog = null; // 从主进程传入的日志函数
let isStartupComplete = false; // 启动完成标志
let stopRequested = false; // 停止请求标志
let stopCheckInterval; // 停止检查定时器

// 设置主窗口引用
function setMainWindow(window) {
    mainWindow = window;
}

// 设置配置引用
function setConfig(cfg) {
    config = cfg;
}

// 设置日志函数
function setSendLogFn(logFn) {
    sendLog = logFn;
}

// 设置内部变量引用
function setInternalRefs(refs) {
    comfyProcess = refs.comfyProcessRef;
    comfyProcessPid = refs.comfyProcessPidRef;
    isComfyUISuccessStarted = refs.isComfyUISuccessStartedRef;
    currentView = refs.currentViewRef;
    isKillingProcess = refs.isKillingProcessRef;
    isStartingProcess = refs.isStartingProcessRef;
    performanceMonitorInterval = refs.performanceMonitorIntervalRef;
}

// ==================== 性能监控功能 ====================
function startPerformanceMonitoring() {
    if (performanceMonitorInterval) {
        clearInterval(performanceMonitorInterval);
    }

    performanceMonitorInterval = setInterval(() => {
        // 对象存在性检查：防止Object has been destroyed错误
        if (!mainWindow || mainWindow.isDestroyed() || !comfyProcess || comfyProcess.killed) {
            clearInterval(performanceMonitorInterval);
            performanceMonitorInterval = null;
            return;
        }

        // 动态引入os模块以避免重复引入
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
    }, 5000); // 每5秒更新一次
}

function stopPerformanceMonitoring() {
    if (performanceMonitorInterval) {
        clearInterval(performanceMonitorInterval);
        performanceMonitorInterval = null;
    }
}

// 【终极修复】自动检测编码，解决所有乱码问题
// 【新增】安全文件操作函数，避免文件占用问题
function safeFileOperation(operation, maxRetries = 3) {
    let retryCount = 0;

    const attempt = () => {
        try {
            return operation();
        } catch (error) {
            if (retryCount < maxRetries && (error.code === 'EBUSY' || error.code === 'EPERM' || error.message.includes('正在使用') || error.message.includes('WinError 32'))) {
                retryCount++;
                sendLog(`⚠️ 文件操作被占用，正在重试 (${retryCount}/${maxRetries})...`, 'warning');

                // 等待一段时间后重试
                setTimeout(attempt, 500 * retryCount);
                return null;
            } else {
                throw error;
            }
        }
    };

    return attempt();
}

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

// 【新增】清理终端ANSI转义码（颜色/光标移动等格式代码）
function clearAnsiCodes(text) {
    // 匹配所有ANSI转义序列，覆盖绝大多数终端格式代码
    const ansiPattern = /\x1B(?:[@-Z\\-_]|\[.*?[a-zA-Z])/g;
    return text.replace(ansiPattern, '');
}

// 检测ComfyUI启动成功（精准匹配日志关键词）
function checkComfyUIStartSuccess(logContent) {
    // 增强的启动成功检测，覆盖更多可能的日志格式
    const successKeywords = [
        'To see the GUI go to:',
        'Running on local URL',
        'Starting server',
        'ComfyUI is running on',
        'Server started on',
        'http://127.0.0.1:',
        'localhost:',
        'Successfully started',
        'Uvicorn running on', // 添加对uvicorn服务器启动的检测
        'application finished', // 某些情况下成功启动的标志
        'ComfyUI successfully started' // 更明确的成功启动标志
    ];
    return successKeywords.some(kw => logContent.includes(kw));
}

// 检查端口是否被占用
function checkPortAvailable(port) {
    return new Promise((resolve) => {
        const net = require('net');
        const tester = net.createServer()
            .once('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    sendLog(`⚠️ 端口 ${port} 已被占用`, 'warning');
                    resolve(false);
                } else {
                    sendLog(`⚠️ 检查端口 ${port} 时出错: ${err.message}`, 'warning');
                    resolve(false);
                }
            })
            .once('listening', () => {
                tester.once('close', () => resolve(true)).close();
            })
            .listen(port, '127.0.0.1');
    });
}

// 清理占用特定端口的进程
async function killPortProcesses(port) {
    return new Promise((resolveStep) => {
        sendLog(`🔄 开始清理端口 ${port} 上的进程...`, 'info');

        // 设置端口清理超时
        const portTimeout = setTimeout(() => {
            sendLog(`⚠️ 端口${port}清理超时，继续执行后续步骤`, 'warning');
            resolveStep();
        }, 15000); // 15秒超时

        // 使用wmic命令代替netstat，更准确地获取端口占用的PID
        exec(`wmic process where "CommandLine like '%:${port}%'" get ProcessId 2>nul`, (err, stdout, stderr) => {
            // 清除超时定时器
            clearTimeout(portTimeout);

            if (!err && stdout && stdout.includes('ProcessId')) {
                // 解析PID并去重
                const pidMatches = stdout.match(/\d+/g) || [];
                const pidList = [...new Set(pidMatches)].filter(pid => pid && pid !== '0' && parseInt(pid) !== process.pid);

                if (pidList.length === 0) {
                    sendLog(`ℹ️ 端口${port}未被占用，无需终止额外进程`, 'info');
                    resolveStep();
                    return;
                }

                sendLog(`ℹ️ 检测到端口${port}被PID：${pidList.join(', ')} 占用，开始终止...`, 'info');
                let killedCount = 0;

                // 逐个终止PID
                pidList.forEach(pid => {
                    // 使用多种方法强力终止进程
                    const killAttempts = [];

                    // 方法1: wmic terminate (优先使用，通常更可靠)
                    killAttempts.push(new Promise((resolve) => {
                        exec(`wmic process where ProcessId=${pid} call terminate`, (wmicErr, wmicOut, wmicErrOut) => {
                            if (!wmicErr && wmicOut && wmicOut.toLowerCase().includes('terminate')) {
                                sendLog(`✅ 通过WMIC终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                resolve('success');
                            } else {
                                // 方法2: taskkill /F /T (终止进程树)
                                exec(`taskkill /F /T /PID ${pid}`, (killErr, killStdout, killStderr) => {
                                    if (!killErr) {
                                        sendLog(`✅ 终止占用端口${port}的进程及子进程（PID：${pid}）`, 'success');
                                        resolve('success');
                                    } else {
                                        // 方法3: taskkill /F (仅终止主进程)
                                        exec(`taskkill /F /PID ${pid}`, (simpleKillErr, simpleKillStdout, simpleKillStderr) => {
                                            if (!simpleKillErr) {
                                                sendLog(`✅ 终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                                resolve('success');
                                            } else {
                                                // 方法4: PowerShell Stop-Process
                                                exec(`powershell -Command "Stop-Process -Id ${pid} -Force"`, (psErr, psOut, psErrOut) => {
                                                    if (!psErr) {
                                                        sendLog(`✅ 通过PowerShell终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                                        resolve('success');
                                                    } else {
                                                        // 如果第一个PowerShell命令失败，尝试更复杂的命令
                                                        exec(`powershell -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"`, (ps2Err, ps2Out, ps2ErrOut) => {
                                                            if (!ps2Err) {
                                                                sendLog(`✅ 通过高级PowerShell终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                                                resolve('success');
                                                            } else {
                                                                // 如果PowerShell也失败，尝试使用wmic再次终止
                                                                exec(`wmic process where ProcessId=${pid} call terminate`, (wmicRetryErr, wmicRetryOut, wmicRetryErrOut) => {
                                                                    if (!wmicRetryErr && wmicRetryOut && wmicRetryOut.toLowerCase().includes('terminate')) {
                                                                        sendLog(`✅ 通过重试WMIC终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                                                        resolve('success');
                                                                    } else {
                                                                        // 尝试最终的强力终止方法
                                                                        exec(`powershell -Command "Get-WmiObject -Class Win32_Process -Filter 'ProcessId = ${pid}' | ForEach-Object { \$_.Terminate() }"`, (wmiFinalErr, wmiFinalOut, wmiFinalErrOut) => {
                                                                            if (!wmiFinalErr) {
                                                                                sendLog(`✅ 通过WMI对象终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                                                                resolve('success');
                                                                            } else {
                                                                                // 所有方法都失败
                                                                                const killErrMsg = convertToUtf8(wmicRetryErr.message || ps2Err.message || psErr.message || simpleKillStderr || Buffer.from(simpleKillErr.message || 'Unknown error'));
                                                                                sendLog(`⚠️ 终止端口进程${pid}失败：${killErrMsg}（建议以管理员身份运行）`, 'warning');
                                                                                sendLog(`💡 可能的原因：进程已完成退出，或者权限不足，或者进程处于特殊状态`, 'info');
                                                                                resolve('failed');
                                                                            }
                                                                        });
                                                                    }
                                                                });
                                                            }
                                                        });
                                                    }
                                                });
                                            }
                                        });
                                    }
                                });
                            }
                        });
                    }));

                    // 等待当前PID的终止尝试完成
                    Promise.all(killAttempts).then(() => {
                        killedCount++;
                        if (killedCount === pidList.length) {
                            // 额外延迟确保进程完全终止
                            setTimeout(() => {
                                resolveStep();
                            }, 1000);
                        }
                    });
                });
            } else {
                // 如果wmic命令失败，回退到原来的netstat方法
                exec(`netstat -ano | findstr :${port}`, (err2, stdout2, stderr2) => {
                    // 清除超时定时器（如果是在这里执行的话）
                    clearTimeout(portTimeout);

                    if (!err2 && stdout2) {
                        // 解析PID并去重
                        const lines = stdout2.trim().split('\r\n');
                        const pidList = [...new Set(lines.map(line => {
                            const parts = line.trim().split(/\s+/);
                            return parts.length > 4 ? parts[4] : null; // PID通常在第5列
                        }).filter(pid => pid && pid !== '0' && parseInt(pid) !== process.pid))];

                        if (pidList.length === 0) {
                            sendLog(`ℹ️ 端口${port}未被占用，无需终止额外进程`, 'info');
                            resolveStep();
                            return;
                        }

                        sendLog(`ℹ️ 检测到端口${port}被PID：${pidList.join(', ')} 占用，开始终止...`, 'info');
                        let killedCount = 0;

                        pidList.forEach(pid => {
                            // 使用多种方法强力终止进程
                            const killAttempts = [];

                            // 方法1: wmic terminate (优先使用，通常更可靠)
                            killAttempts.push(new Promise((resolve) => {
                                exec(`wmic process where ProcessId=${pid} call terminate`, (wmicErr, wmicOut, wmicErrOut) => {
                                    if (!wmicErr && wmicOut && wmicOut.toLowerCase().includes('terminate')) {
                                        sendLog(`✅ 通过WMIC终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                        resolve('success');
                                    } else {
                                        // 方法2: taskkill /F /T (终止进程树)
                                        exec(`taskkill /F /T /PID ${pid}`, (killErr, killStdout, killStderr) => {
                                            if (!killErr) {
                                                sendLog(`✅ 终止占用端口${port}的进程及子进程（PID：${pid}）`, 'success');
                                                resolve('success');
                                            } else {
                                                // 方法3: taskkill /F (仅终止主进程)
                                                exec(`taskkill /F /PID ${pid}`, (simpleKillErr, simpleKillStdout, simpleKillStderr) => {
                                                    if (!simpleKillErr) {
                                                        sendLog(`✅ 终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                                        resolve('success');
                                                    } else {
                                                        // 方法4: PowerShell Stop-Process
                                                        exec(`powershell -Command "Stop-Process -Id ${pid} -Force"`, (psErr, psOut, psErrOut) => {
                                                            if (!psErr) {
                                                                sendLog(`✅ 通过PowerShell终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                                                resolve('success');
                                                            } else {
                                                                // 如果第一个PowerShell命令失败，尝试更复杂的命令
                                                                exec(`powershell -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"`, (ps2Err, ps2Out, ps2ErrOut) => {
                                                                    if (!ps2Err) {
                                                                        sendLog(`✅ 通过高级PowerShell终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                                                        resolve('success');
                                                                    } else {
                                                                        // 如果PowerShell也失败，尝试使用wmic再次终止
                                                                        exec(`wmic process where ProcessId=${pid} call terminate`, (wmicRetryErr, wmicRetryOut, wmicRetryErrOut) => {
                                                                            if (!wmicRetryErr && wmicRetryOut && wmicRetryOut.toLowerCase().includes('terminate')) {
                                                                                sendLog(`✅ 通过重试WMIC终止占用端口${port}的进程（PID：${pid}）`, 'success');
                                                                                resolve('success');
                                                                            } else {
                                                                                // 所有方法都失败
                                                                                const killErrMsg = convertToUtf8(wmicRetryErr.message || ps2Err.message || psErr.message || simpleKillStderr || Buffer.from(simpleKillErr.message || 'Unknown error'));
                                                                                sendLog(`⚠️ 终止端口进程${pid}失败：${killErrMsg}（建议以管理员身份运行）`, 'warning');
                                                                                sendLog(`💡 可能的原因：进程已完成退出，或者权限不足，或者进程处于特殊状态`, 'info');
                                                                                resolve('failed');
                                                                            }
                                                                        });
                                                                    }
                                                                });
                                                            }
                                                        });
                                                    }
                                                });
                                            }
                                        });
                                    }
                                });
                            }));

                            // 等待当前PID的终止尝试完成
                            Promise.all(killAttempts).then(() => {
                                killedCount++;
                                if (killedCount === pidList.length) {
                                    // 额外延迟确保进程完全终止
                                    setTimeout(() => {
                                        resolveStep();
                                    }, 1000);
                                }
                            });
                        });
                    } else {
                        sendLog(`ℹ️ 未检测到端口${port}占用或检测失败`, 'info');
                        resolveStep();
                    }
                });
            }
        });
    });
}

// 检查进程是否存在
function checkProcessExists(pid) {
    try {
        if (process.platform === 'win32') {
            const result = execSync(`tasklist /FI "PID eq ${pid}"`, { encoding: 'utf8' });
            return result.toLowerCase().includes(` ${pid} `);
        } else {
            process.kill(pid, 0);
            return true;
        }
    } catch (e) {
        return false;
    }
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
            if (i + 1 >= cmdParts.length || cmdParts[i + 1].startsWith('--')) {
                return {
                    valid: false,
                    msg: `❌ 自定义命令参数不完整：${param} 需要指定对应的值（如文件路径/数字）`
                };
            }
        }
    }
    return { valid: true, msg: '' };
}

// 设置可中断能力 - 这是关键函数，确保在spawn的同时就准备好"随时中断"的能力
function setupInterruptibleCapability() {
    // 立即检查是否已经收到终止请求（在spawn之后立刻检查）
    if (isKillingProcess) {
        forceKillCurrentProcess();
        sendLog('⏹️ 检测到停止请求，已终止刚启动的进程', 'info');
        return;
    }
}

// 生成ComfyUI启动文件（bat）：GBK编码+CRLF换行+适配带空格路径
function generateStartFile(userDataPath, configFileName, startFileName, currentConfig = null) {
    const startPath = path.join(userDataPath, startFileName);

    // 如果提供了currentConfig，则使用它，否则使用模块级config
    const useConfig = currentConfig || config;

    const port = useConfig.port || 8188;
    const cmdArgs = [
        'main.py', 
        `--port=${port}`,
        '--preview-size', '512',    // 缩略图/预览尺寸
        '--cache-lru', '100',       // 缓存LRU大小
        '--reserve-vram', '0.5',    // 保留显存比例
        '--async-offload'          // 异步离线处理
    ];

    // 解析自定义命令：支持带引号的路径
    if (useConfig.customCmd && useConfig.customCmd.trim()) {
        const cmdParts = useConfig.customCmd.trim().match(/"[^"]+"|\S+/g) || [];
        // 移除引号，添加到参数列表
        cmdArgs.push(...cmdParts.map(part => part.replace(/"/g, '')));
    }

    // 构建bat内容：CRLF换行+GBK编码+chcp 936（适配Windows CMD）
    let batContent = `@echo off\r\n`; // 强制CRLF换行
    batContent += `chcp 936 >nul\r\n`; // 改用GBK（Windows CMD原生编码）
    batContent += `mode con cp select=936 >nul\r\n`; // 确保控制台编码一致
    batContent += `cd /d "${useConfig.comfyuiDir}"\r\n`; // 切换到ComfyUI目录（支持带空格路径）

    // 添加文件锁定处理参数，减少日志文件冲突
    batContent += `set COMFYUI_LOG_BACKUP_COUNT=0\r\n`; // 禁用日志备份，减少文件锁定
    batContent += `set COMFYUI_LOG_ROTATION_ENABLED=false\r\n`; // 禁用日志轮转
    batContent += `set COMFYUI_MANAGER_DISABLE_LOGGING=false\r\n`; // 确保Manager日志功能正常

    // 根据代理模式设置环境变量
    if (useConfig.proxy === 'auto') {
        // 自动代理模式下，检测系统代理设置
        const systemProxy = detectSystemProxy();
        if (systemProxy) {
            // 如果检测到系统代理，则使用它
            const formattedProxy = systemProxy.startsWith('http') ? systemProxy : `http://${systemProxy}`;
            batContent += `set HTTP_PROXY=${formattedProxy}\r\n`;
            batContent += `set HTTPS_PROXY=${formattedProxy}\r\n`;
            batContent += `set NO_PROXY=localhost,127.0.0.1,::1\r\n`;
            // 同时禁用ComfyUI Manager的代理检测以避免冲突
            batContent += `set COMFYUI_MANAGER_DISABLE_HOST_CHECK=true\r\n`;
        } else {
            // 如果未检测到系统代理，禁用ComfyUI Manager的代理功能
            batContent += `set COMFYUI_MANAGER_DISABLE_HOST_CHECK=true\r\n`;
        }
    } else if (useConfig.proxy === 'custom' && useConfig.proxyUrl) {
        // 自定义代理模式下，使用用户指定的代理，不进行额外检测
        const formattedProxy = useConfig.proxyUrl.startsWith('http') ? useConfig.proxyUrl : `http://${useConfig.proxyUrl}`;
        batContent += `set HTTP_PROXY=${formattedProxy}\r\n`;
        batContent += `set HTTPS_PROXY=${formattedProxy}\r\n`;
        batContent += `set NO_PROXY=localhost,127.0.0.1,::1\r\n`;
        // 同时禁用ComfyUI Manager的代理检测以避免冲突
        batContent += `set COMFYUI_MANAGER_DISABLE_HOST_CHECK=true\r\n`;
    } else {
        // 禁用模式，禁用ComfyUI Manager的代理功能
        batContent += `set COMFYUI_MANAGER_DISABLE_HOST_CHECK=true\r\n`;
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
    if (useConfig.customCmd && useConfig.customCmd.trim()) {
        const cmdParts = useConfig.customCmd.trim().match(/"[^"]+"|\S+/g) || [];
        optimizedCmdArgs.push(...cmdParts.map(part => part.replace(/"/g, '')));
    }

    // 添加参数来减少文件锁定冲突
    batContent += `set COMFYUI_LOG_BACKUP_COUNT=0\r\n`; // 禁用日志备份，减少文件锁定
    batContent += `set COMFYUI_LOG_ROTATION_ENABLED=false\r\n`; // 禁用日志轮转

    batContent += `"${useConfig.pythonPath}" ${optimizedCmdArgs.join(' ')}\r\n`;
    batContent += `pause\r\n`; // 保留暂停，便于查看错误

    // GBK编码写入
    try {
        const gbkContent = iconv.encode(batContent, 'gbk');
        fs.writeFileSync(startPath, gbkContent, { flag: 'w' });
        sendLog(`✅ 生成启动文件到用户数据目录：${startPath}（GBK编码+CRLF换行）`, 'info');
        return { startPath, cmdArgs };
    } catch (e) {
        sendLog(`❌ 生成启动文件失败：${e.message}`, 'error');
        throw e;
    }
}

// ==================== 进程管理（精准启停+修复提前终止问题） ====================
// 终止ComfyUI进程：【核心修复】改为Promise异步函数+重复调用防护
let terminationInProgress = false; // 防止重复终止

// 检查进程状态
function checkProcessStatus() {
    if (comfyProcess && !comfyProcess.killed) {
        const exists = checkProcessExists(comfyProcess.pid);
        return { exists, pid: comfyProcess.pid };
    } else {
        return { exists: false, pid: null };
    }
}

// 立即终止当前进程
async function terminateCurrentProcess() {
    if (!comfyProcess || terminationInProgress) {
        return;
    }

    terminationInProgress = true;

    try {
        const pid = comfyProcess.pid;
        sendLog(`⚡ 开始终止ComfyUI进程，PID: ${pid}`, 'info');

        // 发送停止信号到ComfyUI
        try {
            comfyProcess.stdin.write('q\n'); // 尝试发送退出命令
        } catch (e) {
            sendLog('💡 无法写入stdin', 'info');
        }

        // 移除事件监听器
        comfyProcess.removeAllListeners();

        // 立即终止进程树
        await killProcessTree(pid);

        sendLog('✅ 进程终止完成', 'info');
        comfyProcess = null;
        comfyProcessPid = null;

        if (startupTimeout) {
            clearTimeout(startupTimeout);
            startupTimeout = null;
        }
    } catch (error) {
        sendLog(`⚠️ 终止进程时出错: ${error.message}`, 'warning');
    } finally {
        terminationInProgress = false;
    }
}

// 跨平台的进程终止函数
function killProcessTree(pid) {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            // Windows系统 - 使用多种方法确保终止
            // 方法1: 使用wmic获取子进程并终止
            exec(`wmic process where "ParentProcessId=${pid}" get ProcessId 2>nul`, (error, stdout) => {
                if (!error && stdout) {
                    const lines = stdout.trim().split('\n');
                    for (let i = 1; i < lines.length; i++) {
                        const subPid = lines[i].trim();
                        if (subPid && !isNaN(subPid)) {
                            exec(`taskkill /pid ${subPid} /F`, { timeout: 2000 }, (killSubErr, killSubStdout, killSubStderr) => {
                                if (killSubErr) {
                                    sendLog(`终止子进程 ${subPid} 失败: ${killSubStderr}`, 'warning');
                                }
                            });
                        }
                    }
                }

                // 最后终止主进程
                exec(`taskkill /pid ${pid} /F`, (error, stdout, stderr) => {
                    if (error) {
                        sendLog(`执行taskkill失败: ${stderr}`, 'warning');
                        // 尝试使用powershell
                        exec(`powershell -Command "Stop-Process -Id ${pid} -Force"`, { timeout: 3000 }, (psError) => {
                            if (psError) {
                                sendLog(`PowerShell终止也失败: ${psError.message}`, 'warning');
                                // 不要reject，继续处理
                            } else {
                                sendLog(`使用PowerShell终止进程 ${pid} 成功`, 'info');
                            }

                            // 再次验证进程是否真的被终止
                            setTimeout(() => {
                                try {
                                    process.kill(pid, 0); // 检查进程是否存在
                                    sendLog(`进程 ${pid} 仍在运行，强制终止...`, 'warning');
                                    exec(`taskkill /pid ${pid} /F`, { timeout: 2000 }, (finalKillErr, finalKillStdout, finalKillStderr) => {
                                        if (!finalKillErr) {
                                            sendLog(`最终强制终止进程 ${pid} 成功`, 'info');
                                        }
                                        resolve();
                                    });
                                } catch (e) {
                                    sendLog(`进程 ${pid} 已不存在`, 'info');
                                    resolve();
                                }
                            }, 500);
                        });
                    } else {
                        sendLog(`成功终止进程树 PID: ${pid}`, 'info');

                        // 再次验证进程是否真的被终止
                        setTimeout(() => {
                            try {
                                process.kill(pid, 0); // 检查进程是否存在
                                sendLog(`进程 ${pid} 仍在运行，强制终止...`, 'warning');
                                exec(`taskkill /pid ${pid} /F`, { timeout: 2000 }, (finalKillErr, finalKillStdout, finalKillStderr) => {
                                    if (!finalKillErr) {
                                        sendLog(`最终强制终止进程 ${pid} 成功`, 'info');
                                    }
                                    resolve();
                                });
                            } catch (e) {
                                sendLog(`进程 ${pid} 已不存在`, 'info');
                                resolve();
                            }
                        }, 500);
                    }
                });
            });
        } else {
            // Unix/Linux/macOS系统
            exec(`pgrep -P ${pid}`, (error, stdout) => {
                if (!error && stdout) {
                    const childPids = stdout.trim().split('\n').filter(id => id && !isNaN(id));
                    childPids.forEach(childPid => {
                        try {
                            process.kill(parseInt(childPid), 'SIGKILL');
                        } catch (e) {
                            sendLog(`终止子进程 ${childPid} 失败: ${e.message}`, 'warning');
                        }
                    });
                }

                try {
                    process.kill(pid, 'SIGKILL');
                    sendLog(`成功终止进程 PID: ${pid}`, 'info');
                } catch (e) {
                    sendLog(`进程 ${pid} 可能已不存在: ${e.message}`, 'warning');
                }

                resolve();
            });
        }
    });
}

// 强制终止当前ComfyUI进程（支持启动中随时中断）
function forceKillCurrentProcess() {
    if (!comfyProcess) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const pid = comfyProcess.pid;
        sendLog(`💀 强制终止 ComfyUI 进程树 PID: ${pid}`, 'info');

        try {
            // 1. 销毁所有 stdio 流（阻止进一步 I/O）
            if (comfyProcess.stdin) comfyProcess.stdin.destroy();
            if (comfyProcess.stdout) comfyProcess.stdout.destroy();
            if (comfyProcess.stderr) comfyProcess.stderr.destroy();

            // 2. 移除所有监听器
            comfyProcess.removeAllListeners();

            // 3. Windows 下：使用 taskkill /T /F 终止整个进程树
            if (process.platform === 'win32') {
                exec(`taskkill /pid ${pid} /T /F`, { timeout: 3000 }, (killErr, killStdout, killStderr) => {
                    if (!killErr) {
                        sendLog(`✅ 成功终止进程树 ${pid}`, 'info');
                    } else {
                        sendLog(`⚠️ taskkill 失败: ${killStderr}`, 'warning');
                        // 尝试备用方法
                        try {
                            process.kill(pid, 'SIGTERM');
                        } catch (e) {
                            sendLog(`💡 进程 ${pid} 可能已不存在: ${e.message}`, 'info');
                        }
                    }

                    // 确保进程引用被清除
                    comfyProcess = null;
                    comfyProcessPid = null;
                    // 停止性能监控
                    stopPerformanceMonitoring();
                    resolve();
                });
            } else {
                // Unix-like: 发送 SIGKILL 到进程组
                try {
                    process.kill(-pid, 'SIGKILL'); // 负 PID 表示进程组
                    sendLog(`✅ 终止进程组 ${pid}`, 'info');
                } catch (e) {
                    try {
                        process.kill(pid, 'SIGKILL');
                        sendLog(`✅ 终止进程 ${pid}`, 'info');
                    } catch (e2) {
                        sendLog(`💡 进程 ${pid} 可能已不存在: ${e2.message}`, 'info');
                    }
                }

                // 确保进程引用被清除
                comfyProcess = null;
                comfyProcessPid = null;
                // 停止性能监控
                stopPerformanceMonitoring();
                resolve();
            }
        } catch (e) {
            sendLog(`终止进程时出错: ${e.message}`, 'warning');

            // 最后的保障措施
            try {
                comfyProcess.kill();
            } catch (e2) {
                // 进程可能已经终止
            }

            comfyProcess = null;
            comfyProcessPid = null;
            // 停止性能监控
            stopPerformanceMonitoring();
            resolve();
        }
    });
}

// 停止ComfyUI进程
function killComfyUIProcesses() {
    // 防止重复调用清理逻辑
    if (isKillingProcess) {
        sendLog(`ℹ️ 进程清理已在执行中，请勿重复操作`, 'warning');
        return Promise.resolve();
    }

    // 检查是否有任何需要终止的进程（包括记录的PID）
    if ((!comfyProcess || comfyProcess.killed) && !comfyProcessPid && !isStartingProcess) {
        isComfyUISuccessStarted = false;
        isKillingProcess = true; // 确保设置停止标志

        // 即使没有直接的进程，也要清理端口上的相关进程
        sendLog('⏹️ 开始停止ComfyUI...', 'info');
        return new Promise((resolve) => {
            // 清理端口上的进程
            const killPortProcessesStep = () => {
                return new Promise((resolveStep) => {
                    const port = (typeof config !== 'undefined' && config.port) ? config.port : 8188;
                    killPortProcesses(port).then(() => {
                        resolveStep();
                    });
                });
            };

            killPortProcessesStep().then(() => {
                // 停止性能监控
                stopPerformanceMonitoring();
                sendLog('✅ ComfyUI进程清理完成（未终止的PID为已退出的无效进程）', 'success');
                isKillingProcess = false; // 重置状态标记
                resolve(true);
            });
        });
    }

    isKillingProcess = true; // 标记为清理中
    isComfyUISuccessStarted = false;
    sendLog('⏹️ 开始停止ComfyUI...', 'info');

    // 如果正在启动中，立即强制终止（核心修复）
    if (isStartingProcess) {
        sendLog('🛑 检测到启动中，立即强制终止启动过程...', 'info');
        return new Promise((resolve) => {
            forceKillCurrentProcess().then(() => {
                // 清理端口上的进程
                const port = (typeof config !== 'undefined' && config.port) ? config.port : 8188;
                killPortProcesses(port).then(() => {
                    // 停止性能监控
                    stopPerformanceMonitoring();
                    isStartingProcess = false; // 重置启动标志
                    isKillingProcess = false; // 重置状态标记
                    sendLog('✅ ComfyUI启动过程已强制终止', 'success');
                    resolve(true);
                });
            });
        });
    }

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

                        // 优先使用WMIC命令（通常比taskkill更可靠）
                        exec(`wmic process where ProcessId=${pid} call terminate`, (wmicErr, wmicOut, wmicErrOut) => {
                            if (!wmicErr && wmicOut && wmicOut.toLowerCase().includes('terminate')) {
                                sendLog(`✅ 通过WMIC终止ComfyUI主进程（PID：${pid}）`, 'success');
                            } else {
                                // WMIC失败，尝试taskkill /F /T
                                exec(`taskkill /F /T /PID ${pid}`, (err, stdout, stderr) => {
                                    if (!err) {
                                        sendLog(`✅ 终止ComfyUI主进程及子进程（PID：${pid}）`, 'success');
                                    } else {
                                        // taskkill /T 失败，尝试不带/T的命令
                                        exec(`taskkill /F /PID ${pid}`, (simpleErr, simpleStdout, simpleStderr) => {
                                            if (!simpleErr) {
                                                sendLog(`✅ 终止ComfyUI主进程（PID：${pid}）`, 'success');
                                            } else {
                                                // 最后的手段：尝试使用PowerShell终止进程
                                                exec(`powershell -Command "Stop-Process -Id ${pid} -Force"`, (psErr, psOut, psErrOut) => {
                                                    if (!psErr) {
                                                        sendLog(`✅ 通过PowerShell终止ComfyUI主进程（PID：${pid}）`, 'success');
                                                    } else {
                                                        // 如果第一个PowerShell命令失败，尝试更复杂的命令
                                                        exec(`powershell -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"`, (ps2Err, ps2Out, ps2ErrOut) => {
                                                            if (!ps2Err) {
                                                                sendLog(`✅ 通过高级PowerShell终止ComfyUI主进程（PID：${pid}）`, 'success');
                                                            } else {
                                                                // 如果PowerShell也失败，尝试使用wmic再次终止
                                                                exec(`wmic process where ProcessId=${pid} call terminate`, (wmicRetryErr, wmicRetryOut, wmicRetryErrOut) => {
                                                                    if (!wmicRetryErr && wmicRetryOut && wmicRetryOut.toLowerCase().includes('terminate')) {
                                                                        sendLog(`✅ 通过重试WMIC终止ComfyUI主进程（PID：${pid}）`, 'success');
                                                                    } else {
                                                                        sendLog(`⚠️ 终止主进程失败：无法终止PID ${pid}（建议以管理员身份运行启动器）`, 'warning');
                                                                        sendLog(`💡 可能的原因：进程已完成退出，或者权限不足，或者进程处于特殊状态`, 'info');
                                                                    }
                                                                });
                                                            }
                                                        });
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
                        // 设置超时机制，防止无限等待
                        const timeoutHandle = setTimeout(() => {
                            sendLog(`⚠️ 终止主进程超时（PID ${pid}），继续执行后续清理步骤`, 'warning');
                            comfyProcess = null;
                            comfyProcessPid = null;
                            stopPerformanceMonitoring();
                            cleanupSteps++;
                            resolveStep();
                        }, 10000); // 10秒超时

                        exec(`tasklist /FI "PID eq ${pid}" | findstr /I ${pid}`, (checkErr) => {
                            // 清除超时定时器
                            clearTimeout(timeoutHandle);

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
                                // 使用多种方法确保进程被终止
                                setTimeout(() => {
                                    // 优先使用WMIC命令
                                    exec(`wmic process where ProcessId=${pid} call terminate`, (wmicErr, wmicOut, wmicErrOut) => {
                                        if (!wmicErr && wmicOut && wmicOut.toLowerCase().includes('terminate')) {
                                            sendLog(`✅ 通过WMIC终止ComfyUI主进程（PID：${pid}）`, 'success');
                                        } else {
                                            // WMIC失败，尝试taskkill /F /T
                                            exec(`taskkill /F /T /PID ${pid}`, (err, stdout, stderr) => {
                                                if (!err) {
                                                    sendLog(`✅ 终止ComfyUI主进程及子进程（PID：${pid}）`, 'success');
                                                } else {
                                                    // taskkill失败，尝试PowerShell
                                                    exec(`powershell -Command "Stop-Process -Id ${pid} -Force"`, (psErr, psOut, psErrOut) => {
                                                        if (!psErr) {
                                                            sendLog(`✅ 通过PowerShell终止ComfyUI主进程（PID：${pid}）`, 'success');
                                                        } else {
                                                            sendLog(`⚠️ 所有终止方法均失败，无法终止PID ${pid}（建议以管理员身份运行启动器）`, 'warning');
                                                        }
                                                    });
                                                }
                                            });
                                        }
                                        comfyProcess = null;
                                        comfyProcessPid = null;
                                        stopPerformanceMonitoring();
                                        cleanupSteps++;
                                        resolveStep();
                                    });
                                }, 1000);
                            }
                        });
                    } catch (e) {
                        sendLog(`⚠️ 终止主进程时出错: ${e.message}`, 'warning');
                        comfyProcess = null;
                        comfyProcessPid = null;
                        stopPerformanceMonitoring();
                        cleanupSteps++;
                        resolveStep();
                    }
                }
            });
        };

        // 步骤2：清理端口上的进程
        const killPortProcessesStep = () => {
            return new Promise((resolveStep) => {
                const port = config.port || 8188;
                killPortProcesses(port).then(() => {
                    cleanupSteps++;
                    resolveStep();
                });
            });
        };

        // 执行清理步骤
        killMainProcess().then(() => {
            return killPortProcessesStep();
        }).then(() => {
            // 停止性能监控
            stopPerformanceMonitoring();
            sendLog('✅ ComfyUI进程清理完成', 'success');
            isKillingProcess = false; // 重置状态标记
            resolve(true);
        }).catch((error) => {
            sendLog(`⚠️ 清理进程时出错: ${error.message}`, 'warning');
            isKillingProcess = false; // 重置状态标记
            resolve(false);
        });
    });
}

// 检测系统代理设置
function detectSystemProxy() {
    try {
        if (process.platform === 'win32') {
            // Windows系统：读取注册表中的代理设置
            const regResult = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf8' });
            const match = regResult.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/);
            if (match && match[1]) {
                return match[1];
            }
        } else {
            // Unix/Linux/macOS系统：读取环境变量
            return process.env.http_proxy || process.env.HTTP_PROXY || null;
        }
    } catch (e) {
        // 读取失败，返回null
        return null;
    }
    return null;
}

// 检查ComfyUI服务是否健康
function checkComfyUIHealth(port, maxRetries = 5, retryInterval = 1000) {
    return new Promise((resolve) => {
        const http = require('http');
        let retryCount = 0;

        const checkHealth = () => {
            // 使用127.0.0.1而不是localhost，避免IPv6解析问题
            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: '/',
                method: 'GET',
                timeout: 3000
            };

            const req = http.request(options, (res) => {
                if (res.statusCode === 200) {
                    sendLog(`✅ ComfyUI服务健康检查通过，状态码: ${res.statusCode}`, 'info');
                    resolve(true);
                } else {
                    sendLog(`⚠️ ComfyUI服务健康检查状态码: ${res.statusCode}`, 'warning');
                    retryOrFail();
                }
            });

            req.on('error', (error) => {
                sendLog(`⚠️ ComfyUI服务健康检查失败: ${error.message}`, 'warning');
                retryOrFail();
            });

            req.on('timeout', () => {
                sendLog('⚠️ ComfyUI服务健康检查超时', 'warning');
                req.destroy();
                retryOrFail();
            });

            req.end();
        };

        const retryOrFail = () => {
            retryCount++;
            if (retryCount < maxRetries) {
                sendLog(`🔄 健康检查重试中 (${retryCount}/${maxRetries})...`, 'info');
                setTimeout(checkHealth, retryInterval);
            } else {
                sendLog('⚠️ ComfyUI服务健康检查未通过，但将继续尝试加载', 'warning');
                resolve(false); // 即使健康检查失败，也继续尝试加载
            }
        };

        checkHealth();
    });
}

// 加载ComfyUI到窗口
async function loadComfyUIInWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    try {
        const port = config.port || 8188;
        const comfyUrl = `http://localhost:${port}`;
        sendLog(`🌐 准备加载ComfyUI: ${comfyUrl}`, 'info');

        // 先检查ComfyUI服务是否健康
        sendLog('🔍 正在检查ComfyUI服务健康状态...', 'info');
        const isHealthy = await checkComfyUIHealth(port);

        if (!isHealthy) {
            sendLog('⚠️ ComfyUI服务未完全就绪，将继续尝试加载', 'warning');
        }

        // 使用前端HTML中定义的iframe来加载ComfyUI
        // 通过IPC发送消息给前端，让前端处理视图切换和iframe加载
        sendLog('🔄 切换到ComfyUI视图并加载iframe...', 'info');
        mainWindow.webContents.send('switch-view', 'comfyui', comfyUrl);
        mainWindow.setTitle('ComfyUI启动器 - ComfyUI视图');
        currentView = 'comfyui';

        // 监听加载完成事件
        mainWindow.webContents.once('did-finish-load', () => {
            sendLog('✅ ComfyUI页面加载完成', 'success');
        });

        // 监听加载失败事件
        mainWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
            sendLog(`❌ ComfyUI页面加载失败: ${errorDescription} (错误码: ${errorCode})`, 'error');
            sendLog('💡 建议：检查ComfyUI服务是否正常运行，或尝试手动刷新页面', 'info');
        });

        // 监听导航完成事件
        mainWindow.webContents.once('did-navigate', (event, url) => {
            sendLog(`✅ ComfyUI导航完成: ${url}`, 'info');
        });

        // 监听导航失败事件
        mainWindow.webContents.once('did-fail-navigate', (event, url, errorCode, errorDescription) => {
            sendLog(`❌ ComfyUI导航失败: ${errorDescription} (错误码: ${errorCode})`, 'error');
        });
    } catch (e) {
        sendLog(`❌ 加载ComfyUI到窗口失败: ${e.message}`, 'error');
        sendLog('💡 建议：检查网络连接和ComfyUI服务状态', 'info');
    }
}

// 检测重复消息
let lastMessage = '';
let messageRepeatCount = 0;
function isDuplicateMessage(message) {
    if (message === lastMessage) {
        messageRepeatCount++;
        if (messageRepeatCount > 3) {
            // 每10条重复消息只显示一条
            if (messageRepeatCount % 10 === 0) {
                sendLog(`⚠️ 检测到重复消息（已过滤 ${messageRepeatCount} 条）: ${message}`, 'warning');
            }
            return true;
        }
    } else {
        messageRepeatCount = 0;
    }
    return false;
}

// 更新最后一条消息
function updateLastMessage(message) {
    lastMessage = message;
}

// 执行启动ComfyUI的核心函数
async function performStartComfyUI(userDataPath, configFileName, startFileName) {
    if (isStartingProcess) {
        sendLog('⚠️ ComfyUI正在启动中，请勿重复操作', 'warning');
        return false;
    }

    if (isComfyUISuccessStarted) {
        sendLog('ℹ️ ComfyUI已经在运行中', 'info');
        return true;
    }

    isStartingProcess = true;
    isKillingProcess = false;
    isComfyUISuccessStarted = false;
    isStartupComplete = false;
    lastMessage = '';
    messageRepeatCount = 0;

    try {
        // 清理端口
        const port = config.port || 8188;
        sendLog(`🔄 检查端口 ${port} 是否被占用...`, 'info');
        await killPortProcesses(port);

        // 构建命令参数
        const cmdArgs = [
            'main.py', 
            `--port=${port}`,
            '--preview-size', '512',    // 缩略图/预览尺寸
            '--cache-lru', '100',       // 缓存LRU大小
            '--reserve-vram', '0.5',    // 保留显存比例
            '--async-offload'          // 异步离线处理
        ];
        
        // 解析自定义命令：支持带引号的路径
        if (config.customCmd && config.customCmd.trim()) {
            const cmdParts = config.customCmd.trim().match(/"[^"]+"|\S+/g) || [];
            // 移除引号，添加到参数列表
            cmdArgs.push(...cmdParts.map(part => part.replace(/"/g, '')));
        }

        // 启动ComfyUI
        sendLog('🚀 启动ComfyUI...', 'info');
        sendLog(`📂 工作目录: ${config.comfyuiDir}`, 'info');
        sendLog(`🐍 Python路径: ${config.pythonPath}`, 'info');
        sendLog(`🌐 端口: ${port}`, 'info');
        sendLog(`📋 命令参数: ${cmdArgs.join(' ')}`, 'info');

        // 初始化最后输出时间
        lastOutputTime = Date.now();
        
        // 【核心修复】添加基于输出信息的超时检测
        const checkTimeout = () => {
            if (!isComfyUISuccessStarted && !isKillingProcess) {
                const currentTime = Date.now();
                const timeSinceLastOutput = currentTime - lastOutputTime;
                
                // 如果超过5分钟没有输出信息，或者总启动时间超过10分钟，判定为超时
                if (timeSinceLastOutput > 300000 || currentTime - startTime > 600000) {
                    sendLog('❌ ComfyUI启动超时，可能存在问题', 'error');
                    sendLog('💡 排查建议：1. 检查Python环境 2. 检查ComfyUI目录 3. 检查端口占用 4. 检查网络连接', 'info');
                    sendLog(`📊 超时详情：最后输出时间距今 ${Math.round(timeSinceLastOutput / 1000)} 秒，总启动时间 ${Math.round((currentTime - startTime) / 1000)} 秒`, 'info');
                    forceKillCurrentProcess();
                    isStartingProcess = false;
                    return;
                }
                
                // 继续检查
                startupTimeout = setTimeout(checkTimeout, 30000); // 每30秒检查一次
            }
        };
        
        const startTime = Date.now();
        startupTimeout = setTimeout(checkTimeout, 30000); // 30秒后开始检查

        // 构建环境变量
        const envVars = {
            ...process.env,
            PYTHONUNBUFFERED: '1', // 禁用Python缓冲
            COMFYUI_LOG_BACKUP_COUNT: '0', // 禁用日志备份
            COMFYUI_LOG_ROTATION_ENABLED: 'false' // 禁用日志轮转
        };

        // 添加代理环境变量
        if (config.proxy === 'auto') {
            const systemProxy = detectSystemProxy();
            if (systemProxy) {
                const formattedProxy = systemProxy.startsWith('http') ? systemProxy : `http://${systemProxy}`;
                envVars.HTTP_PROXY = formattedProxy;
                envVars.HTTPS_PROXY = formattedProxy;
                envVars.NO_PROXY = 'localhost,127.0.0.1,::1';
            }
        } else if (config.proxy === 'custom' && config.proxyUrl) {
            const formattedProxy = config.proxyUrl.startsWith('http') ? config.proxyUrl : `http://${config.proxyUrl}`;
            envVars.HTTP_PROXY = formattedProxy;
            envVars.HTTPS_PROXY = formattedProxy;
            envVars.NO_PROXY = 'localhost,127.0.0.1,::1';
        }

        // 【核心修复】直接启动Python进程，不再通过cmd.exe
        comfyProcess = spawn(config.pythonPath, cmdArgs, {
            cwd: config.comfyuiDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: envVars
        });

        comfyProcessPid = comfyProcess.pid;
        sendLog(`✅ ComfyUI进程已启动，PID: ${comfyProcess.pid}`, 'success');

        // 【核心修复】设置可中断能力
        setupInterruptibleCapability();

        // 监听错误事件
        comfyProcess.on('error', (error) => {
            sendLog(`❌ ComfyUI启动失败: ${error.message}`, 'error');
            comfyProcess = null;
            comfyProcessPid = null;
            isStartingProcess = false;
            if (startupTimeout) {
                clearTimeout(startupTimeout);
                startupTimeout = null;
            }
        });

        // 监听退出事件
        comfyProcess.on('exit', (code) => {
            if (startupTimeout) {
                clearTimeout(startupTimeout);
                startupTimeout = null;
            }

            if (isKillingProcess) {
                sendLog('⏹️ ComfyUI进程已退出', 'info');
            } else if (isStartingProcess) {
                sendLog(`❌ ComfyUI启动失败（退出码：${code}）`, 'error');
                sendLog('💡 排查建议：1. 检查Python环境 2. 检查ComfyUI目录 3. 检查端口占用 4. 检查网络连接', 'info');
            } else if (isComfyUISuccessStarted) {
                sendLog(`ℹ️ ComfyUI进程已退出（退出码：${code}）`, 'info');
            } else {
                const log = code === 0
                    ? `✅ ComfyUI正常退出（退出码：${code}）`
                    : `❌ ComfyUI异常退出（退出码：${code}）`;
                sendLog(log, code === 0 ? 'info' : 'error');
            }

            comfyProcess = null;
            comfyProcessPid = null;
            isComfyUISuccessStarted = false;
            isStartupComplete = false;
            isStartingProcess = false;
            // 停止性能监控
            stopPerformanceMonitoring();
            // 退出后切回日志视图
            if (currentView === 'comfyui' && mainWindow && !mainWindow.isDestroyed()) {
                currentView = 'log';
                mainWindow.webContents.send('switch-view', 'log');
                mainWindow.setTitle('ComfyUI启动器 - 日志视图');
            }
        });

        // 监听标准错误
        comfyProcess.stderr.on('data', (data) => {
            const rawLog = convertToUtf8(data);
            if (rawLog && rawLog.trim()) {
                // 检查是否在启动过程中收到停止请求（在处理任何输出之前）
                if (isKillingProcess) {
                    return; // 如果正在终止，则忽略所有输出
                }

                // 检查是否为重复消息
                if (isDuplicateMessage(rawLog)) {
                    return; // 忽略重复消息
                }
                updateLastMessage(rawLog);

                // 更新最后输出时间
                lastOutputTime = Date.now();
                
                if (!isStartupComplete) {
                    // 发送到前端显示
                    sendLog(rawLog); // 自动识别类型，不再强制设为error

                    // 检查是否在启动过程中收到停止请求（双重检查）
                    if (isKillingProcess) {
                        return; // 如果正在终止，则忽略所有输出
                    }

                    // 检测启动成功（错误输出中也可能包含成功信息）
                    if (!isComfyUISuccessStarted && checkComfyUIStartSuccess(rawLog)) {
                        isComfyUISuccessStarted = true;
                        isStartupComplete = true; // 标记启动完成
                        sendLog('🎉 ComfyUI启动成功，正在窗口内加载界面...', 'info');

                        setTimeout(async () => await loadComfyUIInWindow(), 3000); // 延迟3秒，确保服务完全就绪
                    }
                } else {
                    // 启动完成后，自动识别日志类型
                    sendLog(rawLog); // 自动识别类型，不再强制设为error
                }
            }
        });

        // 监听标准输出
        comfyProcess.stdout.on('data', (data) => {
            const rawLog = convertToUtf8(data);
            if (rawLog && rawLog.trim()) {
                // 检查是否在启动过程中收到停止请求（在处理任何输出之前）
                if (isKillingProcess) {
                    return; // 如果正在终止，则忽略所有输出
                }

                // 检查是否为重复消息
                if (isDuplicateMessage(rawLog)) {
                    return; // 忽略重复消息
                }
                updateLastMessage(rawLog);

                // 更新最后输出时间
                lastOutputTime = Date.now();
                
                if (!isStartupComplete) {
                    // 发送到前端显示
                    sendLog(rawLog); // 自动识别类型

                    // 检查是否在启动过程中收到停止请求（双重检查）
                    if (isKillingProcess) {
                        return; // 如果正在终止，则忽略所有输出
                    }

                    // 检测启动成功
                    if (!isComfyUISuccessStarted && checkComfyUIStartSuccess(rawLog)) {
                        isComfyUISuccessStarted = true;
                        isStartupComplete = true; // 标记启动完成
                        sendLog('🎉 ComfyUI启动成功，正在窗口内加载界面...', 'info');

                        setTimeout(async () => await loadComfyUIInWindow(), 3000); // 延迟3秒，确保服务完全就绪
                    }
                } else {
                    // 启动完成后，直接发送日志
                    sendLog(rawLog);
                }
            }
        });

        // 启动性能监控
        startPerformanceMonitoring();

        return true;
    } catch (error) {
        sendLog(`❌ 启动ComfyUI失败: ${error.message}`, 'error');
        isStartingProcess = false;
        return false;
    }
}

// 使用 Worker Threads 清理占用特定端口的进程
async function killPortProcessesWithWorker(port) {
    return new Promise((resolve, reject) => {
        try {
            sendLog(`🔄 使用 Worker Threads 开始清理端口 ${port} 上的进程...`, 'info');

            // 创建 Worker 线程
            const worker = new Worker(__filename, {
                workerData: { port }
            });

            // 接收 Worker 线程的消息
            worker.on('message', (message) => {
                sendLog(`✅ Worker Threads 端口清理完成：${message}`, 'info');
                resolve();
            });

            // 处理 Worker 线程的错误
            worker.on('error', (error) => {
                sendLog(`⚠️ Worker Threads 错误：${error.message}`, 'warning');
                reject(error);
            });

            // 处理 Worker 线程的退出
            worker.on('exit', (code) => {
                if (code !== 0) {
                    sendLog(`⚠️ Worker Threads 异常退出，代码：${code}`, 'warning');
                }
            });
        } catch (error) {
            sendLog(`⚠️ 创建 Worker Threads 失败：${error.message}`, 'warning');
            // 回退到同步方法
            killPortProcesses(port).then(resolve).catch(reject);
        }
    });
}

// 使用 Worker Threads 检查进程状态
async function checkProcessStatusWithWorker(pid) {
    return new Promise((resolve, reject) => {
        try {
            sendLog(`🔄 使用 Worker Threads 检查进程状态，PID: ${pid}`, 'info');

            // 创建 Worker 线程
            const worker = new Worker(__filename, {
                workerData: { pid, action: 'checkProcess' }
            });

            // 接收 Worker 线程的消息
            worker.on('message', (message) => {
                sendLog(`✅ Worker Threads 进程状态检查完成：${message.status ? '进程存在' : '进程不存在'}`, 'info');
                resolve({ exists: message.status, pid });
            });

            // 处理 Worker 线程的错误
            worker.on('error', (error) => {
                sendLog(`⚠️ Worker Threads 错误：${error.message}`, 'warning');
                reject(error);
            });

            // 处理 Worker 线程的退出
            worker.on('exit', (code) => {
                if (code !== 0) {
                    sendLog(`⚠️ Worker Threads 异常退出，代码：${code}`, 'warning');
                }
            });
        } catch (error) {
            sendLog(`⚠️ 创建 Worker Threads 失败：${error.message}`, 'warning');
            // 回退到同步方法
            resolve({ exists: checkProcessExists(pid), pid });
        }
    });
}

// Worker Threads 处理逻辑
if (!isMainThread) {
    // Worker 线程代码
    const { exec } = require('child_process');
    const { workerData, parentPort } = require('worker_threads');

    if (workerData.action === 'checkProcess') {
        // 检查进程是否存在
        const checkProcess = () => {
            const pid = workerData.pid;
            try {
                if (process.platform === 'win32') {
                    exec(`tasklist /FI "PID eq ${pid}"`, (err, stdout) => {
                        const exists = !err && stdout.toLowerCase().includes(` ${pid} `);
                        parentPort.postMessage({ status: exists });
                    });
                } else {
                    try {
                        process.kill(pid, 0);
                        parentPort.postMessage({ status: true });
                    } catch (e) {
                        parentPort.postMessage({ status: false });
                    }
                }
            } catch (error) {
                parentPort.postMessage({ status: false });
            }
        };

        checkProcess();
    } else {
        // 清理端口占用的进程
        const cleanupPort = () => {
            const port = workerData.port;

            // 使用wmic命令获取端口占用的PID
            exec(`wmic process where "CommandLine like '%:${port}%'" get ProcessId 2>nul`, (err, stdout) => {
                if (!err && stdout && stdout.includes('ProcessId')) {
                    // 解析PID并去重
                    const pidMatches = stdout.match(/\d+/g) || [];
                    const pidList = [...new Set(pidMatches)].filter(pid => pid && pid !== '0');

                    if (pidList.length === 0) {
                        parentPort.postMessage(`端口${port}未被占用，无需终止额外进程`);
                        return;
                    }

                    let killedCount = 0;

                    // 逐个终止PID
                    pidList.forEach(pid => {
                        // 使用wmic terminate终止进程
                        exec(`wmic process where ProcessId=${pid} call terminate`, (wmicErr, wmicOut) => {
                            if (!wmicErr && wmicOut && wmicOut.toLowerCase().includes('terminate')) {
                                killedCount++;
                            }

                            if (killedCount === pidList.length) {
                                parentPort.postMessage(`成功终止端口${port}上的${killedCount}个进程`);
                            }
                        });
                    });
                } else {
                    // 回退到netstat方法
                    exec(`netstat -ano | findstr :${port}`, (err2, stdout2) => {
                        if (!err2 && stdout2) {
                            // 解析PID并去重
                            const lines = stdout2.trim().split('\r\n');
                            const pidList = [...new Set(lines.map(line => {
                                const parts = line.trim().split(/\s+/);
                                return parts.length > 4 ? parts[4] : null;
                            }).filter(pid => pid && pid !== '0'))];

                            let killedCount = 0;

                            pidList.forEach(pid => {
                                // 使用taskkill终止进程
                                exec(`taskkill /F /PID ${pid}`, (killErr) => {
                                    if (!killErr) {
                                        killedCount++;
                                    }

                                    if (killedCount === pidList.length) {
                                        parentPort.postMessage(`成功终止端口${port}上的${killedCount}个进程`);
                                    }
                                });
                            });
                        } else {
                            parentPort.postMessage(`未检测到端口${port}占用或检测失败`);
                        }
                    });
                }
            });
        };

        cleanupPort();
    }
}

// 启动ComfyUI的主函数
async function startComfyUI(os, userDataPath, configFileName, startFileName) {
    try {
        // 生成ComfyUI启动文件
        sendLog('🔧 生成ComfyUI启动文件...', 'info');
        const { startPath } = generateStartFile(userDataPath, configFileName, startFileName);
        sendLog(`✅ ComfyUI启动文件已生成：${startPath}`, 'success');
    } catch (error) {
        sendLog(`⚠️ 生成启动文件失败，但将继续尝试启动ComfyUI：${error.message}`, 'warning');
    }
    
    return await performStartComfyUI(userDataPath, configFileName, startFileName);
}

// 导出模块
module.exports = {
    setMainWindow,
    setConfig,
    setSendLogFn,
    setInternalRefs,
    startPerformanceMonitoring,
    stopPerformanceMonitoring,
    checkPortAvailable,
    killPortProcesses,
    killPortProcessesWithWorker,
    checkProcessStatusWithWorker,
    killComfyUIProcesses,
    startComfyUI,
    performStartComfyUI,
    checkProcessStatus,
    validateCustomCmd,
    generateStartFile,
    loadComfyUIInWindow
};