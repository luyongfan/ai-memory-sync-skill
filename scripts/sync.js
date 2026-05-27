#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * AI Memory Sync - 通用 AI 助手记忆同步工具（Node.js 版）
 * 支持任意 AI 助手（WorkBuddy/QClaw/Claude/ChatGPT 等）之间的记忆同步
 * v3.1.8 - 身份缓存+自动更新: 平台目录.ai-identity(不互相覆盖),启动自动git pull,技能失败不设exit 1
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

// ============ 配置路径（v3.1: 每人独立目录，避免互相覆盖）============
/**
 * 获取当前 AI 的配置目录
 * 规则: ~/.ai-memory-sync-{ai_name}/
 * 自动处理从旧共享目录 (~/.ai-memory-sync/) 的迁移
 */
// 防止循环递归的标志位（首次 init 时 config 不存在，需要阻断 getConfigDir → loadConfigRaw 循环）
let _configDirOverride = null;

/** 设置配置目录覆盖（由 cmdInit 在识别身份后调用，避免循环依赖） */
function setConfigDirOverride(dir) { _configDirOverride = dir; }

function getConfigDir() {
  // 1. 优先使用覆盖值（init 过程中由 cmdInit 设置，阻断循环）
  if (_configDirOverride) return _configDirOverride;

  const home = os.homedir();
  const cwd = process.cwd();

  // 1.5. v3.1.8: 从平台目录的身份缓存读取（不受 cwd 深度影响）
  //     sync/init 写入各自平台目录（如 ~/.qclaw/.ai-identity），不会互相覆盖
  //     每个平台目录只属于一个AI，所以缓存是唯一的
  const rel = path.relative(home, cwd);
  const firstPart = rel.split(path.sep)[0];
  if (firstPart && firstPart.startsWith('.')) {
    const platformHome = path.join(home, firstPart);
    try {
      const identityFile = path.join(platformHome, '.ai-identity');
      if (fs.existsSync(identityFile)) {
        const identity = fs.readFileSync(identityFile, 'utf-8').trim();
        if (identity) {
          const candidateDir = path.join(home, '.ai-memory-sync-' + identity.toLowerCase());
          if (fs.existsSync(path.join(candidateDir, 'sync-config.json'))) {
            return candidateDir;
          }
        }
      }
    } catch (_) {}
  }

  // 2. 尝试从已有配置文件读取 ai_name（直接读固定路径候选列表，不调 getConfigFile）
  //    v3.1.7: 多配置共存时按精确度分级选择
  const candidates = fs.readdirSync(home)
    .filter(d => d.startsWith('.ai-memory-sync-') && d !== '.ai-memory-sync-skill')
    .map(d => path.join(home, d, 'sync-config.json'))
    .filter(f => fs.existsSync(f));

  // 2a. 最精确：cwd 路径包含 ai_name（如 .qclaw/ 包含 "qclaw"，.toclaw/ 包含 "toclaw"）
  //     多AI共享同一workspace时，只有正确的ai_name会被cwd路径匹配到
  for (const cf of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cf, 'utf-8'));
      if (cfg && cfg.ai_name && cwd.toLowerCase().includes(cfg.ai_name.toLowerCase())) {
        return path.join(home, '.ai-memory-sync-' + cfg.ai_name.toLowerCase());
      }
    } catch (_) {}
  }

  // 2b. 次选：workspace_dir 包含 cwd（多个AI共享workspace时可能匹配多个，优先级低）
  for (const cf of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cf, 'utf-8'));
      if (cfg && cfg.ai_name && cfg.workspace_dir && cwd.toLowerCase().startsWith(cfg.workspace_dir.toLowerCase())) {
        return path.join(home, '.ai-memory-sync-' + cfg.ai_name.toLowerCase());
      }
    } catch (_) {}
  }

  // 2c. 兜底：用第一个找到的配置（只有一个配置时不会出错）
  for (const cf of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cf, 'utf-8'));
      if (cfg && cfg.ai_name) {
        return path.join(home, '.ai-memory-sync-' + cfg.ai_name.toLowerCase());
      }
    } catch (_) {}
  }

  // 3. 兜底：从 cwd 推断（仅用于已有 AI home 目录的机器）
  const ws = process.cwd();
  const detected = detectAgentNameFromPathStrict(ws);
  if (detected !== 'unknown') {
    return path.join(home, '.ai-memory-sync-' + detected.toLowerCase());
  }

  // 4. 最终兜底：使用旧共享目录（兼容未迁移的旧配置）
  return path.join(home, '.ai-memory-sync');
}

/**
 * 严格模式：仅从明确的 AI home 目录路径推断身份
 * 不会沿路径向上搜索 IDENTITY.md，避免检测到其他 AI 的文件
 */
function detectAgentNameFromPathStrict(ws) {
  // 仅匹配明确的 AI home 目录特征
  if (ws.includes('WorkBuddy') || ws.includes('.workbuddy')) return 'workbuddy';
  if (ws.includes('.qclaw') || ws.includes('QClaw')) return 'qclaw';
  if (ws.includes('.openclaw')) return 'openclaw';
  if (ws.includes('.claude')) return 'claude';
  return 'unknown';
}

/** 从 IDENTITY.md 读取真实名字，优先级高于路径推断（用于 doInit 身份解析） */
function detectAgentName(workspaceDir) {
  const candidates = [
    path.join(workspaceDir, 'IDENTITY.md'),
    path.join(workspaceDir, '.openclaw', 'IDENTITY.md'),
    path.join(workspaceDir, '.qclaw', 'IDENTITY.md'),
    path.join(workspaceDir, '.workbuddy', 'IDENTITY.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
      const m = content.match(/^-\s*[Nn]ame:\s*(.+)$/m);
      if (m) return m[1].trim();
    }
  }
  return null;
}
function getConfigFile() { return path.join(getConfigDir(), 'sync-config.json'); }
function getLockFile()   { return path.join(getConfigDir(), 'sync.lock'); }
function getTokenFile()  { return path.join(getConfigDir(), '.token'); }
function getPasswordFile() { return path.join(getConfigDir(), '.password'); }
function getGitCredFile()  { return path.join(getConfigDir(), '.git-credentials'); }

// 迁移旧共享配置（一次性）
function migrateSharedConfig() {
  const oldDir = path.join(os.homedir(), '.ai-memory-sync');
  const newDir = getConfigDir();
  if (oldDir === newDir) return; // 已经是独立目录

  const oldConfig = path.join(oldDir, 'sync-config.json');
  if (fs.existsSync(oldConfig) && !fs.existsSync(getConfigFile())) {
    try {
      fs.mkdirSync(newDir, { recursive: true });
      const data = fs.readFileSync(oldConfig, 'utf8');
      fs.writeFileSync(getConfigFile(), data, 'utf8');
      // 迁移 token
      ['.token', '.password', '.git-credentials', 'sync.lock'].forEach(f => {
        if (fs.existsSync(path.join(oldDir, f))) {
          fs.copyFileSync(path.join(oldDir, f), path.join(newDir, f));
        }
      });
      log('已迁移配置到独立目录: ' + newDir);
    } catch(e) { log('配置迁移失败: ' + e.message, 'WARN'); }
  }
}

// ============ 仓库配置 ============
const REPOS = {
  memory: { name: 'toclaw-memory', url: 'https://github.com/luyongfan/toclaw-memory.git', branch: 'main' },
  skill:  { name: 'ai-skills',      url: 'https://github.com/luyongfan/ai-skills.git',      branch: 'main' },
  sync:   { name: 'ai-memory-sync-skill', url: 'https://github.com/luyongfan/ai-memory-sync-skill.git', branch: 'main' },
};

// ============ 技能目录默认值 ============
/** 自动检测实际存在的技能目录，按优先级返回 */
function detectDefaultSkillDirs() {
  const candidates = [
    path.join(os.homedir(), '.workbuddy', 'skills'),
    path.join(os.homedir(), '.qclaw', 'skills'),
    path.join(os.homedir(), '.qclaw', 'workspace', 'skills'),
    path.join(os.homedir(), '.openclaw', 'skills'),
    path.join(os.homedir(), '.toclaw', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.config', 'ai-skills'),
  ];
  const found = candidates.filter(d => fs.existsSync(d));
  // 如果一个都没有，返回第一个候选目录作为默认（会在需要时创建）
  return found.length > 0 ? found : [candidates[0]];
}
const DEFAULT_SKILL_DIRS = detectDefaultSkillDirs();
const DEFAULT_SKILL_REPO_DIR = path.join(os.homedir(), 'Documents', 'GitHub', 'ai-skills');

/** 从配置读取技能目录列表（支持多平台自定义） */
function getSkillDirs() {
  const cfg = loadConfigRaw();
  return cfg.skill_dirs && cfg.skill_dirs.length > 0 ? cfg.skill_dirs : DEFAULT_SKILL_DIRS;
}

/** 从配置读取技能仓库本地路径 */
function getSkillRepoDir() {
  const cfg = loadConfigRaw();
  return cfg.skill_repo_local_dir || DEFAULT_SKILL_REPO_DIR;
}

// ============ 工具函数 ============

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  console.log(`[${ts}] [${level}] ${msg}`);
}

function loadConfig() {
  migrateSharedConfig();
  const CF = getConfigFile();
  if (!fs.existsSync(CF)) {
    log('配置文件不存在，请先运行 sync init', 'ERROR');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CF, 'utf-8'));
}

function saveConfig(config) {
  const CD = getConfigDir();
  fs.mkdirSync(CD, { recursive: true });
  const CF = getConfigFile();
  fs.writeFileSync(CF, JSON.stringify(config, null, 2), 'utf-8');
  try { fs.chmodSync(CF, 0o600); } catch (_) {}
  log(`配置已保存: ${CF}`);
}

/** 从文件安全读取 token（不存明文到配置） */
function getToken() {
  migrateSharedConfig();
  const config = loadConfigRaw();
  const TF = config.token_file ? path.resolve(config.token_file) : getTokenFile();
  if (!fs.existsSync(TF)) {
    log('token 文件不存在: ' + TF, 'ERROR');
    process.exit(1);
  }
  return fs.readFileSync(TF, 'utf-8').trim();
}

/** 加载配置但不 exit（内部用） */
function loadConfigRaw() {
  const CF = getConfigFile();
  if (!fs.existsSync(CF)) return {};
  return JSON.parse(fs.readFileSync(CF, 'utf-8'));
}

function getCurrentBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim();
  } catch (_) {
    return 'main'; // fallback
  }
}

function runGit(args, options = {}) {
  const cmd = ['git', ...args.map(a => a.includes(' ') ? '"' + a + '"' : a)].join(' ');
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      stdio: options.quiet ? 'pipe' : (options.capture ? 'pipe' : 'inherit'),
      timeout: options.timeout || 150000,  // 国内访问 GitHub 需更长连接时间
    });
    return options.capture || options.quiet ? result.trim() : true;
  } catch (e) {
    if (options.allowFail) return null;
    throw e;
  }
}

