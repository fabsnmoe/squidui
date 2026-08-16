import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Squid Control Plane node agent.
 *
 * Runs on the proxy host, next to Squid. It pulls: the control plane is never
 * asked to reach into the proxy network, so a node behind NAT or a one-way
 * firewall works exactly like one in the next rack, and adding the tenth node
 * is the same operation as adding the first.
 *
 * Deliberately dependency free - only Node built-ins. An agent that runs on
 * every proxy host is the last place to want a supply chain.
 *
 * Lifecycle:
 *   enrol once with a one-time token -> store the credential
 *   poll -> compare hash -> write artefacts -> validate -> apply -> report
 *
 * A configuration that fails `squid -k parse` is never applied. The node keeps
 * serving its previous configuration and reports the failure instead, because
 * a proxy that stops working is worse than a proxy running yesterday's policy.
 */

const AGENT_VERSION = process.env.AGENT_VERSION ?? '0.1.0';

interface AgentConfig {
  apiUrl: string;
  enrollmentToken: string | null;
  stateDir: string;
  squidBinary: string;
  pollIntervalSeconds: number;
  insecureSkipHostCheck: boolean;
}

interface StoredState {
  agentKey: string;
  nodeId: string;
  nodeName: string;
  appliedHash?: string;
}

interface Artefact {
  path: string;
  content: string;
  mode: string;
  owner: string;
  group: string;
}

interface ConfigBundle {
  configHash: string;
  adapterId: string;
  pollIntervalSeconds: number;
  squidConf: string;
  artefacts: Artefact[];
  squid: { confPath: string; binary: string };
  warnings: Array<{ code: string; message: string }>;
}

type ApplyResult = 'APPLIED' | 'FAILED' | 'VALIDATION_FAILED' | 'UNCHANGED';

/* -------------------------------------------------------------------------- */

function loadConfig(): AgentConfig {
  const apiUrl = (process.env.SCP_API_URL ?? '').replace(/\/+$/, '');
  if (!apiUrl) {
    fail('SCP_API_URL is required, for example https://control-plane.example.internal');
  }
  return {
    apiUrl,
    enrollmentToken: process.env.SCP_ENROLLMENT_TOKEN?.trim() || null,
    stateDir: process.env.SCP_STATE_DIR ?? '/var/lib/scp-agent',
    squidBinary: process.env.SCP_SQUID_BINARY ?? 'squid',
    pollIntervalSeconds: Number(process.env.SCP_POLL_INTERVAL_SECONDS ?? 30) || 30,
    insecureSkipHostCheck: process.env.SCP_INSECURE_SKIP_TLS_VERIFY === 'true',
  };
}

