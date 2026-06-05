#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_DIR = process.env.CC_WEB_CONFIG_DIR || path.join(ROOT_DIR, 'config');
const AUTH_CONFIG_PATH = path.join(CONFIG_DIR, 'auth.json');
const BANNED_IPS_PATH = path.join(CONFIG_DIR, 'banned_ips.json');
const BAN_DURATION = 7 * 24 * 60 * 60 * 1000;

function usage() {
  console.log(`用法:
  node scripts/auth-admin.js show-password
  node scripts/auth-admin.js set-password <new-password>
  node scripts/auth-admin.js list-bans
  node scripts/auth-admin.js unban <ip>
  node scripts/auth-admin.js clear-bans

说明:
  - 密码直接保存在 config/auth.json
  - 封禁列表保存在 config/banned_ips.json
  - set-password 不会校验强度，请自行设置足够强的密码`);
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`读取失败: ${filePath}`);
    console.error(err.message);
    process.exit(1);
  }
  return fallback;
}

function writeJson(filePath, payload) {
  ensureConfigDir();
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
}

function normalizeIp(ip) {
  return String(ip || '').trim().replace(/^::ffff:/, '');
}

function loadAuthConfig() {
  return readJson(AUTH_CONFIG_PATH, { password: '', mustChange: false });
}

function saveAuthConfig(config) {
  writeJson(AUTH_CONFIG_PATH, config);
}

function loadBans() {
  const raw = readJson(BANNED_IPS_PATH, {});
  if (Array.isArray(raw)) {
    const expiresAt = Date.now() + BAN_DURATION;
    return Object.fromEntries(raw.map((ip) => [normalizeIp(ip), expiresAt]));
  }
  const result = {};
  for (const [ip, expiresAt] of Object.entries(raw || {})) {
    result[normalizeIp(ip)] = Number(expiresAt);
  }
  return result;
}

function saveBans(mapLike) {
  writeJson(BANNED_IPS_PATH, mapLike);
}

function formatDateTime(timestamp) {
  if (timestamp === -1) return '永久';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '未知';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(ms) {
  if (ms === -1) return '永久';
  if (!Number.isFinite(ms) || ms <= 0) return '已到期';
  const totalMinutes = Math.ceil(ms / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes && parts.length < 2) parts.push(`${minutes}分钟`);
  if (!parts.length) parts.push('不足1分钟');
  return parts.join('');
}

function cmdShowPassword() {
  const config = loadAuthConfig();
  if (!config.password) {
    console.log('当前未找到密码配置');
    return;
  }
  console.log(`当前密码: ${config.password}`);
  console.log(`mustChange: ${config.mustChange ? 'true' : 'false'}`);
}

function cmdSetPassword(newPassword) {
  if (!newPassword) {
    console.error('缺少新密码');
    process.exit(1);
  }
  const current = loadAuthConfig();
  current.password = newPassword;
  current.mustChange = false;
  saveAuthConfig(current);
  console.log('密码已更新到 config/auth.json');
}

function cmdListBans() {
  const bans = loadBans();
  const entries = Object.entries(bans)
    .filter(([ip, expiresAt]) => ip && (expiresAt === -1 || expiresAt > Date.now()))
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!entries.length) {
    console.log('当前没有被封禁的 IP');
    return;
  }
  for (const [ip, expiresAt] of entries) {
    const remaining = expiresAt === -1 ? -1 : Math.max(0, Number(expiresAt) - Date.now());
    console.log(`${ip}  剩余: ${formatDuration(remaining)}  解封时间: ${formatDateTime(Number(expiresAt))}`);
  }
}

function cmdUnban(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    console.error('缺少 IP');
    process.exit(1);
  }
  const bans = loadBans();
  if (!Object.prototype.hasOwnProperty.call(bans, normalized)) {
    console.log(`${normalized} 不在封禁列表中`);
    return;
  }
  delete bans[normalized];
  saveBans(bans);
  console.log(`已解封 ${normalized}`);
}

function cmdClearBans() {
  saveBans({});
  console.log('已清空全部封禁记录');
}

const [, , command, arg1] = process.argv;

switch (command) {
  case 'show-password':
    cmdShowPassword();
    break;
  case 'set-password':
    cmdSetPassword(arg1);
    break;
  case 'list-bans':
    cmdListBans();
    break;
  case 'unban':
    cmdUnban(arg1);
    break;
  case 'clear-bans':
    cmdClearBans();
    break;
  default:
    usage();
    process.exit(command ? 1 : 0);
}
