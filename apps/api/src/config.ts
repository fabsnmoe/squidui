import { isProxyPasswordFormat, type ProxyPasswordFormat } from '@scp/shared/crypt';

/**
 * Environment configuration.
 *
 * Fails fast and loudly: a control plane that starts with a placeholder JWT
 * secret is worse than one that refuses to start.
 */

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  host: string;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string | null;
  jwtSecret: string;
  jwtTtlSeconds: number;
  secretEncryptionKey: Buffer;
  proxyPasswordFormat: ProxyPasswordFormat;
  bootstrapAdminUsername: string;
  bootstrapAdminPassword: string | null;
  seedDemoData: boolean;
  build: {
    appVersion: string;
    gitSha: string;
    buildDate: string;
  };
}

export class ConfigError extends Error {}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new ConfigError(`${name} is required but not set. See .env.example.`);
  }
  return value;
}

function optionalNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PLACEHOLDER_SECRETS = [
  'change-me',
  'change-me-jwt-secret-at-least-32-characters',
  'changeme',
  'secret',
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'production') as AppConfig['nodeEnv'];

  const jwtSecret = required('JWT_SECRET', env.JWT_SECRET);
  if (jwtSecret.length < 32) {
    throw new ConfigError('JWT_SECRET must be at least 32 characters long.');
  }
  if (nodeEnv === 'production' && PLACEHOLDER_SECRETS.includes(jwtSecret.toLowerCase())) {
    throw new ConfigError('JWT_SECRET still holds the example value. Generate one: openssl rand -base64 32');
  }

  const encryptionKeyText = required('SECRET_ENCRYPTION_KEY', env.SECRET_ENCRYPTION_KEY);
  const secretEncryptionKey = Buffer.from(encryptionKeyText, 'base64');
  if (secretEncryptionKey.length !== 32) {
    throw new ConfigError(
      'SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes. Generate one: openssl rand -base64 32',
    );
  }

  const formatText = env.PROXY_PASSWORD_HASH_FORMAT ?? 'sha512-crypt';
  if (!isProxyPasswordFormat(formatText)) {
    throw new ConfigError(
      `PROXY_PASSWORD_HASH_FORMAT must be sha512-crypt or md5-crypt, got "${formatText}".`,
    );
  }

  return {
    nodeEnv,
    port: optionalNumber(env.API_PORT, 3000),
    host: env.API_HOST ?? '0.0.0.0',
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: required('DATABASE_URL', env.DATABASE_URL),
    redisUrl: env.REDIS_URL ?? null,
    jwtSecret,
    jwtTtlSeconds: optionalNumber(env.JWT_TTL_SECONDS, 12 * 60 * 60),
    secretEncryptionKey,
    proxyPasswordFormat: formatText,
    bootstrapAdminUsername: env.BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
    bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD?.trim() || null,
    seedDemoData: (env.SEED_DEMO_DATA ?? 'false').toLowerCase() === 'true',
    build: {
      appVersion: env.APP_VERSION ?? '0.0.0-dev',
      gitSha: env.GIT_SHA ?? 'unknown',
      buildDate: env.BUILD_DATE ?? 'unknown',
    },
  };
}