function log(level: 'info' | 'warn' | 'error', message: string, extra?: unknown): void {
  const line = { time: new Date().toISOString(), level, message, ...(extra ? { detail: extra } : {}) };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function fail(message: string): never {
  log('error', message);
  process.exit(78); // EX_CONFIG
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

async function readState(config: AgentConfig): Promise<StoredState | null> {
  try {
    const raw = await readFile(join(config.stateDir, 'state.json'), 'utf8');
    return JSON.parse(raw) as StoredState;
  } catch {
    return null;
  }
}

async function writeState(config: AgentConfig, state: StoredState): Promise<void> {
  await mkdir(config.stateDir, { recursive: true });
  const path = join(config.stateDir, 'state.json');
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  // The file holds the agent credential.
  await chmod(path, 0o600).catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Control plane calls                                                         */
/* -------------------------------------------------------------------------- */

async function call<T>(
  config: AgentConfig,
  path: string,
  options: { method?: string; body?: unknown; agentKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.agentKey) headers['X-Agent-Key'] = options.agentKey;

  const response = await fetch(`${config.apiUrl}/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    let message = `${response.status}`;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* keep the status code */
    }
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return (text ? JSON.parse(text) : null) as T;
}

async function enrol(config: AgentConfig): Promise<StoredState> {
  if (!config.enrollmentToken) {
    fail(
      'This node is not enrolled and SCP_ENROLLMENT_TOKEN is not set. ' +
        'Create the node in the control plane, issue an enrolment token and start the agent with it.',
    );
  }

  const result = await call<{ nodeId: string; nodeName: string; agentKey: string }>(config, '/agent/enroll', {
    method: 'POST',
    body: {
      token: config.enrollmentToken,
      hostname: process.env.SCP_NODE_HOSTNAME ?? process.env.HOSTNAME ?? null,
      agentVersion: AGENT_VERSION,
      squidVersion: detectSquidVersion(config),
    },
  });

  const state: StoredState = {
    agentKey: result.agentKey,
    nodeId: result.nodeId,
    nodeName: result.nodeName,
  };
  await writeState(config, state);
  log('info', `enrolled as node "${result.nodeName}"`);
  return state;
}

/* -------------------------------------------------------------------------- */
/* Squid                                                                       */
/* -------------------------------------------------------------------------- */

let squidProcess: ChildProcess | null = null;

function detectSquidVersion(config: AgentConfig): string | null {
  const result = spawnSync(config.squidBinary, ['-v'], { encoding: 'utf8' });
  const match = /Version (\S+)/.exec(result.stdout ?? '');
  return match?.[1] ?? null;
}

async function writeArtefacts(bundle: ConfigBundle): Promise<void> {
  const confPath = bundle.squid.confPath;
  await mkdir(dirname(confPath), { recursive: true });
  await writeFile(confPath, bundle.squidConf, 'utf8');
  await chmod(confPath, 0o644);

  for (const artefact of bundle.artefacts) {
    await mkdir(dirname(artefact.path), { recursive: true });
    await writeFile(artefact.path, artefact.content, 'utf8');
    await chmod(artefact.path, parseInt(artefact.mode, 8));
    // Ownership, not just mode: Squid drops privileges before starting its
    // authentication helpers, so a file the runtime group cannot read makes
    // every request answer 407.
    const chown = spawnSync('chown', [`${artefact.owner}:${artefact.group}`, artefact.path], { encoding: 'utf8' });
    if (chown.status !== 0) {
      log('warn', `could not set ownership on ${artefact.path}`, chown.stderr?.trim());
    }
  }
}

function validate(config: AgentConfig, confPath: string): { ok: boolean; output: string } {
  const result = spawnSync(config.squidBinary, ['-k', 'parse', '-f', confPath], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const fatal = /(^|\| )(FATAL|ERROR)/m.test(output);
  return { ok: !fatal && result.status === 0, output: output.trim() };
}

function squidIsRunning(): boolean {
  return squidProcess !== null && squidProcess.exitCode === null && !squidProcess.killed;
}

function startSquid(config: AgentConfig, confPath: string): void {
  log('info', 'starting squid');
  squidProcess = spawn(config.squidBinary, ['-N', '-d', '1', '-f', confPath], { stdio: 'inherit' });
  squidProcess.on('exit', (code, signal) => {
    log(code === 0 ? 'info' : 'error', `squid exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
    squidProcess = null;
  });
}

function reconfigureSquid(config: AgentConfig, confPath: string): boolean {
  const result = spawnSync(config.squidBinary, ['-k', 'reconfigure', '-f', confPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    log('warn', 'squid -k reconfigure failed', `${result.stdout ?? ''}${result.stderr ?? ''}`.trim());
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Apply cycle                                                                 */
/* -------------------------------------------------------------------------- */

async function applyBundle(
  config: AgentConfig,
  state: StoredState,
  bundle: ConfigBundle,
): Promise<{ result: ApplyResult; message: string }> {
  const unchanged = state.appliedHash === bundle.configHash && squidIsRunning();
  if (unchanged) return { result: 'UNCHANGED', message: 'Configuration already applied.' };

  for (const warning of bundle.warnings) {
    log('warn', `compiler warning ${warning.code}`, warning.message);
  }

  const stagingPath = `${bundle.squid.confPath}.staged`;
  try {
    await writeArtefacts({ ...bundle, squid: { ...bundle.squid, confPath: stagingPath } });
  } catch (error) {
    return {
      result: 'FAILED',
      message: `Could not write the configuration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Validate the staged file before it becomes the live one. A broken config is
  // never applied; the node keeps running what it already had.
  const validation = validate(config, stagingPath);
  if (!validation.ok) {
    log('error', 'generated configuration failed validation, keeping the previous one');
    return { result: 'VALIDATION_FAILED', message: validation.output.slice(0, 2000) };
  }

  await writeFile(bundle.squid.confPath, bundle.squidConf, 'utf8');
  await chmod(bundle.squid.confPath, 0o644);

  if (!squidIsRunning()) {
    startSquid(config, bundle.squid.confPath);
    // Give it a moment to bind before reporting success.
    await sleep(1500);
    if (!squidIsRunning()) {
      return { result: 'FAILED', message: 'Squid exited immediately after start.' };
    }
  } else if (!reconfigureSquid(config, bundle.squid.confPath)) {
    return { result: 'FAILED', message: 'squid -k reconfigure failed; see the node logs.' };
  }

  state.appliedHash = bundle.configHash;
  await writeState(config, state);
  log('info', `applied configuration ${bundle.configHash.slice(0, 12)}`);
  return { result: 'APPLIED', message: `Applied configuration ${bundle.configHash.slice(0, 12)}.` };
}

async function report(
  config: AgentConfig,
  state: StoredState,
  result: ApplyResult,
  message: string,
  configHash: string | null,
): Promise<void> {
  try {
    await call(config, '/agent/status', {
      method: 'POST',
      agentKey: state.agentKey,
      body: {
        result,
        message,
        configHash,
        agentVersion: AGENT_VERSION,
        squidVersion: detectSquidVersion(config),
        squidRunning: squidIsRunning(),
      },
    });
  } catch (error) {
    log('warn', 'could not report status', error instanceof Error ? error.message : String(error));
  }
}

/* -------------------------------------------------------------------------- */
/* Main loop                                                                   */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.insecureSkipHostCheck) {
    log('warn', 'TLS verification is disabled. Use this only against a test control plane.');
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  let state = (await readState(config)) ?? (await enrol(config));
  log('info', `agent ${AGENT_VERSION} started for node "${state.nodeName}"`, { apiUrl: config.apiUrl });

  const shutdown = (signal: string): void => {
    log('info', `received ${signal}, stopping squid`);
    squidProcess?.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  let interval = config.pollIntervalSeconds;

  for (;;) {
    try {
      const bundle = await call<ConfigBundle>(config, '/agent/config', { agentKey: state.agentKey });
      interval = bundle.pollIntervalSeconds || interval;

      const outcome = await applyBundle(config, state, bundle);
      await report(config, state, outcome.result, outcome.message, bundle.configHash);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401) {
        // The credential was revoked in the control plane. Re-enrol if we still
        // have a token, otherwise say plainly what an operator has to do.
        log('error', 'the agent credential was rejected');
        if (config.enrollmentToken) {
          try {
            state = await enrol(config);
            continue;
          } catch (enrolError) {
            log('error', 're-enrolment failed', enrolError instanceof Error ? enrolError.message : String(enrolError));
          }
        } else {
          log('error', 'issue a new enrolment token in the control plane and restart the agent with it');
        }
      } else {
        log('warn', 'control plane unreachable, keeping the current configuration',
          error instanceof Error ? error.message : String(error));
      }
    }

    await sleep(interval * 1000);
  }
}

main().catch((error: unknown) => {
  log('error', 'agent stopped', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