function checkLock() {
  migrateSharedConfig();
  const LF = getLockFile();
  if (!fs.existsSync(LF)) return true;
  try {
    const lockData = JSON.parse(fs.readFileSync(LF, 'utf-8'));
    const startTime = new Date(lockData.start_time);
    const elapsed = (Date.now() - startTime.getTime()) / 1000;
    if (lockData.pid) {
      try {
        if (process.platform === 'win32') {
          const out = execSync(`tasklist /FI "PID eq ${lockData.pid}" /NH`, { encoding: 'utf8', timeout: 3000 });
          if (!out.includes(lockData.pid.toString())) {
            log(`锁持有进程 (PID ${lockData.pid}) 已退出，清理残留锁`, 'WARN');
            fs.unlinkSync(LF); return true;
          }
        } else {
          process.kill(lockData.pid, 0);
        }
      } catch (_) {
        log(`锁持有进程 (PID ${lockData.pid}) 已退出，清理残留锁`, 'WARN');
        fs.unlinkSync(LF); return true;
      }
    }
    if (lockData.pid === process.pid) return true;
    if (elapsed < 600) { log(`检测到其他 AI 正在同步: ${lockData.ai_name}`, 'WARN'); return false; }
    log(`锁文件超时（${Math.round(elapsed)}s），强制删除`, 'WARN');
    fs.unlinkSync(LF);
    return true;
  } catch (_) {
    try { fs.unlinkSync(LF); } catch (_) {}
    return true;
  }
}

function createLock(aiName) {
  migrateSharedConfig();
  const CD = getConfigDir(); const LF = getLockFile();
  fs.mkdirSync(CD, { recursive: true });
  const lockData = { ai_name: aiName, pid: process.pid, start_time: new Date().toISOString() };
  fs.writeFileSync(LF, JSON.stringify(lockData, null, 2), 'utf-8');
  try { fs.chmodSync(LF, 0o600); } catch (_) {}
}

function removeLock() {
  migrateSharedConfig();
  try { fs.unlinkSync(getLockFile()); } catch (_) {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ============ v3.0 新增：Agent 目录工具 ============

/** 获取当前 AI 的 agents 目录名（小写） */
function getAgentName() {
  const config = loadConfig();
  return (config.ai_name || 'unknown').toLowerCase();
}

/** 获取当前 AI 在仓库中的 agents 目录路径 */
function getAgentDir(repoRoot) {
  return path.join(repoRoot, 'agents', getAgentName());
}

/** 获取 profile.json 路径 */
function getProfilePath(repoRoot) {
  return path.join(getAgentDir(repoRoot), 'profile.json');
}

/** 加载 profile.json（不存在则返回 null） */
function loadProfile(repoRoot) {
  const p = getProfilePath(repoRoot);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}

/** 保存 profile.json */
function saveProfile(repoRoot, profile) {
  const dir = getAgentDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getProfilePath(repoRoot), JSON.stringify(profile, null, 2), 'utf-8');
  log('profile.json 已保存: ' + getProfilePath(repoRoot));
}

/** 加载 agents.json（仓库根目录） */
function loadAgentsJson(repoRoot) {
  const p = path.join(repoRoot, 'agents.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // 兼容两种格式：v3.0 (agents 数组) 和 Phase D 迁移格式 (_meta + agents)
    if (data.agents && Array.isArray(data.agents)) return data;
    // Phase D 迁移格式：尝试从 rules 或 _meta 提取
    if (data._meta || data.rules) {
      // 返回兼容结构
      return {
        version: data.$schema_version || '1.0',
        lastUpdated: data._meta ? data._meta.last_fused || new Date().toISOString() : new Date().toISOString(),
        agents: [], // Phase D 格式不包含 agents 数组，由主AI维护
        _raw: data
      };
    }
    return data;
  } catch (_) { return null; }
}

// ============ v3.0 新增：YAML Front Matter ============

/** 检测文件是否已有 YAML front matter */
function hasFrontMatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.startsWith('---');
  } catch (_) { return false; }
}

/** 从文件名提取日期（YYYY-MM-DD） */
function extractDateFromFileName(fileName) {
  const match = fileName.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date().toISOString().slice(0, 10);
}

/** 从文件内容推断 type */
function inferTypeFromContent(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').slice(0, 5).join('\n').toLowerCase();
    if (lines.includes('项目') || lines.includes('project')) return 'project';
    if (lines.includes('决策') || lines.includes('decision')) return 'decision';
    if (lines.includes('错误') || lines.includes('bug') || lines.includes('fix')) return 'error';
    if (lines.includes('用户需求') || lines.includes('需求')) return 'requirement';
    return 'daily';
  } catch (_) { return 'daily'; }
}

/** 注入 YAML front matter 到文件 */
function injectFrontMatter(filePath, { author, date, type, tags }) {
  let content = fs.readFileSync(filePath, 'utf-8');
  // 移除已有的 front matter（如果有）
  if (content.startsWith('---\n')) {
    const endIdx = content.indexOf('---\n', 4);
    if (endIdx !== -1) content = content.slice(endIdx + 4).replace(/^\n+/, '');
  }
  const header = `---
author: ${author}
date: ${date}
type: ${type || 'daily'}${tags && tags.length ? '\ntags: [' + tags.join(', ') + ']' : ''}
---
`;
  fs.writeFileSync(filePath, header + content, 'utf-8');
}

/** 检查日志是否遵循详细度规范 v2（六要素：时间戳/用户原话/执行过程/反馈/决策/待办） */
function checkLogDetail(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8').toLowerCase();
    let score = 0;
    if (/\[\d{1,2}:\d{2}\]/.test(content)) score++;       // 时间戳
    if (/^>\s/.test(content) || content.includes('> ')) score++;  // 用户原话（引用块）
    if (content.includes('### ') || content.includes('## ')) score++;  // 结构化标题
    if (/决策|decision|决定/.test(content)) score++;
    if (/待办|遗留|todo|next/.test(content)) score++;
    return { score, max: 5, valid: score >= 3 };  // 至少3个要素算合格
  } catch (_) { return { score: 0, max: 5, valid: false }; }
}

// ============ 场景1：新 AI 登陆流程 ============

// ============ v3.1: Agent 身份自我发现 ============

/**
 * 从 IDENTITY.md 自动读取 agent 的真实名称
 * 优先级：IDENTITY.md > agents.json > null
 */
function detectAgentName(workspaceDir) {
  // 常见位置（不同平台）
  const candidates = [
    path.join(workspaceDir, 'IDENTITY.md'),
    path.join(workspaceDir, '.openclaw', 'IDENTITY.md'),
    path.join(workspaceDir, '.qclaw', 'IDENTITY.md'),
    path.join(workspaceDir, '.workbuddy', 'IDENTITY.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
      // 匹配 "- Name: xxx" 或 "name: xxx" 格式
      const m = content.match(/^[\s-]*[Nn]ame:\s*(.+)$/m);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/**
 * 解决 agent 身份冲突：
 * - 用户输入名字 vs IDENTITY.md 名字 vs agents.json 已有名字
 * - 优先级：IDENTITY.md（最权威） > agents.json（已有注册） > 用户输入
 * - 如果用户输入和已有 agent 不匹配 → 警告并使用最权威来源
 *
 * @param {string} userInputName 用户 --name 参数
 * @param {string} workspaceDir 初始工作区目录（可能是 cwd，不一定包含 IDENTITY.md）
 */
function resolveAgentIdentity(userInputName, workspaceDir) {
  // 搜索范围：workspaceDir 本身 + 所有已知 AI home 目录
  const allSearchDirs = [
    workspaceDir,
    path.join(os.homedir(), '.workbuddy'),
    path.join(os.homedir(), '.qclaw'),
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), '.claude'),
  ];

  // 去重
  const uniqueDirs = [...new Set(allSearchDirs.filter(d => fs.existsSync(d)))];

  // 如果用户提供了 --name，优先在匹配该名称的目录中搜索 IDENTITY.md
  // 避免在同一台机器上找到其他 AI 的 IDENTITY.md
  let detected = null;
  if (userInputName) {
    const inputLower = userInputName.toLowerCase();
    // 优先搜索目录名包含用户输入名称的目录
    const priorityDirs = uniqueDirs.filter(d => d.toLowerCase().includes(inputLower));
    const otherDirs = uniqueDirs.filter(d => !d.toLowerCase().includes(inputLower));

    for (const dir of [...priorityDirs, ...otherDirs]) {
      const name = detectAgentName(dir);
      if (name) {
        // 验证检测到的名字跟用户输入匹配（忽略大小写）
        if (name.toLowerCase() === inputLower) {
          detected = name;
          break;
        }
        // 目录名匹配但 IDENTITY.md 中的名字不同 → 记录但不采用
      }
    }
  } else {
    // 没有 --name 参数时，按原始顺序搜索
    for (const dir of uniqueDirs) {
      detected = detectAgentName(dir);
      if (detected) break;
    }
  }

  // 对于 agents.json，也尝试从 workspaceDir 或 home 下已知的仓库位置加载
  let agentsJson = null;
  const repoCandidates = [
    workspaceDir,
    path.join(os.homedir(), '.qclaw', 'workspace'),
    path.join(os.homedir(), '.workbuddy', 'workspace'),
  ];
  for (const rc of repoCandidates) {
    agentsJson = loadAgentsJson(rc);
    if (agentsJson) break;
  }

  const existingNames = agentsJson && agentsJson.agents
    ? agentsJson.agents.map(a => a.name)
    : [];

  // 情况1：IDENTITY.md 存在，且和用户输入不同 → 以 IDENTITY.md 为准
  if (detected && userInputName && detected.toLowerCase() !== userInputName.toLowerCase()) {
    if (existingNames.includes(detected)) {
      // IDENTITY.md 名字在 agents.json 已有 → 警告后使用已有身份
      log('[WARN] 用户输入 "' + userInputName + '" 与 agent 真实身份 "' + detected + '" 不符', 'WARN');
      log('[WARN] agents.json 已存在 "' + detected + '"，将复用已有身份，跳过新建', 'WARN');
      return { resolved: detected, source: 'identity_file', conflict: true };
    } else {
      // IDENTITY.md 有名字，但 agents.json 没有 → 以 IDENTITY.md 为准
      log('[INFO] 自动识别 agent 名称: "' + detected + '"（来自 IDENTITY.md）');
      return { resolved: detected, source: 'identity_file', conflict: false };
    }
  }

  // 情况2：用户输入名字在 agents.json 已存在 → 复用已有
  if (userInputName && existingNames.includes(userInputName)) {
    log('[INFO] 使用已有 agent 身份: "' + userInputName + '"（来自 agents.json）');
    return { resolved: userInputName, source: 'agents_json', conflict: false };
  }

  // 情况3：用户输入名字在 agents.json 不存在，且 IDENTITY.md 没有 → 以用户输入为准
  if (userInputName) {
    return { resolved: userInputName, source: 'user_input', conflict: false };
  }

  // 情况4：完全没有名字 → 报错
  log('[ERROR] 无法确定 agent 名称：IDENTITY.md 不存在，且未提供 --name 参数', 'ERROR');
  log('[HINT] 请确保 workspace 中有 IDENTITY.md 文件，或在 init 时传入 --name 参数', 'ERROR');
  return { resolved: null, source: null, conflict: false };
}

function cmdInit() {
  // 解析命令行参数（支持非交互模式）
  const args = process.argv.slice(3);
  const params = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '';
      if (val) { params[key] = val; i++; }
      else { params[key] = true; }
    }
  }

  // --token-file: 从文件读取 token（安全方式，避免明文暴露在消息中）
  if (params['token-file']) {
    const tokenPath = path.resolve(params['token-file']);
    if (fs.existsSync(tokenPath)) {
      params.token = fs.readFileSync(tokenPath, 'utf-8').trim();
      log('已从文件读取 token: ' + tokenPath);
    } else {
      log('token 文件不存在: ' + tokenPath, 'ERROR');
      process.exit(1);
    }
  }

  // --password-file: 从文件读取密码（同上，避免明文暴露）
  if (params['password-file']) {
    const pwPath = path.resolve(params['password-file']);
    if (fs.existsSync(pwPath)) {
      params.password = fs.readFileSync(pwPath, 'utf-8').trim();
      log('已从文件读取密码: ' + pwPath);
    } else {
      log('密码文件不存在: ' + pwPath, 'ERROR');
      process.exit(1);
    }
  }

  const nonInteractive = params.url || params.token || params.password || params.name;

  if (nonInteractive) {
    // 非交互模式：AI 自动调用
    const repoUrl = params.url || REPOS.memory.url;
    const token = params.token || '';
    const password = params.password || '';
    const workspaceDir = params.workspace || process.cwd();

    // v3.1: 智能解析 agent 身份（自我发现 + 冲突解决）
    const identity = resolveAgentIdentity(params.name, workspaceDir);
    if (!identity.resolved) {
      // 没有名字且无法自动检测
      if (!params.token && !params['token-file']) {
        log('非交互模式缺少必要参数: --token/--token-file', 'ERROR');
        process.exit(1);
      }
      if (!params.password && !params['password-file']) {
        log('非交互模式缺少必要参数: --password/--password-file', 'ERROR');
        process.exit(1);
      }
      process.exit(1);
    }
    const aiName = identity.resolved;

    // 立即设置配置目录覆盖，阻断后续 getConfigDir() 的循环调用
    const resolvedConfigDir = path.join(os.homedir(), '.ai-memory-sync-' + aiName.toLowerCase());
    setConfigDirOverride(resolvedConfigDir);

    if (!token || !password) {
      log('非交互模式缺少必要参数: --token/--token-file, --password/--password-file', 'ERROR');
      process.exit(1);
    }

    doInit(repoUrl, token, password, aiName, workspaceDir);
  } else {
    // 交互模式：人类用户手动配置
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

    (async () => {
      console.log('=== AI 记忆同步初始化 ===\n');
      const repoUrl = (await question('Git 仓库 URL（留空使用默认 toclaw-memory）: ')).trim() || REPOS.memory.url;
      const token = (await question('GitHub Personal Access Token: ')).trim();
      const password = (await question('同步密码: ')).trim();
      const workspaceDir = (await question('工作区目录（默认当前目录）: ')).trim() || process.cwd();
      const rawName = (await question('AI 助手标识名（留空自动从 IDENTITY.md 读取）: ')).trim();
      rl.close();

      // v3.1: 智能解析 agent 身份
      const identity = resolveAgentIdentity(rawName, workspaceDir);
      if (!identity.resolved) {
        log('无法确定 agent 名称，请检查 IDENTITY.md 是否存在或手动输入', 'ERROR');
        process.exit(1);
      }
      const aiName = identity.resolved;

      // 立即设置配置目录覆盖，阻断后续 getConfigDir() 的循环调用
      const resolvedConfigDir = path.join(os.homedir(), '.ai-memory-sync-' + aiName.toLowerCase());
      setConfigDirOverride(resolvedConfigDir);

      if (!token || !password) {
        log('Token、密码必须填写', 'ERROR');
        process.exit(1);
      }

      doInit(repoUrl, token, password, aiName, workspaceDir);
    })();
  }
}


