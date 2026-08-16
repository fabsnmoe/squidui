#!/usr/bin/env node
/*
 * Exports the generated Squid configuration to a directory.
 *
 *   node scripts/export-config.mjs --base http://localhost:8080 \
 *        --user admin --password ... --out ./tmp/squid-test
 *
 * This is the manual stand-in for the node agent: it fetches the compiled
 * artefacts through the audited /configuration/export endpoint and writes them
 * with the file modes the compiler asked for.
 *
 * The exported password file contains crypt(3) hashes. Write it somewhere only
 * root and the proxy user can read.
 */

import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

const base = arg('base', process.env.SCP_BASE_URL ?? 'http://localhost:8080');
const username = arg('user', process.env.SCP_ADMIN_USER ?? 'admin');
const password = arg('password', process.env.SCP_ADMIN_PASSWORD ?? '');
const out = resolve(arg('out', './tmp/squid-export'));
/** Strips the leading node path so artefacts land under --out. */
const strip = arg('strip', '/etc/squid/scp');

if (!password) {
  process.stderr.write('A password is required: --password or SCP_ADMIN_PASSWORD.\n');
  process.exit(2);
}

async function main() {
  const login = await fetch(`${base}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!login.ok) {
    throw new Error(`sign in failed with status ${login.status}`);
  }
  const { token } = await login.json();

  const response = await fetch(`${base}/api/v1/configuration/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`export failed with status ${response.status}: ${body}`);
  }
  const config = await response.json();

  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'squid.conf'), config.squidConf, 'utf8');
  process.stdout.write(`wrote ${join(out, 'squid.conf')}\n`);

  for (const artefact of config.artefacts) {
    const relative = artefact.path.startsWith(strip)
      ? artefact.path.slice(strip.length).replace(/^\/+/, '')
      : artefact.path.replace(/^\/+/, '');
    const target = join(out, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artefact.content ?? '', 'utf8');
    try {
      await chmod(target, parseInt(artefact.mode, 8));
    } catch {
      // Windows and some bind mounts do not support POSIX modes; the file is
      // still written, which is what matters for a test run.
    }
    process.stdout.write(`wrote ${target} (${artefact.mode} ${artefact.owner}:${artefact.group})\n`);
  }

  // Ownership matters as much as the mode: Squid starts its helpers after
  // dropping privileges, so a file the runtime group cannot read makes every
  // request answer 407. The manifest is what a deployment step applies.
  const manifest = config.artefacts
    .map((artefact) => `chown ${artefact.owner}:${artefact.group} ${artefact.path}\nchmod ${artefact.mode} ${artefact.path}`)
    .join('\n');
  if (manifest) {
    await writeFile(join(out, 'apply-ownership.sh'), `#!/bin/sh\nset -eu\n${manifest}\n`, 'utf8');
    process.stdout.write(`\nRun on the proxy node after copying the files:\n${manifest}\n`);
  }

  if (config.warnings.length > 0) {
    process.stdout.write(`\n${config.warnings.length} compiler warning(s):\n`);
    for (const warning of config.warnings) {
      process.stdout.write(`  ${warning.code}: ${warning.message}\n`);
    }
  }
  for (const finding of config.findings) {
    process.stdout.write(`\n[${finding.severity}] ${finding.title}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
