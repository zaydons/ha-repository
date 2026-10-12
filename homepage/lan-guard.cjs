'use strict';
// Client-network guard, preloaded with NODE_OPTIONS=--require by run.sh.
// Drops TCP connections to Homepage whose source address is not in
// HOMEPAGE_ALLOWED_NETWORKS (comma-separated CIDRs). Loopback is always
// allowed so the container healthcheck keeps working. An empty variable
// leaves Node untouched.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const LOOPBACK = ['127.0.0.0/8', '::1/128'];
const LOG_INTERVAL_MS = 10 * 60 * 1000;
const LOG_CACHE_MAX = 1000;
const PATCHED = Symbol.for('ha-addon.lan-guard.patched');

function normalise(address) {
  if (typeof address !== 'string' || address === '') return null;
  let addr = address;
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) addr = mapped[1];
  const family = net.isIP(addr);
  if (family === 0) return null;
  return { addr, type: family === 4 ? 'ipv4' : 'ipv6' };
}

// Builds a matcher for the given CIDR list plus loopback. Throws on an
// invalid entry (including an empty or out-of-range prefix) so a bad
// configuration stops Node from starting instead of failing open.
function _build(list) {
  const blockList = new net.BlockList();
  for (const cidr of [...LOOPBACK, ...list]) {
    const parts = String(cidr).trim().split('/');
    const [addr, prefixText] = parts;
    const family = net.isIP(addr);
    const max = family === 4 ? 32 : 128;
    const prefix = /^[0-9]{1,3}$/.test(prefixText || '') ? Number(prefixText) : NaN;
    if (parts.length !== 2 || family === 0 || !(prefix >= 0 && prefix <= max)) {
      throw new Error(`lan-guard: invalid network ${JSON.stringify(cidr)}`);
    }
    blockList.addSubnet(addr, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return function isAllowed(remoteAddress) {
    const n = normalise(remoteAddress);
    if (!n) return false; // fail closed
    return blockList.check(n.addr, n.type);
  };
}

function parseEnv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const configured = parseEnv(process.env.HOMEPAGE_ALLOWED_NETWORKS);
const isAllowed = _build(configured);

const lastLogged = new Map();
function logDenied(address) {
  // Log IPv4-mapped clients (dual-stack listener) as plain IPv4.
  const n = normalise(address);
  const key = n ? n.addr : String(address);
  const now = Date.now();
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < LOG_INTERVAL_MS) return;
  if (lastLogged.size >= LOG_CACHE_MAX) lastLogged.clear();
  lastLogged.set(key, now);
  console.warn(`Blocked connection from ${key} (not in allowed_networks)`);
}

function guardServer(server) {
  server.prependListener('connection', (socket) => {
    if (!isAllowed(socket.remoteAddress)) {
      logDenied(socket.remoteAddress);
      socket.destroy();
    }
  });
  return server;
}

function wrap(mod) {
  const original = mod.createServer;
  if (original[PATCHED]) return;
  const createServer = function createServer(...args) {
    return guardServer(original.apply(this, args));
  };
  createServer[PATCHED] = true;
  mod.createServer = createServer;
}

if (configured.length > 0) {
  wrap(http);
  wrap(https);
}

module.exports = { isAllowed, _build, _logDenied: logDenied };
