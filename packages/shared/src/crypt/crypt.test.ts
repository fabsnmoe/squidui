import { describe, expect, it } from 'vitest';
import {
  generateCryptSalt,
  hashControlPlanePassword,
  hashProxyPassword,
  proxyHashFormatOf,
  validatePasswordStrength,
  verifyControlPlanePassword,
  verifyProxyPassword,
} from './index.js';
import { md5Crypt } from './md5crypt.js';
import { sha512Crypt } from './sha512crypt.js';

/*
 * Known answer vectors produced with OpenSSL 3.2.1:
 *   openssl passwd -6 -salt <salt> <password>
 *   openssl passwd -1 -salt <salt> <password>
 * If these ever fail, the generated NCSA file would be rejected by
 * basic_ncsa_auth - which is exactly the regression this guards against.
 */

describe('sha512-crypt', () => {
  const vectors: Array<[password: string, salt: string, expected: string]> = [
    [
      'Hello world!',
      'saltstring',
      '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1',
    ],
    [
      'S3cr3t!Pass',
      'Xy9Zq2LmAbCdEfGh',
      '$6$Xy9Zq2LmAbCdEfGh$LEqjCJwuORYUg4bJftKEQ9Sh6LZLl3bFNmgntd02gvVUU2P9BUVwKSSacPUFvVBA3OVk7tXasXf7o2HYsAdTl1',
    ],
    [
      'a',
      'short',
      '$6$short$H.b6NeQvCMQ5GOPvzn5zXXcNUM2w0yE5a8Oal0EJetFKvqFQ6m2H7Mqzyppvg98IIRXVxUXmgh7oCMe8z/7hP0',
    ],
    [
      '0123456789012345678901234567890123456789012345678901234567890123456789',
      '0123456789abcdef',
      '$6$0123456789abcdef$92V1lmmUsdy74JtYW.M6ouuLBSlI2gtawAaFFmKrcekePxEh1F7y2HytqbcOdZU.6E8fCMcUnWg6frtvloKHW.',
    ],
  ];

  it.each(vectors)('matches the reference implementation for %j', (password, salt, expected) => {
    expect(sha512Crypt(password, salt)).toBe(expected);
  });

  it('supports an explicit round count', () => {
    expect(sha512Crypt('the quick brown fox', 'roundsarehere', { rounds: 10000 })).toBe(
      '$6$rounds=10000$roundsarehere$NIj4PDD8PCwA9bs6thYSzD7myiYo2zmNMkjLJlEO9IUp5Q62ExHRqX9cMX7DhVE8Km7jNdF9Fc7Dg4kpryH4V.',
    );
  });

  it('truncates the salt to 16 characters like crypt(3) does', () => {
    expect(sha512Crypt('pw', '0123456789abcdefIGNORED')).toBe(sha512Crypt('pw', '0123456789abcdef'));
  });
});

describe('md5-crypt', () => {
  const vectors: Array<[password: string, salt: string, expected: string]> = [
    ['password', 'abcdefgh', '$1$abcdefgh$G//4keteveJp0qb8z2DxG/'],
    ['S3cr3t!Pass', 'Xy9Zq2Lm', '$1$Xy9Zq2Lm$KmPrZQFI3D1okUROGPVcF0'],
    ['', 'salt', '$1$salt$UsdFqFVB.FsuinRDK5eE..'],
  ];

  it.each(vectors)('matches the reference implementation for %j', (password, salt, expected) => {
    expect(md5Crypt(password, salt)).toBe(expected);
  });
});

describe('proxy password handling', () => {
  it('round trips a sha512-crypt password', () => {
    const hash = hashProxyPassword('correct horse battery staple');
    expect(hash.startsWith('$6$')).toBe(true);
    expect(proxyHashFormatOf(hash)).toBe('sha512-crypt');
    expect(verifyProxyPassword('correct horse battery staple', hash)).toBe(true);
    expect(verifyProxyPassword('wrong password entirely', hash)).toBe(false);
  });

  it('round trips an md5-crypt password', () => {
    const hash = hashProxyPassword('correct horse battery staple', 'md5-crypt');
    expect(hash.startsWith('$1$')).toBe(true);
    expect(proxyHashFormatOf(hash)).toBe('md5-crypt');
    expect(verifyProxyPassword('correct horse battery staple', hash)).toBe(true);
    expect(verifyProxyPassword('Correct horse battery staple', hash)).toBe(false);
  });

  it('never produces the same hash twice for the same password', () => {
    expect(hashProxyPassword('same password')).not.toBe(hashProxyPassword('same password'));
  });

  it('verifies hashes that carry an explicit round count', () => {
    const hash = sha512Crypt('rounds matter', generateCryptSalt(16), { rounds: 6000 });
    expect(hash).toContain('rounds=6000');
    expect(verifyProxyPassword('rounds matter', hash)).toBe(true);
    expect(verifyProxyPassword('rounds matte', hash)).toBe(false);
  });

  it('rejects unknown or malformed hash formats instead of throwing', () => {
    expect(verifyProxyPassword('x', '')).toBe(false);
    expect(verifyProxyPassword('x', '$2y$10$notbcryptsupported')).toBe(false);
    expect(verifyProxyPassword('x', '$6$nodollarterminator')).toBe(false);
  });

  it('draws salts only from the crypt alphabet', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generateCryptSalt(16)).toMatch(/^[./0-9A-Za-z]{16}$/);
    }
  });
});

describe('control plane password handling', () => {
  it('round trips', () => {
    const stored = hashControlPlanePassword('control-plane-password');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyControlPlanePassword('control-plane-password', stored)).toBe(true);
    expect(verifyControlPlanePassword('control-plane-passwore', stored)).toBe(false);
  });

  it('rejects malformed stored values without throwing', () => {
    expect(verifyControlPlanePassword('x', 'nonsense')).toBe(false);
    expect(verifyControlPlanePassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
    expect(verifyControlPlanePassword('x', 'scrypt$32768$8$1$$')).toBe(false);
  });

  it('does not leak the plaintext into the stored value', () => {
    const stored = hashControlPlanePassword('leaky-password-value');
    expect(stored).not.toContain('leaky-password-value');
  });
});

describe('password policy', () => {
  it('accepts a reasonable password', () => {
    expect(validatePasswordStrength('a-perfectly-fine-password')).toEqual([]);
  });

  it('rejects short, repeated and whitespace padded passwords', () => {
    expect(validatePasswordStrength('short').map((v) => v.code)).toContain('TOO_SHORT');
    expect(validatePasswordStrength('aaaaaaaaaaaaaaaa').map((v) => v.code)).toContain(
      'REPEATED_CHARACTER',
    );
    expect(validatePasswordStrength(' padded password ').map((v) => v.code)).toContain(
      'SURROUNDING_WHITESPACE',
    );
  });
});
