import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission, type Permission } from '@scp/shared';
import type { AuditActor } from '../audit/sink.js';
import { verifyToken, type PortalClaims, type SessionClaims } from '../security/jwt.js';

/**
 * Request authentication and authorisation.
 *
 * Routes declare the permission they need. A route that declares none is
 * unreachable for authenticated users by construction, because `requireAuth`
 * is the only way to obtain a principal (threat model T4, fail closed).
 *
 * There are two principal kinds and they never mix:
 *   Principal        a control plane operator, carries RBAC permissions
 *   PortalPrincipal  a proxy user in the self-service portal, carries none
 */

export interface Principal {
  id: string;
  username: string;
  permissions: string[];
}

export interface PortalPrincipal {
  subject: string;
  username: string;
  providerKey: string;
  groups: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    portalPrincipal?: PortalPrincipal;
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required.'): HttpError =>
  new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to do this.'): HttpError =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found.'): HttpError => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message: string): HttpError => new HttpError(409, 'CONFLICT', message);

export function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() ?? request.ip;
  }
  return request.ip;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

export function readPrincipal(request: FastifyRequest, jwtSecret: string): Principal | null {
  const token = bearerToken(request);
  if (!token) return null;
  const verification = verifyToken<SessionClaims>(token, jwtSecret, 'control-plane');
  if (!verification.valid) return null;
  return {
    id: verification.claims.sub,
    username: verification.claims.username,
    permissions: verification.claims.permissions ?? [],
  };
}

export function readPortalPrincipal(request: FastifyRequest, jwtSecret: string): PortalPrincipal | null {
  const token = bearerToken(request);
  if (!token) return null;
  const verification = verifyToken<PortalClaims>(token, jwtSecret, 'proxy-portal');
  if (!verification.valid) return null;
  return {
    subject: verification.claims.sub,
    username: verification.claims.username,
    providerKey: verification.claims.providerKey,
    groups: verification.claims.groups ?? [],
  };
}

export function requireAuth(request: FastifyRequest): Principal {
  if (!request.principal) throw unauthorized();
  return request.principal;
}

/** Self-service portal only. Grants no control plane permission whatsoever. */
export function requirePortalAuth(request: FastifyRequest): PortalPrincipal {
  if (!request.portalPrincipal) throw unauthorized('Sign in with your proxy account.');
  return request.portalPrincipal;
}

export function requirePermission(request: FastifyRequest, permission: Permission): Principal {
  const principal = requireAuth(request);
  if (!hasPermission(principal.permissions, permission)) {
    throw forbidden(`This action requires the ${permission} permission.`);
  }
  return principal;
}

export function actorOf(request: FastifyRequest): AuditActor {
  if (request.principal) {
    return { id: request.principal.id, username: request.principal.username, sourceIp: clientIp(request) };
  }
  if (request.portalPrincipal) {
    // Proxy identities are not control plane users, so the actor id column
    // stays empty; the username is prefixed to keep the two planes readable
    // apart in the audit log.
    return {
      id: null,
      username: `proxy:${request.portalPrincipal.username}`,
      sourceIp: clientIp(request),
    };
  }
  return { id: null, username: null, sourceIp: clientIp(request) };
}

export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof HttpError) {
    return reply
      .status(error.statusCode)
      .send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
  }
  return reply.status(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', details: null },
  });
}
