/**
 * Public surface of the domain core.
 *
 * This entry point must stay free of Node-only imports so the web bundle can
 * consume it. Password hashing lives behind `@scp/shared/crypt`.
 */

export * from './auth/model.js';
export * from './policy/ir.js';
export * from './policy/engine.js';
export * from './policy/openProxy.js';
export * from './policy/accessProfile.js';
export * from './squid/adapter.js';
export * from './squid/compiler.js';
export * from './squid/accessLog.js';
export * from './net/ip.js';
export * from './permissions.js';
export * from './audit.js';