// ============ P0: .gitignore 智能过滤 ============

const GITIGNORE_MEMORY = [
  '# AI Memory Sync - 自动生成',
  '.clawhub/',
  'skills/',
  '*.tmp',
  '*.bak',
  '.cache/',
  '__pycache__/',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'sync.lock',
  '',
].join('\n');

const GITIGNORE_SKILL = [
  '# AI Skills Repo - 自动生成',
  'node_modules/',
  '*.safetensors',
  '*.bin',
  '*.onnx',
  '*.pt',
  '*.pth',
  '*.h5',
  '*.pkl',
  '*.gguf',
  '__pycache__/',
  '.cache/',
  '*.tmp',
  '*.bak',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '',
].join('\n');

function ensureGitignore(repoDir, content) {
  const giPath = path.join(repoDir, '.gitignore');
  if (fs.existsSync(giPath)) {
    const existing = fs.readFileSync(giPath, 'utf-8');
    // 合并：已有行保留，新行追加
    const existingLines = new Set(existing.split(/\r?\n/));
    const newLines = content.split(/\r?\n/).filter(l => !existingLines.has(l));
    if (newLines.length > 0) {
      fs.writeFileSync(giPath, existing.trimEnd() + '\n' + newLines.join('\n') + '\n', 'utf-8');
      log('  .gitignore 已更新（追加 ' + newLines.length + ' 行）');
    }
  } else {
    fs.writeFileSync(giPath, content, 'utf-8');
    log('  .gitignore 已生成');
  }
}
function doInit(repoUrl, token, password, aiName, workspaceDir) {
  // 智能修正 workspaceDir：如果 cwd 是 skill 仓库、平台工作目录或其他无关目录，
  // 根据 aiName 自动查找正确的 workspace 目录
  // v3.1.4: 不仅检查路径是否包含 aiName，还要验证路径是否是有效的 git 仓库
  // 必须有 .git 目录才认为是仓库（光有 agents/ 不够，可能是上次 init 残留）
  const pathHasAgentName = detectAgentNameFromPathStrict(workspaceDir).includes(aiName.toLowerCase());
  const pathIsValidRepo = fs.existsSync(path.join(workspaceDir, '.git'));
  if (!pathHasAgentName || !pathIsValidRepo) {
    const knownWorkspaces = [
      // WorkBuddy 的常见 workspace 路径
      path.join(os.homedir(), '.workbuddy', 'workspace'),
      path.join(os.homedir(), '.qclaw', 'workspace'),
      // 也搜索 home 下的其他位置
      path.join(os.homedir(), 'Documents', 'GitHub', 'toclaw-memory'),
    ];
    for (const ws of knownWorkspaces) {
      if (fs.existsSync(ws) && fs.existsSync(path.join(ws, 'agents'))) {
        log('检测到已有仓库: ' + ws + '（自动替代 cwd）');
        workspaceDir = ws;
        break;
      }
    }
  }

  // 确保配置目录存在（首次 init 时目录可能还不存在）
  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });

  // 保存 token 到文件（不明文存入配置）
  fs.writeFileSync(getTokenFile(), token, 'utf-8');
  try { fs.chmodSync(getTokenFile(), 0o600); } catch (_) {}
  log('token 已保存到: ' + getTokenFile());

  // 保存同步密码到文件
  fs.writeFileSync(getPasswordFile(), password, 'utf-8');
  try { fs.chmodSync(getPasswordFile(), 0o600); } catch (_) {}

  // v3.0: 检测平台（v3.1.3: 优先用已知 aiName 推断，避免多平台共存时误判）
  const platform = aiName === 'workbuddy' ? 'workbuddy' : detectPlatform();

  // v3.0: 检测本地文件路径
  const detectedPaths = detectLocalPaths(workspaceDir, platform);

  // 保存配置（token 只存路径引用，不存明文）
  const detectedSkillDirs = detectDefaultSkillDirs();
  saveConfig({
    repo_url: repoUrl,
    memory_repo_url: REPOS.memory.url,
    skill_repo_url: REPOS.skill.url,
    sync_repo_url: REPOS.sync.url,
    token_file: getTokenFile(),
    skill_repo_local_dir: DEFAULT_SKILL_REPO_DIR,
    skill_dirs: detectedSkillDirs,
    ai_name: aiName,
    workspace_dir: workspaceDir,
    platform: platform,
    auto_sync: false,
    created_at: new Date().toISOString()
  });

  // 配置隔离的 Git 凭证
  const credLine = 'https://luyongfan:' + token + '@github.com\n';
  fs.writeFileSync(getGitCredFile(), credLine, 'utf-8');
  try { fs.chmodSync(getGitCredFile(), 0o600); } catch (_) {}
  log('Git 凭证已隔离到: ' + getGitCredFile());

  // Git 全局配置
  try {
    execSync('git config --global user.name "AI Memory Sync"', { stdio: 'pipe' });
    execSync('git config --global user.email "ai-sync@local"', { stdio: 'pipe' });
  } catch (_) {}

  // 验证令牌
  try {
    const resp = execSync('curl -s -H "Authorization: token ' + token + '" https://api.github.com/user', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const user = JSON.parse(resp);
    log('令牌验证成功: 用户=' + (user.login || '未知'));
  } catch (_) {
    log('令牌验证失败，请检查 ' + getTokenFile() + ' 中的令牌是否正确', 'WARN');
  }

  // 确保 .gitignore 就位
  ensureGitignore(workspaceDir, GITIGNORE_MEMORY);
  const skillRepo = getSkillRepoDir();
  ensureGitignore(skillRepo, GITIGNORE_SKILL);
  const giPath = path.join(skillRepo, '.gitignore');
  if (fs.existsSync(giPath)) {
    const gi = fs.readFileSync(giPath, 'utf-8');
    if (gi.includes('skills/')) {
      const updated = gi.split(/\r?\n/).filter(l => l.trim() !== 'skills/').join('\n');
      fs.writeFileSync(giPath, updated, 'utf-8');
    }
  }

  // 为工作区仓库设置本地 credential helper
  try {
    if (fs.existsSync(workspaceDir)) {
      execSync('git config credential.helper "store --file ' + getGitCredFile().replace(/\\/g, '/') + '"', { cwd: workspaceDir, stdio: 'pipe' });
    }
  } catch (_) {}

  // v3.0: 生成 profile.json（三层结构）
  const agentDir = path.join(workspaceDir, 'agents', aiName);
  fs.mkdirSync(agentDir, { recursive: true });

  const profile = {
    "$schema_version": "1.0",
    "=== 身份 ===": "====",
    "name": aiName,
    "display_name": aiName.charAt(0).toUpperCase() + aiName.slice(1),
    "platform": platform,
    "emoji": getPlatformEmoji(platform),
    "=== 生命周期 ===": "===========",
    "first_seen": new Date().toISOString().slice(0, 10),
    "last_sync": null,
    "status": "active",
    "=== 运行时配置（主AI融合引擎读取）==": "=========================",
    "runtime": {
      "github_base": "agents/" + aiName + "/",
      "soul_files": detectedPaths.soul_files || ["MEMORY.md"],
      "identity_file": detectedPaths.identity_file || null,
      "soul_file": null,
      "user_file": detectedPaths.user_file || null,
      "daily_dir": "daily/",
      "daily_pattern": "YYYY-MM-DD.md",
      "extra_dirs": [],
      "extra_files": [],
      "specialties": [],
      "status": "active",
      "visibility": "private",
      "trust_level": "owner"
    },
    "=== 本地映射（sync.js读取，主AI不关心）==": "=========================",
    "local": {
      "memory_path": detectedPaths.memory_path,
      "daily_path": detectedPaths.daily_path,
      "inject_identity": detectedPaths.inject_identity,
      "inject_user": detectedPaths.inject_user
    },
    "=== 迁移配置（仅迁移时使用，迁移完删除整个节点）==": "=======================================",
    "_migration": {
      "enabled": false,
      "migrated_at": null,
      "verified": false
    }
  };
  saveProfile(workspaceDir, profile);

  log('');
  log('✅ 初始化完成！已生成 profile.json（三层结构）');
  // v3.1.8: 写入身份缓存到平台目录
  try {
    const cwdInit = process.cwd();
    const relInit = path.relative(os.homedir(), cwdInit);
    const platformDirInit = path.join(os.homedir(), relInit.split(path.sep)[0]);
    if (platformDirInit && platformDirInit.includes('.')) {
      fs.writeFileSync(path.join(platformDirInit, '.ai-identity'), aiName.toLowerCase(), 'utf-8');
    }
  } catch (_) {}
  log('');
  log('📄 下一步操作：');
  log('   1. 如果是从 v2.4 升级，运行: node sync.js migrate v3 --execute');
  log('   2. 如果是全新安装，运行: node sync.js push');
  log('   3. 验证配置: node sync.js soul');
  log('');
}

