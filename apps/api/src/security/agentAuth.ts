import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credentials for proxy node agents.
 *
 * Agents are the third principal kind, next to control plane operators and
 * portal users, and they are deliberately not JWTs: an agent credential is
 * long lived, revocable per node, and must survive a control plane restart
 * without the agent re-enrolling.
 *
 * Only hashes are stored. A leaked database row must not let anyone enrol a
 * node or impersonate one, so the plaintext exists exactly once - in the
 * response that hands it to the operator or the agent.
 */

/** `scpe_` for an enrolment token, `scpa_` for an agent key. */
export type CredentialKind = 'enrollment' | 'agent';

const PREFIX: Record<CredentialKind, string> = {
  enrollment: 'scpe_',
  agent: 'scpa_',
};

export function generateCredential(kind: CredentialKind): { plaintext: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `${PREFIX[kind]}${secret}`;
  return { plaintext, hash: hashCredential(plaintext) };
}

/**
 * SHA-256 without a salt on purpose: the input is 256 bits of entropy we
 * generated ourselves, so there is nothing to brute force and lookups have to
 * stay a single indexed query.
 */
export function hashCredential(plaintext: string): string {
  return createHash('sha256').update(plaintext.trim()).digest('hex');
}

export function looksLike(kind: CredentialKind, value: string): boolean {
  return value.trim().startsWith(PREFIX[kind]);
}

export function credentialsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Fingerprint shown in the UI so an operator can tell two credentials apart. */
export function fingerprint(hash: string): string {
  return hash.slice(0, 8);
}

/**
 * Hash of everything that would be written to a node. Comparing it to what an
 * agent last reported is how configuration drift becomes visible without
 * transferring the configuration itself.
 *
 * The generated header carries a compile timestamp, which changes on every
 * call. Including it would make no node ever count as in sync and would make
 * agents reapply - and reconfigure Squid - on every single poll, so the hash is
 * taken over the configuration with that line normalised away.
 */
export function configurationHash(
  squidConf: string,
  artefacts: ReadonlyArray<{ path: string; content: string; mode: string; owner: string; group: string }>,
): string {
  const hash = createHash('sha256');
  hash.update(stripVolatileHeader(squidConf));
  for (const artefact of [...artefacts].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`\0${artefact.path}\0${artefact.mode}\0${artefact.owner}:${artefact.group}\0${artefact.content}`);
  }
  return hash.digest('hex');
}

/** Removes the lines that differ between two compilations of the same policy. */
export function stripVolatileHeader(squidConf: string): string {
  return squidConf
    .split('\n')
    .filter((line) => !/^#\s*Generated:/.test(line))
    .join('\n');
}
