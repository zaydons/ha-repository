'use strict';
// Reads the add-on options written by the Supervisor and prints the values
// run.sh exports to Homepage:
//   node addon-options.cjs hosts     -> HOMEPAGE_ALLOWED_HOSTS (comma list)
//   node addon-options.cjs networks  -> HOMEPAGE_ALLOWED_NETWORKS (comma list)
// Node built-ins only: the upstream image has no jq.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');

const OPTIONS_FILE = '/data/options.json';

// Same pattern as the allowed_hosts schema in config.yaml. Forbids "*",
// commas and whitespace, so the Host check can never be switched off.
const HOST_RE =
  /^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$/;
const NETWORK_RE = /^([0-9]{1,3}(\.[0-9]{1,3}){3}\/[0-9]{1,2}|[0-9A-Fa-f:]+\/[0-9]{1,3})$/;

const DEFAULT_NETWORKS = Object.freeze([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fc00::/7',
  'fe80::/10',
]);

function validateHost(entry) {
  if (typeof entry !== 'string' || !HOST_RE.test(entry)) {
    throw new Error(`invalid allowed_hosts entry: ${JSON.stringify(entry)}`);
  }
  const portMatch = /:([0-9]{1,5})$/.exec(entry.startsWith('[') ? entry.slice(entry.indexOf(']')) : entry);
  if (portMatch) {
    const p = Number(portMatch[1]);
    if (p < 1 || p > 65535) {
      throw new Error(`invalid port in allowed_hosts entry: ${JSON.stringify(entry)}`);
    }
  }
  if (entry.startsWith('[')) {
    const addr = entry.slice(1, entry.indexOf(']'));
    if (net.isIP(addr) !== 6) {
      throw new Error(`invalid IPv6 address in allowed_hosts entry: ${JSON.stringify(entry)}`);
    }
  }
  // Browsers send the host name in lower case.
  return entry.toLowerCase();
}

function isLinkLocalV6(addr) {
  return /^fe[89ab][0-9a-f]:/i.test(addr);
}

// Returns the list of Host header values Homepage should accept: addresses of
// the host's non-internal interfaces (visible because of host_network), the
// usual Home Assistant names, then the user's validated allowed_hosts.
function computeHosts({ options = {}, interfaces = {}, hostname = '', port = 3000 } = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`invalid port: ${JSON.stringify(port)}`);
  }
  const hosts = [];
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs || []) {
      if (!a || a.internal) continue;
      const family = a.family === 4 ? 'IPv4' : a.family === 6 ? 'IPv6' : a.family;
      if (family === 'IPv4' && net.isIP(a.address) === 4) {
        hosts.push(`${a.address}:${p}`);
      } else if (family === 'IPv6' && net.isIP(a.address) === 6) {
        // Link-local IPv6 needs a zone ID, which browsers do not send usefully.
        if (isLinkLocalV6(a.address) || a.address.includes('%')) continue;
        hosts.push(`[${a.address.toLowerCase()}]:${p}`);
      }
    }
  }
  hosts.push(`homeassistant.local:${p}`, `homeassistant:${p}`);
  const name = String(hostname || '').toLowerCase();
  if (name && HOST_RE.test(name) && !name.includes(':')) {
    hosts.push(`${name}:${p}`);
    if (!name.endsWith('.local')) hosts.push(`${name}.local:${p}`);
  }

  const extra = options.allowed_hosts === undefined ? [] : options.allowed_hosts;
  if (!Array.isArray(extra)) throw new Error('allowed_hosts must be a list');
  for (const entry of extra) hosts.push(validateHost(entry));

  const result = [...new Set(hosts)];
  for (const h of result) {
    if (h.includes('*') || h.includes(',') || /\s/.test(h)) {
      throw new Error(`refusing unsafe host entry: ${JSON.stringify(h)}`);
    }
  }
  return result;
}

// Validates a list of CIDRs and returns them normalised as "addr/prefix".
// An undefined list means the defaults; an empty list means "guard off".
function parseNetworks(list) {
  if (list === undefined) list = DEFAULT_NETWORKS;
  if (!Array.isArray(list)) throw new Error('allowed_networks must be a list');
  const out = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || !NETWORK_RE.test(entry)) {
      throw new Error(`invalid allowed_networks entry: ${JSON.stringify(entry)}`);
    }
    const [addr, prefixText] = entry.split('/');
    const family = net.isIP(addr);
    const prefix = Number(prefixText);
    const max = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (max < 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new Error(`invalid allowed_networks entry: ${JSON.stringify(entry)}`);
    }
    try {
      new net.BlockList().addSubnet(addr, prefix, family === 4 ? 'ipv4' : 'ipv6');
    } catch (err) {
      throw new Error(`invalid allowed_networks entry: ${JSON.stringify(entry)} (${err.message})`);
    }
    out.push(`${addr.toLowerCase()}/${prefix}`);
  }
  return [...new Set(out)];
}

function readOptions(file = OPTIONS_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {}; // plain `docker run` without Supervisor
    throw err;
  }
  const options = JSON.parse(text);
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(`${file} does not contain a JSON object`);
  }
  return options;
}

function main(argv) {
  const mode = argv[2];
  const options = readOptions(process.env.ADDON_OPTIONS_FILE || OPTIONS_FILE);
  if (mode === 'hosts') {
    const hosts = computeHosts({
      options,
      interfaces: os.networkInterfaces(),
      hostname: os.hostname(),
      port: process.env.PORT || 3000,
    });
    process.stdout.write(hosts.join(','));
  } else if (mode === 'networks') {
    process.stdout.write(parseNetworks(options.allowed_networks).join(','));
  } else {
    throw new Error('usage: addon-options.cjs hosts|networks');
  }
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`addon-options: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { computeHosts, parseNetworks, readOptions, DEFAULT_NETWORKS, HOST_RE };