// ============ v3.0 新增：平台检测 ============

/** 自动检测当前平台 */
function detectPlatform() {
  const home = os.homedir();
  const cwd = process.cwd();
  // 策略：按 workspace 路径前缀判断，而非目录存在性
  // 因为 ~/.workbuddy 和 ~/.qclaw 可能同时存在
  if (cwd.includes('.qclaw') || cwd.includes('QClaw')) return 'qclaw';
  if (cwd.includes('.openclaw')) return 'openclaw';
  if (cwd.includes('.workbuddy')) return 'workbuddy';
  if (cwd.includes('.claude')) return 'claude';
  // 兜底：按目录存在性（单一平台机器）
  if (fs.existsSync(path.join(home, '.openclaw'))) return 'openclaw';
  if (fs.existsSync(path.join(home, '.qclaw'))) return 'qclaw';
  if (fs.existsSync(path.join(home, '.workbuddy'))) return 'workbuddy';
  if (fs.existsSync(path.join(home, '.claude'))) return 'claude';
  return 'unknown';
}

/** 获取平台对应的 emoji */
function getPlatformEmoji(platform) {
  const emojis = { workbuddy: '🤖', qclaw: '📱', openclaw: '🌐', toclaw: '🦐', claude: '🧠', unknown: '❓' };
  return emojis[platform] || '❓';
}

/** 自动检测本地文件路径 */
/** v3.1.3: 智能解析源路径（绝对路径直接返回，相对路径拼接 workspaceDir） */
function resolveSrcPath(baseDir, relativeOrAbsolute) {
  if (!relativeOrAbsolute) return null;
  // path.isAbsolute 对 Windows C:\ 和 Linux / 都能正确判断
  if (path.isAbsolute(relativeOrAbsolute)) return relativeOrAbsolute;
  return path.join(baseDir, relativeOrAbsolute);
}

function detectLocalPaths(workspaceDir, platform) {
  const home = os.homedir();
  const result = { soul_files: [], identity_file: null, user_file: null, memory_path: '', daily_path: '', inject_identity: '', inject_user: '' };

  switch (platform) {
    case 'openclaw': {
      result.memory_path = 'MEMORY.md';
      result.daily_path = 'memory/';
      result.soul_files = ['MEMORY.md'];
      if (fs.existsSync(path.join(workspaceDir, 'IDENTITY.md'))) result.identity_file = 'IDENTITY.md';
      if (fs.existsSync(path.join(workspaceDir, 'USER.md'))) result.user_file = 'USER.md';
      break;
    }
    case 'workbuddy': {
      // v3.1.3: WorkBuddy 的数据目录是 ~/.workbuddy/，与仓库目录(workspaceDir)解耦
      // 使用绝对路径，这样即使 workspaceDir 指向共享仓库（如 .qclaw/workspace）也能正确定位
      const wbHome = path.join(home, '.workbuddy');
      const memDir = path.join(wbHome, 'memory');
      result.memory_path = path.join(wbHome, 'memory', 'MEMORY.md');
      result.daily_path = path.join(wbHome, 'memory', '') + path.sep;
      result.inject_identity = path.join(wbHome, 'SOUL.md');
      result.inject_user = path.join(wbHome, 'USER.md');
      result.soul_files = ['MEMORY.md'];
      // 检测是否有 IDENTITY.md / USER.md（在 .workbuddy 根目录下）
      if (fs.existsSync(path.join(wbHome, 'IDENTITY.md'))) result.identity_file = path.join(wbHome, 'IDENTITY.md');
      if (fs.existsSync(path.join(wbHome, 'USER.md'))) result.user_file = path.join(wbHome, 'USER.md');
      break;
    }
    case 'qclaw': {
      result.memory_path = 'MEMORY.md';
      result.daily_path = 'memory/';
      result.soul_files = ['MEMORY.md'];
      if (fs.existsSync(path.join(workspaceDir, 'IDENTITY.md'))) result.identity_file = 'IDENTITY.md';
      if (fs.existsSync(path.join(workspaceDir, 'USER.md'))) result.user_file = 'USER.md';
      break;
    }
    default: {
      result.memory_path = 'MEMORY.md';
      result.daily_path = 'daily/';
      result.soul_files = ['MEMORY.md'];
    }
  }
  return result;
}
/** 检查远程仓库是否有更新（支持 --json 输出） */
function cmdCheck() {
  const config = loadConfig();
  const workspaceDir = config.workspace_dir || process.cwd();
  const jsonMode = process.argv.includes('--json');

  const results = [];

  for (const [key, repo] of Object.entries(REPOS)) {
    const localDir = key === 'memory' ? workspaceDir
      : key === 'skill' ? path.join(os.homedir(), 'Documents', 'GitHub', 'ai-skills')
      : getConfigDir();

    const entry = { repo: repo.name, type: key, status: 'unknown', behind: 0 };

    if (!fs.existsSync(path.join(localDir, '.git'))) {
      entry.status = 'not_cloned';
      results.push(entry);
      if (!jsonMode) console.log('[' + repo.name + '] 本地仓库不存在，需要 clone');
      continue;
    }

    try {
      process.chdir(localDir);
      runGit(['fetch', 'origin', repo.branch], { quiet: true });
      const localHash = runGit(['rev-parse', 'HEAD'], { capture: true });
      const remoteHash = runGit(['rev-parse', 'origin/' + repo.branch], { capture: true });
      if (localHash !== remoteHash) {
        const behind = runGit(['rev-list', '--count', 'HEAD..origin/' + repo.branch], { capture: true });
        entry.status = 'behind';
        entry.behind = parseInt(behind) || 0;
        if (!jsonMode) console.log('[' + repo.name + '] 有 ' + behind + ' 个新提交，需要同步');
      } else {
        entry.status = 'up_to_date';
        if (!jsonMode) console.log('[' + repo.name + '] 已是最新');
      }
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message;
      if (!jsonMode) console.log('[' + repo.name + '] 检查失败: ' + e.message);
    }
    results.push(entry);
  }

  if (jsonMode) {
    // 结构化输出供 AI 解析
    console.log(JSON.stringify({ check_time: new Date().toISOString(), repos: results }, null, 2));
  }

  // 返回是否有需要同步的仓库
  return results.some(r => r.status === 'behind' || r.status === 'not_cloned');
}



// ============ v3.0: soul 命令（家族视图 + agents.json） ============

/** v3.0 soul：读 agents.json + profile.json，显示家族状态 */
function cmdSoul() {
  const config = loadConfig();
  const workspaceDir = config.workspace_dir || process.cwd();
  const aiName = config.ai_name;
  const showAll = process.argv.includes('--all');
  const showAgent = (() => { const idx = process.argv.indexOf('--agent'); return idx !== -1 ? process.argv[idx + 1] : null; })();

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       🧠 AI 记忆家族 - 状态报告         ║');
  console.log('╠══════════════════════════════════════════╣');

  // 读取 agents.json
  const agentsJson = loadAgentsJson(workspaceDir);
  const agents = agentsJson && agentsJson.agents ? agentsJson.agents : [];

  // 如果有 --agent 参数，只显示指定 agent
  if (showAgent) {
    const agent = agents.find(a => a.name === showAgent.toLowerCase());
    if (agent) {
      showAgentDetail(agent, workspaceDir);
    } else {
      log('❌ 未找到 agent: ' + showAgent, 'ERROR');
    }
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    return;
  }

  // 显示当前 AI 信息
  const profile = loadProfile(workspaceDir);
  console.log('║  当前 AI: ' + (aiName || '未配置').padEnd(29) + '║');
  console.log('║  平台: ' + ((profile && profile.platform) || '未知').padEnd(33) + '║');
  console.log('║  最后同步: ' + ((profile && profile.last_sync) || '从未').slice(0, 25).padEnd(29) + '║');
  console.log('║                                          ║');

  if (agents.length > 0) {
    console.log('║  📋 已注册 AI 家族成员:                   ║');
    for (const agent of agents) {
      const statusIcon = agent.status === 'active' ? '🟢' : agent.status === 'skeleton' ? '🦴' : '🔴';
      const lastSync = agent.last_sync ? agent.last_sync.slice(0, 10) : '从未';
      const line = '║    ' + statusIcon + ' ' + agent.name + ' (' + (agent.display_name || agent.name) + ', ' + lastSync + ')';
      console.log(line.padEnd(43) + '║');
    }
  } else {
    console.log('║  ⚠️ agents.json 不存在或为空              ║');
  }

  console.log('║                                          ║');

  // 当前 agent 详细状态
  if (profile) {
    // MEMORY.md 检查
    const localMem = path.join(workspaceDir, profile.local.memory_path);
    if (fs.existsSync(localMem)) {
      const stat = fs.statSync(localMem);
      const sizeKB = (stat.size / 1024).toFixed(1);
      const ageDays = ((Date.now() - stat.mtimeMs) / 86400000).toFixed(1);
      console.log('║  📄 本地记忆: ' + sizeKB + 'KB, ' + ageDays + '天前更新'.padEnd(18) + '║');
      if (stat.size > 30 * 1024) {
        console.log('║     ⚠️ 超过30KB，建议精简                  ║');
      }
    }

    // Daily logs
    const localDaily = path.join(workspaceDir, profile.local.daily_path);
    if (fs.existsSync(localDaily)) {
      const dailyFiles = fs.readdirSync(localDaily).filter(f => f.endsWith('.md'));
      console.log('║  📝 本地日志: ' + dailyFiles.length + ' 篇'.padEnd(29) + '║');
    }

    // 融合索引版检查
    const fusedMem = path.join(workspaceDir, 'MEMORY.md');
    if (fs.existsSync(fusedMem)) {
      const fusedStat = fs.statSync(fusedMem);
      console.log('║  🔗 融合索引版: ' + (fusedStat.size / 1024).toFixed(1) + 'KB'.padEnd(27) + '║');
    }
  } else {
    console.log('║  ⚠️ profile.json 不存在，请先运行 init    ║');
  }

  // 技能统计
  const skillDirs = getSkillDirs();
  let skillCount = 0;
  for (const sd of skillDirs) {
    if (fs.existsSync(sd)) skillCount += fs.readdirSync(sd).filter(f => fs.statSync(path.join(sd, f)).isDirectory()).length;
  }
  console.log('║  🛠 已安装技能: ' + skillCount + ''.padEnd(27) + '║');

  console.log('║                                          ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  return { aiName, profile, agents };
}

/** 显示单个 Agent 的详细信息 */
function showAgentDetail(agent, workspaceDir) {
  const agentDir = path.join(workspaceDir, 'agents', agent.name);
  console.log('║                                          ║');
  console.log('║  Agent: ' + agent.name + ' (' + (agent.display_name || agent.name) + ')'.padEnd(21) + '║');
  console.log('║  状态: ' + (agent.status || 'unknown').padEnd(33) + '║');
  console.log('║  平台: ' + (agent.platform || 'unknown').padEnd(33) + '║');
  console.log('║  最后同步: ' + ((agent.last_sync) || '从未').slice(0, 23).padEnd(27) + '║');

  if (fs.existsSync(agentDir)) {
    // 读 profile.json
    const profilePath = path.join(agentDir, 'profile.json');
    if (fs.existsSync(profilePath)) {
      const prof = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
      if (prof.runtime && prof.runtime.specialties) {
        console.log('║  专长: ' + prof.runtime.specialties.join(', ').slice(0, 30).padEnd(28) + '║');
      }
    }

    // 列出文件
    const files = listFilesRecursive(agentDir);
    console.log('║  文件: ' + files.length + ' 个'.padEnd(33) + '║');
    for (const f of files.slice(0, 5)) {
      const relPath = path.relative(agentDir, f);
      console.log('║    📄 ' + relPath.slice(0, 33).padEnd(35) + '║');
    }
    if (files.length > 5) console.log('║    ... 还有 ' + (files.length - 5) + ' 个文件'.padEnd(29) + '║');
  } else {
    console.log('║  ⚠️ 本地目录不存在                        ║');
  }
}

/** 递归列出所有文件 */
function listFilesRecursive(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listFilesRecursive(fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch (_) {}
  return results;
}
// ============ 场景2：自动技能加载 ============

/** 从 Git 加载指定技能 */
function cmdSkillLoad(skillName) {
  if (!skillName) { log('请指定技能名称: node sync.js skill load <名称>', 'ERROR'); process.exit(1); }

  const skillDirs = getSkillDirs();
  const targetDir = path.join(skillDirs[0], skillName);

  // 已安装则直接返回
  if (fs.existsSync(targetDir)) {
    log(`技能 "${skillName}" 已安装，检查完整性...`);
    cmdSkillCheck(skillName);
    return;
  }

  // 尝试从 ai-skills 仓库安装
  log(`从技能仓库加载 "${skillName}"...`);
  const skillRepoDir = getSkillRepoDir();
  const skillRepoPath = path.join(skillRepoDir, 'skills', skillName);

  if (fs.existsSync(skillRepoPath)) {
    fs.mkdirSync(skillDirs[0], { recursive: true });
    copyDirRecursive(skillRepoPath, targetDir);
    log(`✅ 技能 "${skillName}" 加载成功！`);
    cmdSkillCheck(skillName);
  } else {
    // 尝试从可选的技能包管理器安装（ClawHub 等）
    log(`本地仓库未找到 "${skillName}"，尝试从技能包管理器安装...`);
    let installed = false;
    // 依次尝试 clawhub（WorkBuddy 系列）、pip、npm
    const pkgManagers = [
      { cmd: 'clawhub', args: `install ${skillName}` },
      { cmd: 'pip', args: `install ${skillName}` },
      { cmd: 'npm', args: `install -g ${skillName}` },
    ];
    for (const pm of pkgManagers) {
      try {
        execSync(`${pm.cmd} ${pm.args}`, { stdio: 'pipe', timeout: 60000 });
        log(`✅ 技能 "${skillName}" 通过 ${pm.cmd} 安装成功！`);
        installed = true;
        break;
      } catch (_) {
        // 尝试下一个
      }
    }
    if (!installed) {
      log(`技能 "${skillName}" 加载失败: 本地仓库和技能包管理器均未找到`, 'ERROR');
      process.exit(1);
    }
  }
}

/** 检查技能完整性（依赖、模型等） */
function cmdSkillCheck(skillName) {
  if (!skillName) { log('请指定技能名称', 'ERROR'); process.exit(1); }

  const skillDirs = getSkillDirs();
  let skillDir = null;
  for (const sd of skillDirs) {
    const p = path.join(sd, skillName);
    if (fs.existsSync(p)) { skillDir = p; break; }
  }
  if (!skillDir) { log(`技能 "${skillName}" 未找到`, 'ERROR'); return; }

  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) { log(`技能 "${skillName}" 缺少 SKILL.md`, 'WARN'); return; }

  const content = fs.readFileSync(skillMd, 'utf-8');

  // 检查 requires 字段
  const requiresMatch = content.match(/requires[:\s]+\[([^\]]+)\]/i) || content.match(/依赖[:\s]+(.+)/i);
  if (requiresMatch) {
    const requires = requiresMatch[1].split(/[,，]/).map(s => s.trim()).filter(Boolean);
    for (const req of requires) {
      try {
        execSync(`where ${req} 2>nul || which ${req} 2>/dev/null`, { stdio: 'pipe' });
        log(`  ✅ 依赖 "${req}" 已安装`);
      } catch (_) {
        log(`  ⚠️ 依赖 "${req}" 未安装，尝试自动安装...`);
        // 尝试用 pip/npm 或其他包管理器安装
        try {
          if (req.startsWith('python') || req === 'pip') {
            execSync('pip install ' + req, { stdio: 'inherit', timeout: 120000 });
          } else if (req === 'node' || req === 'npm') {
            // Node.js 一般已安装
          } else {
            // 尝试 clawhub → npm → pip
            try { execSync(`clawhub install ${req}`, { stdio: 'pipe', timeout: 60000 }); }
            catch (_) {
              try { execSync(`npm install -g ${req}`, { stdio: 'pipe', timeout: 120000 }); }
              catch (_2) { execSync(`pip install ${req}`, { stdio: 'inherit', timeout: 120000 }); }
            }
          }
          log(`  ✅ 依赖 "${req}" 安装成功`);
        } catch (e2) {
          log(`  ❌ 依赖 "${req}" 自动安装失败，请手动安装`, 'ERROR');
        }
      }
    }
  }

  // 检查模型文件
  const modelMatch = content.match(/模型[:\s]+(.+)/i) || content.match(/model[:\s]+["']?([^"'\n]+)/i);
  if (modelMatch) {
    const modelPath = modelMatch[1].trim();
    if (fs.existsSync(modelPath)) {
      log(`  ✅ 模型 "${modelPath}" 已存在`);
    } else {
      log(`  ⚠️ 模型 "${modelPath}" 不存在，需要下载`);
      // 检查是否有下载脚本
      const downloadScript = path.join(skillDir, 'scripts', 'download_model.sh');
      const downloadScriptWin = path.join(skillDir, 'scripts', 'download_model.py');
      if (fs.existsSync(downloadScriptWin)) {
        log(`  🔄 正在运行模型下载脚本...`);
        try {
          execSync(`python3 "${downloadScriptWin}"`, { stdio: 'inherit', timeout: 600000 });
          log(`  ✅ 模型下载完成`);
        } catch (e) {
          log(`  ❌ 模型下载失败: ${e.message}`, 'ERROR');
        }
      } else if (fs.existsSync(downloadScript)) {
        log(`  ⚠️ 发现下载脚本但仅支持 Linux/Mac`, 'WARN');
      } else {
        log(`  ⚠️ 无自动下载脚本，请手动下载模型`, 'WARN');
      }
    }
  }

  log(`技能 "${skillName}" 完整性检查完成`);
}

// ============ 场景3：全量同步（"同步GIT仓库"） ============

/** 全量同步：记忆（v3.0 push） + 技能 */
async function cmdSyncAll() {
  const config = loadConfig();
  const aiName = config.ai_name;

  if (!checkLock()) { log('其他 AI 正在同步，请稍后重试', 'ERROR'); process.exit(1); }
  createLock(aiName);

  const results = { memory: null, skills: null };

  try {
    // ---- 第一步：记忆库同步（v3.0 push） ----
    log('═══ 第一步：记忆库同步（v3.0 目录隔离） ═══');
    results.memory = await cmdPush();

    // ---- 第二步：技能库同步 ----
    log('═══ 第二步：技能库同步 ═══');
    results.skills = await cmdSyncSkills();

    // 汇总结果
    const memOk = results.memory && !process.exitCode;
    const skiOk = results.skills && results.skills.ok;
    const allOk = memOk && skiOk;

    if (allOk) {
      log('═══ 全量同步完成！═══');
    } else {
      log('═══ ⚠️ 部分同步失败 ═══', 'WARN');
      if (!skiOk) log('  ⚠️ 技能库: ' + (results.skills && results.skills.error || '失败') + '（不影响记忆同步）', 'WARN');
      // v3.1.8: 只有记忆同步失败才设退出码1，技能库失败不影响核心功能
      if (!memOk) process.exitCode = 1;
    }
    cmdSoul();
  } finally {
    removeLock();
  }
}

// ============ v3.0: migrate v3 迁移命令 ============

/** v3.0 迁移：将仓库结构从旧格式迁移到 Layer0/Layer1/Layer2 */
function cmdMigrateV3() {
  const config = loadConfig();
  const workspaceDir = config.workspace_dir || process.cwd();
  const aiName = config.ai_name;

  const dryRun = process.argv.includes('--dry-run');
  const execute = process.argv.includes('--execute');
  const verify = process.argv.includes('--verify');

  if (!dryRun && !execute && !verify) {
    log('用法: node sync.js migrate v3 [--dry-run|--execute|--verify]', 'ERROR');
    process.exit(1);
  }

  process.chdir(workspaceDir);

  if (verify) {
    log('=== 迁移验证 ===');
    // 检查目录结构
    const required = ['agents', 'agents/' + aiName, 'shared'];
    for (const dir of required) {
      const exists = fs.existsSync(path.join(workspaceDir, dir));
      log('  ' + (exists ? '✅' : '❌') + ' ' + dir);
    }
    // 检查 profile.json
    const profile = loadProfile(workspaceDir);
    log('  ' + (profile ? '✅' : '❌') + ' agents/' + aiName + '/profile.json');
    // 检查 agents.json
    const agentsJson = loadAgentsJson(workspaceDir);
    log('  ' + (agentsJson ? '✅' : '❌') + ' agents.json');

    if (profile) {
      profile._migration = profile._migration || {};
      profile._migration.verified = true;
      profile._migration.verified_at = new Date().toISOString();
      saveProfile(workspaceDir, profile);
      log('  ✅ profile.json._migration.verified = true');
    }
    return;
  }

  if (dryRun) {
    log('=== 迁移预览（dry-run，不执行任何操作）===');
    log('');
    log('将执行以下操作：');
    log('  1. 创建 git tag archive/pre-migration-v3');
    log('  2. 创建目录: agents/' + aiName + '/, agents/' + aiName + '/daily/, shared/');
    log('  3. 拷贝本地记忆文件到 agents/' + aiName + '/');
    log('  4. 生成/更新 profile.json');
    log('  5. 确保 agents.json 存在');

    // 检查哪些文件会被迁移
    const profile = loadProfile(workspaceDir);
    if (profile && profile.local) {
      const memSrc = path.join(workspaceDir, profile.local.memory_path);
      log('  记忆源: ' + (fs.existsSync(memSrc) ? '✅ ' + profile.local.memory_path : '❌ 不存在'));
      const dailySrc = path.join(workspaceDir, profile.local.daily_path);
      if (fs.existsSync(dailySrc)) {
        const count = fs.readdirSync(dailySrc).filter(f => f.endsWith('.md')).length;
        log('  日志源: ✅ ' + profile.local.daily_path + ' (' + count + ' 篇)');
      }
    }
    return;
  }

  if (execute) {
    log('=== 执行 v3.0 迁移 ===');

    // [1/5] 创建 git tag 备份
    log('[1/5] 创建 git tag 备份...');
    try {
      runGit(['tag', 'archive/pre-migration-v3', '-m', 'v3.0 迁移前快照'], { quiet: true, allowFail: true });
      log('  ✅ git tag archive/pre-migration-v3');
    } catch (_) {
      log('  ℹ️ tag 已存在，跳过');
    }

    // [2/5] 创建目录结构
    log('[2/5] 创建目录结构...');
    const agentDir = path.join(workspaceDir, 'agents', aiName);
    const dailyDir = path.join(agentDir, 'daily');
    const sharedDir = path.join(workspaceDir, 'shared');
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.mkdirSync(sharedDir, { recursive: true });
    log('  ✅ agents/' + aiName + '/');
    log('  ✅ agents/' + aiName + '/daily/');
    log('  ✅ shared/');

    // [3/5] 拷贝本地记忆文件
    log('[3/5] 拷贝本地记忆文件...');
    const profile = loadProfile(workspaceDir);
    if (profile && profile.local) {
      // MEMORY.md
      const memSrc = path.join(workspaceDir, profile.local.memory_path);
      const memDest = path.join(agentDir, 'MEMORY.md');
      if (fs.existsSync(memSrc)) {
        fs.copyFileSync(memSrc, memDest);
        log('  ✅ MEMORY.md');
      }
      // Daily logs
      const dailySrc = path.join(workspaceDir, profile.local.daily_path);
      if (fs.existsSync(dailySrc)) {
        const dailyFiles = fs.readdirSync(dailySrc).filter(f => f.endsWith('.md'));
        let count = 0;
        for (const file of dailyFiles) {
          const srcFile = path.join(dailySrc, file);
          const destFile = path.join(dailyDir, file);
          fs.copyFileSync(srcFile, destFile);
          // 注入 front matter
          if (!hasFrontMatter(destFile)) {
            injectFrontMatter(destFile, {
              author: aiName,
              date: extractDateFromFileName(file),
              type: inferTypeFromContent(destFile)
            });
          }
          count++;
        }
        log('  ✅ ' + count + ' 个日志文件（已注入 front matter）');
      }
    } else {
      log('  ⚠️ profile.json 不存在或缺少 local 配置', 'WARN');
    }

    // [4/5] 更新 profile.json
    log('[4/5] 更新 profile.json...');
    if (profile) {
      profile._migration = {
        enabled: false,
        migrated_at: new Date().toISOString(),
        verified: false
      };
      saveProfile(workspaceDir, profile);
      log('  ✅ profile.json 已更新');
    } else {
      // 如果没有 profile.json，init 应该已经创建了
      log('  ⚠️ profile.json 不存在，请先运行 sync init', 'WARN');
    }

    // [5/5] 确保 agents.json 存在
    log('[5/5] 检查 agents.json...');
    let agentsJson = loadAgentsJson(workspaceDir);
    if (!agentsJson) {
      agentsJson = {
        version: "1.0",
        lastUpdated: new Date().toISOString(),
        agents: []
      };
    }
    // 确保当前 AI 在 agents 列表中
    const existingAgent = agentsJson.agents.find(a => a.name === aiName);
    if (!existingAgent) {
      agentsJson.agents.push({
        name: aiName,
        display_name: profile ? profile.display_name : aiName,
        platform: profile ? profile.platform : 'unknown',
        status: 'active',
        first_seen: new Date().toISOString().slice(0, 10),
        last_sync: null
      });
      agentsJson.lastUpdated = new Date().toISOString();
    } else {
      existingAgent.last_sync = new Date().toISOString();
      agentsJson.lastUpdated = new Date().toISOString();
    }
    fs.writeFileSync(path.join(workspaceDir, 'agents.json'), JSON.stringify(agentsJson, null, 2), 'utf-8');
    log('  ✅ agents.json 已更新');

    log('');
    log('═══ 迁移完成！═══');
    log('  下一步：');
    log('    1. 运行 sync migrate v3 --verify  验证迁移结果');
    log('    2. 运行 sync push               推送到远程');
  }
}

// ============ v3.0: push 命令（目录隔离 + front matter 注入） ============

/** v3.0 push：只 stage agents/{me}/ */
async function cmdPush() {
  const config = loadConfig();
  const aiName = config.ai_name;
  const workspaceDir = config.workspace_dir || process.cwd();

  if (!checkLock()) { log('其他 AI 正在同步，请稍后重试', 'ERROR'); process.exit(1); }
  createLock(aiName);

  try {
    process.chdir(workspaceDir);

    // 确保 Git 仓库存在
    if (!fs.existsSync(path.join(workspaceDir, '.git'))) {
      log('工作区不是 Git 仓库，请先运行 sync init', 'ERROR');
      process.exit(1);
    }

    // 设置凭证
    try {
      execSync('git config credential.helper "store --file ' + getGitCredFile().replace(/\\/g, '/') + '"', { stdio: 'pipe' });
    } catch (_) {}

    const agentDir = 'agents/' + aiName + '/';

    // 检查 agents/{me}/ 是否存在
    if (!fs.existsSync(path.join(workspaceDir, agentDir))) {
      log('❌ ' + agentDir + ' 不存在，请先运行 sync init 或 sync migrate v3 --execute', 'ERROR');
      process.exit(1);
    }

    // Step 1: 读 profile.json.local 获取本地文件路径
    const profile = loadProfile(workspaceDir);
    if (!profile) {
      log('❌ profile.json 不存在，请先运行 sync init', 'ERROR');
      process.exit(1);
    }

    const localPaths = profile.local;
    const repoAgentDir = path.join(workspaceDir, agentDir);

    // Step 2: 拷贝本地记忆文件到 agents/{me}/
    log('1. 拷贝本地记忆文件到 ' + agentDir + '...');

    // MEMORY.md
    if (localPaths.memory_path) {
      const srcMemory = resolveSrcPath(workspaceDir, localPaths.memory_path);
      const destMemory = path.join(repoAgentDir, 'MEMORY.md');
      if (fs.existsSync(srcMemory)) {
        fs.copyFileSync(srcMemory, destMemory);
        log('  ✅ MEMORY.md 已拷贝');
      } else {
        log('  ⚠️ 本地 MEMORY.md 不存在: ' + srcMemory, 'WARN');
      }
    }

    // Daily logs
    if (localPaths.daily_path) {
      const srcDaily = resolveSrcPath(workspaceDir, localPaths.daily_path);
      const destDaily = path.join(repoAgentDir, 'daily/');
      if (fs.existsSync(srcDaily)) {
        fs.mkdirSync(destDaily, { recursive: true });
        const dailyFiles = fs.readdirSync(srcDaily).filter(f => f.endsWith('.md'));
        for (const file of dailyFiles) {
          const srcFile = path.join(srcDaily, file);
          const destFile = path.join(destDaily, file);
          fs.copyFileSync(srcFile, destFile);

          // Step 3: 为缺失 front matter 的日志注入 YAML header（规则#4）
          if (!hasFrontMatter(destFile)) {
            injectFrontMatter(destFile, {
              author: aiName,
              date: extractDateFromFileName(file),
              type: inferTypeFromContent(destFile)
            });
          }

          // Step 3.5: 检查日志详细度
          const detail = checkLogDetail(destFile);
          if (!detail.valid) {
            log('  ⚠️ ' + file + ' 日志详细度不足（' + detail.score + '/5），融合时可能降低权重', 'WARN');
          }
        }
        log('  ✅ ' + dailyFiles.length + ' 个日志文件已拷贝 + 检查');
      }
    }

    // Step 4: 更新 profile.json.last_sync 时间戳
    profile.last_sync = new Date().toISOString();
    saveProfile(workspaceDir, profile);

    // Step 5: 只 git add agents/{me}/（目录隔离！绝对不能 git add .）
    log('2. 提交到 ' + agentDir + '...');
    runGit(['add', agentDir]);
    const hasChanges = runGit(['diff', '--cached', '--quiet'], { quiet: true, allowFail: true });
    if (hasChanges === null) {
      const commitMsg = aiName + ': sync ' + new Date().toISOString().slice(0, 16);
      runGit(['commit', '-m', commitMsg]);
      log('  ✅ 变更已提交');
    } else {
      log('  ℹ️ 无新变更需要提交');
      removeLock();
      return;
    }

    // Step 6: 拉取远程更新（rebase），处理冲突
    log('3. 拉取远程更新...');
    try {
      runGit(['pull', '--rebase', 'origin', 'main'], { quiet: true });
      log('  ✅ 远程更新已合并');
    } catch (e) {
      try {
        runGit(['rebase', '--abort'], { quiet: true, allowFail: true });
        // agents.json 冲突用 theirs（主AI版本优先）
        runGit(['pull', '--no-rebase', '-X', 'theirs', 'origin', 'main'], { quiet: true, allowFail: true });
        log('  ✅ 冲突已自动解决（agents.json 用主AI版本）');
      } catch (e2) {
        log('  ⚠️ 远程无更新或合并失败，继续推送', 'WARN');
      }
    }

    // Step 7: 推送（重试3次）
    log('4. 推送到远程...');
    const memBranch = getCurrentBranch(workspaceDir);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        runGit(['push', 'origin', memBranch], { timeout: 120000 });
        log('  ✅ 推送成功！');
        // v3.1.8: 写入身份缓存到平台目录（如 ~/.qclaw/.ai-identity），不写共享workspace
        try {
          const aiName = (loadConfig().ai_name || '').toLowerCase();
          if (aiName) {
            const cwd2 = process.cwd();
            const rel2 = path.relative(os.homedir(), cwd2);
            const platformDir = path.join(os.homedir(), rel2.split(path.sep)[0]);
            if (platformDir && platformDir.startsWith('.')) {
              fs.writeFileSync(path.join(platformDir, '.ai-identity'), aiName, 'utf-8');
            }
          }
        } catch (_) {}
        log('');
        log('═══ push 完成（' + agentDir + '）═══');
        return;
      } catch (e) {
        const errMsg = (e.stderr || e.message || '').toString();
        if (errMsg.includes('non-fast-forward') && attempt < 2) {
          const waitTime = Math.pow(2, attempt) * 1000;
          log('  推送冲突，第 ' + (attempt + 1) + ' 次重试...', 'WARN');
          await sleep(waitTime);
          try { runGit(['pull', '--rebase', 'origin', memBranch], { quiet: true }); } catch (_) {}
          continue;
        }
        log('  ❌ 推送失败: ' + errMsg, 'ERROR');
        process.exitCode = 1;
        return;
      }
    }
  } finally {
    removeLock();
  }
}

/** 技能库同步：扫描新技能 → 打包 → 推送到 ai-skills 仓库 + 从远程下载缺失技能 */
async function cmdSyncSkills() {
  const skillDirs = getSkillDirs();
  const skillRepoDir = getSkillRepoDir();
  const skillRepoSkillsDir = path.join(skillRepoDir, 'skills');

  // 1. 扫描本地所有已安装技能（从配置路径列表读取）
  log('1. 扫描本地技能...');
  const localSkills = new Map();

  for (const skillsDir of skillDirs) {
    if (!fs.existsSync(skillsDir)) continue;
    for (const name of fs.readdirSync(skillsDir).filter(f => fs.statSync(path.join(skillsDir, f)).isDirectory())) {
      if (localSkills.has(name)) continue;
      const skillMd = path.join(skillsDir, name, 'SKILL.md');
      localSkills.set(name, { path: path.join(skillsDir, name), hasSkillMd: fs.existsSync(skillMd) });
    }
  }

  log(`  发现 ${localSkills.size} 个本地技能`);

  // 2. 对比仓库中已有的技能
  if (!fs.existsSync(skillRepoDir)) {
    log('  技能仓库不存在，正在创建目录: ' + skillRepoDir, 'WARN');
    fs.mkdirSync(skillRepoDir, { recursive: true });
  }

  // P1-5: 技能仓库目录不是 git 仓库时自动初始化
  process.chdir(skillRepoDir);
  if (!fs.existsSync(path.join(skillRepoDir, '.git'))) {
    log('  技能仓库不是 Git 仓库，正在自动初始化...', 'WARN');
    try {
      execSync('git init', { cwd: skillRepoDir, stdio: 'pipe' });
      execSync('git branch -M main', { cwd: skillRepoDir, stdio: 'pipe', env: { ...process.env, GIT_DEFAULT_BRANCH: 'main' } });
      const skillRepoUrl = loadConfigRaw().skill_repo_url || REPOS.skill.url;
      execSync('git remote add origin ' + skillRepoUrl, { cwd: skillRepoDir, stdio: 'pipe' });
      execSync('git config credential.helper "store --file ' + getGitCredFile().replace(/\\/g, '/') + '"', { cwd: skillRepoDir, stdio: 'pipe' });
      // 拉取远程
      try {
        runGit(['fetch', 'origin'], { quiet: true });
        runGit(['checkout', '-B', 'main', 'origin/main'], { quiet: true, allowFail: true });
        log('  ✅ 已拉取远程技能仓库历史');
      } catch (_) {
        runGit(['commit', '--allow-empty', '-m', 'init: ai-skills repo'], { quiet: true, allowFail: true });
        log('  远程技能仓库为空，已创建初始提交');
      }
    } catch (e) {
      log('  技能仓库自动初始化失败: ' + e.message, 'WARN');
    }
  }

  // 设置本地 credential helper（指向隔离凭证文件）
  try {
    execSync('git config credential.helper "store --file ' + getGitCredFile().replace(/\\/g, '/') + '"', { stdio: 'pipe' });
  } catch (_) {}

  // P1-4: 技能仓库也需要冲突处理
  try {
    runGit(['pull', '--rebase', 'origin', 'main'], { quiet: true });
  } catch (_) {
    try {
      runGit(['rebase', '--abort'], { quiet: true, allowFail: true });
      runGit(['pull', '--no-rebase', '-X', 'ours', 'origin', 'main'], { quiet: true, allowFail: true });
    } catch (_2) {}
  }

  const repoSkills = fs.existsSync(skillRepoSkillsDir)
    ? fs.readdirSync(skillRepoSkillsDir).filter(f => fs.statSync(path.join(skillRepoSkillsDir, f)).isDirectory())
    : [];

  // P0-3: 从远程仓库下载本地缺失的技能（双向同步）
  log('2. 检查远程技能，同步到本地...');
  const primarySkillDir = skillDirs[0];
  fs.mkdirSync(primarySkillDir, { recursive: true });
  let downloadCount = 0;
  for (const remoteName of repoSkills) {
    const isLocallyInstalled = skillDirs.some(sd => fs.existsSync(path.join(sd, remoteName)));
    if (!isLocallyInstalled) {
      const srcPath = path.join(skillRepoSkillsDir, remoteName);
      const destPath = path.join(primarySkillDir, remoteName);
      try {
        copyDirRecursive(srcPath, destPath);
        downloadCount++;
        log('  ⬇️ 下载缺失技能: ' + remoteName);
      } catch (e) {
        log('  ❌ 下载技能失败: ' + remoteName + ' (' + e.message + ')', 'WARN');
      }
    }
  }
  if (downloadCount > 0) log(`  ✅ 从远程下载 ${downloadCount} 个缺失技能到本地`);
  else log('  ℹ️ 本地技能均已是最新');

  let newCount = 0;
  let updateCount = 0;

  // 3. 打包新技能或更新已有技能（累加模式，最新版本优先）
  for (const [name, info] of localSkills) {
    if (!info.hasSkillMd) continue; // 跳过没有 SKILL.md 的

    const targetDir = path.join(skillRepoSkillsDir, name);
    const isUpdate = repoSkills.includes(name);

    // 轻量化打包：排除模型、大文件、node_modules 等
    const excludePatterns = ['node_modules', '.git', '*.safetensors', '*.bin', '*.onnx',
      '*.pt', '*.pth', '*.h5', '*.pkl', '__pycache__', '.cache', '*.tmp'];

    // 复制技能文件（排除大文件）
    function copySkillLight(src, dest) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (excludePatterns.some(p => entry.name.match(p.replace('*', '.*')))) continue;
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copySkillLight(srcPath, destPath);
        } else {
          // 跳过大于 50MB 的文件
          try {
            const stat = fs.statSync(srcPath);
            if (stat.size > 50 * 1024 * 1024) {
              log(`    跳过大文件: ${entry.name} (${(stat.size/1024/1024).toFixed(1)}MB)`, 'WARN');
              continue;
            }
          } catch (_) {}
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }

    // 版本对比：只在本地的 SKILL.md 比仓库新时才复制
    let needCopy = !isUpdate; // 新技能直接复制
    if (isUpdate) {
      const localSkillMd = path.join(info.path, 'SKILL.md');
      const repoSkillMd = path.join(targetDir, 'SKILL.md');
      try {
        const localMtime = fs.statSync(localSkillMd).mtimeMs;
        const repoMtime = fs.statSync(repoSkillMd).mtimeMs;
        if (localMtime > repoMtime) {
          needCopy = true;
        } else {
          continue; // 本地不比仓库新，跳过
        }
      } catch (_) {
        needCopy = true; // 无法比较时间，保守复制
      }
    }

    if (needCopy) {
      copySkillLight(info.path, targetDir);
      if (isUpdate) {
        updateCount++;
        log('  🔄 更新技能: ' + name);
      } else {
        newCount++;
        log('  ✨ 新增技能: ' + name);
      }
    }
  }

  // 4. 更新 registry.json
  const registry = { version: '2.0.0', updated: new Date().toISOString().slice(0, 10), skills: [] };
  if (fs.existsSync(path.join(skillRepoSkillsDir))) {
    for (const name of fs.readdirSync(skillRepoSkillsDir).filter(f => fs.statSync(path.join(skillRepoSkillsDir, f)).isDirectory())) {
      const skillMd = path.join(skillRepoSkillsDir, name, 'SKILL.md');
      let description = '';
      let version = '1.0.0';
      if (fs.existsSync(skillMd)) {
        const content = fs.readFileSync(skillMd, 'utf-8');
        const descMatch = content.match(/description[:\s]+["']?(.+?)["']?\n/i) || content.match(/^# .+\n\n(.+)/m);
        if (descMatch) description = descMatch[1].trim();
        const verMatch = content.match(/version[:\s]+["']?([\d.]+)/i);
        if (verMatch) version = verMatch[1];
      }
      registry.skills.push({ name, version, description: description.slice(0, 100), path: `skills/${name}` });
    }
  }
  fs.writeFileSync(path.join(skillRepoDir, 'registry.json'), JSON.stringify(registry, null, 2), 'utf-8');

  // 5. 提交并推送
  if (newCount > 0 || updateCount > 0) {
    runGit(['add', '.'], { cwd: skillRepoDir });
    // 检查是否有暂存变更
    try { execSync('git diff --cached --quiet', { cwd: skillRepoDir, stdio: 'pipe' }); log('  ℹ️ 技能仓库无变更'); return { ok: true }; } catch(e) {}
    const commitMsg = `技能同步: +${newCount} 新增, ~${updateCount} 更新 (${new Date().toISOString().slice(0, 16)})`;
    runGit(['commit', '-m', commitMsg], { cwd: skillRepoDir });
    const skillBranch = getCurrentBranch(skillRepoDir);
    try {
      runGit(['push', 'origin', skillBranch], { cwd: skillRepoDir, timeout: 120000 });
      log(`  ✅ 技能仓库已推送！新增 ${newCount}，更新 ${updateCount}`);
    } catch(e) {
      const errMsg = (e.stderr || e.message || '').toString();
      log(`  ❌ 技能仓库推送失败: ${errMsg}`, 'ERROR');
      return { ok: false, error: errMsg };
    }
  } else {
    log('  ℹ️ 技能仓库无变更');
  }
  return { ok: true };
}

// ============ v3.0: pull 命令（拉取 + 反向拷贝融合记忆） ============

/** v3.0 pull：git pull + 拷贝融合索引到本地注入路径 */
function cmdPull() {
  const config = loadConfig();
  const workspaceDir = config.workspace_dir || process.cwd();
  const aiName = config.ai_name;

  process.chdir(workspaceDir);

  // 设置凭证
  try {
    execSync('git config credential.helper "store --file ' + getGitCredFile().replace(/\\/g, '/') + '"', { stdio: 'pipe' });
  } catch (_) {}

  // Step 1: git pull
  log('1. 拉取远程记忆...');
  try {
    runGit(['pull', '--rebase', 'origin', 'main']);
    log('  ✅ 拉取成功！');
  } catch (e) {
    // agents.json 冲突用 theirs
    try {
      runGit(['merge', '--abort'], { quiet: true, allowFail: true });
      runGit(['pull', '--no-rebase', '-X', 'theirs', 'origin', 'main'], { quiet: true, allowFail: true });
      log('  ✅ 拉取成功（agents.json 已用主AI版本解决冲突）');
    } catch (e2) {
      log('  ❌ 拉取失败: ' + e2.message, 'ERROR');
      process.exit(1);
    }
  }

  // Step 2: 反向拷贝融合索引版 MEMORY.md 到本地注入路径
  const profile = loadProfile(workspaceDir);
  if (!profile || !profile.local) {
    log('  ⚠️ profile.json 不存在或缺少 local 配置，跳过反向拷贝', 'WARN');
    log('  请运行 sync init 生成 profile.json');
    return;
  }

  const fusedMemory = path.join(workspaceDir, 'MEMORY.md');
  if (!fs.existsSync(fusedMemory)) {
    log('  ⚠️ 根目录 MEMORY.md（融合索引版）不存在，跳过反向拷贝', 'WARN');
    return;
  }

  const localMemory = path.join(workspaceDir, profile.local.memory_path);
  if (fs.existsSync(fusedMemory)) {
    fs.mkdirSync(path.dirname(localMemory), { recursive: true });
    fs.copyFileSync(fusedMemory, localMemory);
    log('  ✅ 融合索引版 MEMORY.md 已拷贝到: ' + profile.local.memory_path);
  }

  // Step 3: 同步 shared/ 中的模板/标准到本地（如有配置）
  const sharedDir = path.join(workspaceDir, 'shared');
  if (fs.existsSync(sharedDir)) {
    log('  ℹ️ shared/ 目录已就位（' + fs.readdirSync(sharedDir).length + ' 项）');
  }

  // Step 4: 拉取 ai-skills 仓库（技能同步）
  const skillRepoDir = getSkillRepoDir();
  if (fs.existsSync(path.join(skillRepoDir, '.git'))) {
    log('2. 拉取技能仓库...');
    try {
      process.chdir(skillRepoDir);
      runGit(['pull', '--rebase', 'origin', 'main'], { quiet: true });
      log('  ✅ 技能仓库已更新');
      process.chdir(workspaceDir);
    } catch (_) {
      process.chdir(workspaceDir);
      log('  ⚠️ 技能仓库拉取失败', 'WARN');
    }
  }

  log('');
  log('═══ pull 完成 ═══');
  log('  融合索引版 → ' + profile.local.memory_path);
}

function cmdStatus() {
  const config = loadConfig();
  const aiName = config.ai_name;
  const workspaceDir = config.workspace_dir || process.cwd();

  console.log('=== 同步状态（v3.0）===');
  console.log('AI 名称: ' + aiName);
  console.log('平台: ' + (config.platform || '未检测'));
  console.log('仓库 URL: ' + config.repo_url);
  console.log('工作区: ' + workspaceDir);
  console.log('自动同步: ' + config.auto_sync);

  process.chdir(workspaceDir);
  try {
    const localHash = runGit(['rev-parse', 'HEAD'], { capture: true, allowFail: true });
    const remoteHash = runGit(['rev-parse', 'origin/main'], { capture: true, allowFail: true });
    console.log('本地版本: ' + localHash);
    console.log('远程版本: ' + remoteHash);
    const ahead = runGit(['rev-list', '--count', 'origin/main..HEAD'], { capture: true, allowFail: true });
    const behind = runGit(['rev-list', '--count', 'HEAD..origin/main'], { capture: true, allowFail: true });
    if (ahead && ahead !== '0') console.log('领先远程: ' + ahead + ' 个提交');
    if (behind && behind !== '0') console.log('落后远程: ' + behind + ' 个提交');
    const status = runGit(['status', '--porcelain'], { capture: true, allowFail: true });
    if (status) { console.log('未提交的变更:'); status.split('\n').filter(Boolean).forEach(line => console.log('  ' + line)); }
    else { console.log('工作区干净'); }
  } catch (e) { console.log('无法获取 Git 状态: ' + e.message); }

  // v3.0: 显示 profile.json 和 agents/ 状态
  const agentDir = path.join(workspaceDir, 'agents', aiName);
  const profile = loadProfile(workspaceDir);
  console.log('');
  console.log('--- v3.0 目录隔离 ---');
  console.log('agents/' + aiName + '/: ' + (fs.existsSync(agentDir) ? '✅ 存在' : '❌ 不存在'));
  console.log('profile.json: ' + (profile ? '✅ 存在 (last_sync=' + (profile.last_sync || '从未') + ')' : '❌ 不存在'));
  const agentsJson = loadAgentsJson(workspaceDir);
  console.log('agents.json: ' + (agentsJson ? '✅ 存在 (' + (agentsJson.agents ? agentsJson.agents.length : 0) + ' agents)' : '❌ 不存在'));

  // 显示 agents/{me}/ 的文件
  if (fs.existsSync(agentDir)) {
    const files = listFilesRecursive(agentDir);
    console.log('agents/' + aiName + '/ 文件: ' + files.length + ' 个');
  }
}

function cmdAuto(onOff) {
  const config = loadConfig();
  if (onOff === 'on') { config.auto_sync = true; log('自动同步已开启'); }
  else if (onOff === 'off') { config.auto_sync = false; log('自动同步已关闭'); }
  else { log('请指定 on 或 off', 'ERROR'); process.exit(1); }
  saveConfig(config);
}

// ============ 技能管理命令（原有 + 新增） ============

function cmdSkillList() {
  const config = loadConfig();
  const workspaceDir = config.workspace_dir || process.cwd();
  const registryPath = path.join(workspaceDir, 'skills-registry.md');
  const skillDirs = getSkillDirs();

  console.log('=== 技能索引 ===\n');
  if (!fs.existsSync(registryPath)) {
    console.log('未找到 skills-registry.md，请先同步记忆');
    console.log('运行: node sync.js pull');
    return;
  }

  const content = fs.readFileSync(registryPath, 'utf-8');
  const skills = content.split('---').slice(1);
  let count = 0;

  for (const block of skills) {
    const nameMatch = block.match(/^### (.+)/m);
    if (nameMatch) {
      count++;
      const name = nameMatch[1];
      const sceneMatch = block.match(/\*\*场景\*\*：(.+)/);
      const repoMatch = block.match(/\*\*仓库\*\*：(.+)/);
      const tagsMatch = block.match(/\*\*标签\*\*：(.+)/);
      const installed = skillDirs.some(sd => fs.existsSync(path.join(sd, name)));

      console.log(`${count}. ${name}`);
      if (sceneMatch) console.log(`   场景: ${sceneMatch[1]}`);
      console.log(`   仓库: ${repoMatch ? repoMatch[1] : '未知'}`);
      if (tagsMatch) console.log(`   标签: ${tagsMatch[1]}`);
      console.log(`   状态: ${installed ? '已安装' : '未安装'}`);
      console.log('');
    }
  }
  console.log(`共 ${count} 个技能`);
}

function cmdSkillInstall(skillName) {
  if (!skillName) { log('请指定技能名称: node sync.js skill install <名称>', 'ERROR'); process.exit(1); }

  const skillDirs = getSkillDirs();
  const targetDir = path.join(skillDirs[0], skillName);

  if (fs.existsSync(targetDir)) { log(`技能 "${skillName}" 已安装，跳过`, 'WARN'); return; }

  // 先尝试从本地 ai-skills 仓库
  const skillRepoDir = getSkillRepoDir();
  const skillRepoPath = path.join(skillRepoDir, 'skills', skillName);
  if (fs.existsSync(skillRepoPath)) {
    fs.mkdirSync(skillDirs[0], { recursive: true });
    copyDirRecursive(skillRepoPath, targetDir);
    log(`✅ 技能 "${skillName}" 从本地仓库安装成功！`);
    return;
  }

  // 再尝试从可选的技能包管理器安装
  log(`本地仓库未找到 "${skillName}"，尝试技能包管理器...`);
  let installed = false;
  const pkgManagers = [
    { cmd: 'clawhub', args: `install ${skillName}` },
    { cmd: 'npm', args: `install -g ${skillName}` },
  ];
  for (const pm of pkgManagers) {
    try {
      execSync(`${pm.cmd} ${pm.args}`, { stdio: 'pipe', timeout: 60000 });
      log(`✅ 技能 "${skillName}" 通过 ${pm.cmd} 安装成功！`);
      installed = true;
      break;
    } catch (_) {}
  }
  if (!installed) {
    log(`技能 "${skillName}" 安装失败: 本地仓库和技能包管理器均未找到`, 'ERROR');
    process.exit(1);
  }
}

function cmdSkillRemove(skillName) {
  if (!skillName) { log('请指定技能名称: node sync.js skill remove <名称>', 'ERROR'); process.exit(1); }
  const skillDirs = getSkillDirs();
  let removed = false;
  for (const sd of skillDirs) {
    const targetDir = path.join(sd, skillName);
    if (fs.existsSync(targetDir)) { fs.rmSync(targetDir, { recursive: true, force: true }); removed = true; }
  }
  if (removed) log(`✅ 技能 "${skillName}" 已卸载`);
  else log(`技能 "${skillName}" 未安装`, 'WARN');
}

function cmdSkillSync() {
  console.log('请使用 "sync all" 执行全量技能同步');
}


/** P2: 扫描本地技能，输出结构化索引 */
function cmdSkillScan() {
  const jsonMode = process.argv.includes('--json');
  const skillDirs = getSkillDirs();
  const skills = [];

  for (const dir of skillDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isDirectory())) {
      const skillMdPath = path.join(dir, name, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      // 提取触发词
      const triggerMatch = content.match(/触发词[：:]\s*(.+)/) || content.match(/trigger[:\s]+(.+)/i);
      // 提取描述
      const descMatch = content.match(/^# .+\n+\n(.+)/m);
      skills.push({
        name,
        path: path.join(dir, name),
        description: descMatch ? descMatch[1].trim().slice(0, 200) : '',
        triggers: triggerMatch ? triggerMatch[1].split(/[、,，]/).map(s => s.trim()).filter(Boolean) : [],
      });
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ count: skills.length, skills }, null, 2));
  } else {
    console.log('=== 本地技能扫描 ===\n');
    for (const s of skills) {
      console.log(s.name);
      console.log('  描述: ' + s.description.slice(0, 80));
      if (s.triggers.length) console.log('  触发: ' + s.triggers.join(', '));
      console.log('');
    }
    console.log('共 ' + skills.length + ' 个技能');
  }

  return skills;
}
// ============ v3.1.8: 启动时自动更新 ============
const SKILL_DIR = path.resolve(__dirname, '..');

function selfUpdate() {
  if (process.env.AI_MEMORY_SYNC_SKIP_UPDATE) return; // 环境变量跳过更新
  try {
    execSync('git fetch origin main', { cwd: SKILL_DIR, timeout: 15000, stdio: 'pipe' });
    const diff = execSync('git log HEAD..origin/main --oneline', { cwd: SKILL_DIR, encoding: 'utf-8', timeout: 5000 });
    if (diff.trim()) {
      const count = diff.trim().split('\n').length;
      console.log('📦 发现新版本 (' + count + ' 个提交)，自动更新中...');
      console.log(diff.trim().split('\n').map(l => '  ' + l).join('\n'));
      execSync('git pull origin main', { cwd: SKILL_DIR, stdio: 'inherit', timeout: 30000 });
      console.log('✅ 已更新！正在用新版本重新执行...\n');
      const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, AI_MEMORY_SYNC_SKIP_UPDATE: '1' } });
      child.on('exit', (code) => process.exit(code));
      process.exit(0);
    }
  } catch (e) {
    // 网络问题或非git目录，静默忽略
  }
}

// 启动时自动检查更新（init/sync/soul 等核心命令）
const _pendingCommand = process.argv[2];
if (['init', 'sync', 'soul', 'status', 'check', 'push', 'pull', 'auto'].includes(_pendingCommand)) {
  selfUpdate();
}

// ============ 主入口 ============

const command = process.argv[2];
const subArg = process.argv[3];
const subArg2 = process.argv[4];

switch (command) {
  case 'init': cmdInit(); break;
  case 'push': cmdPush(); break;
  case 'pull': cmdPull(); break;
  case 'status': cmdStatus(); break;
  case 'auto': cmdAuto(subArg); break;
  case 'check': cmdCheck(); break;
  case 'soul': cmdSoul(); break;
  case 'sync': cmdSyncAll(); break;
  case 'migrate':
    if (subArg === 'v3') cmdMigrateV3();
    else console.log('用法: node sync.js migrate v3 [--dry-run|--execute|--verify]');
    break;
  case 'skill':
    switch (subArg) {
      case 'list': cmdSkillList(); break;
      case 'install': cmdSkillInstall(subArg2); break;
      case 'remove': cmdSkillRemove(subArg2); break;
      case 'sync': cmdSkillSync(); break;
      case 'load': cmdSkillLoad(subArg2); break;
      case 'check': cmdSkillCheck(subArg2); break;
      case 'scan': cmdSkillScan(); break;
      default:
        console.log('用法: node sync.js skill <list|install|remove|sync|load|check> [名称]');
        break;
    }
    break;
  default:
    console.log(`AI Memory Sync v3.0.0

用法: node sync.js <命令>

记忆命令:
  init        初始化同步配置（首次使用，自动生成 profile.json）
  push        提交并推送记忆（只 stage agents/{me}/，目录隔离）
  pull        拉取最新记忆 + 反向拷贝融合索引到本地
  status      查看同步状态
  auto <on|off>  开启/关闭自动同步
  check       检查远程是否有更新
  soul        显示 AI 记忆家族状态（读 agents.json + profile.json）
  soul --agent <name>  查看指定 Agent 详情
  soul --all             所有 Agent 总览

迁移命令:
  migrate v3 --dry-run   预览 v3.0 迁移
  migrate v3 --execute   执行 v3.0 迁移
  migrate v3 --verify    验证迁移结果

技能命令:
  skill list      列出所有技能
  skill install   安装技能
  skill remove    卸载技能
  skill load      自动加载技能+检查完整性
  skill check     检查技能依赖和模型完整性
  skill scan      扫描本地技能+触发词

全量同步:
  sync            记忆+技能全量同步`);
    break;
}
