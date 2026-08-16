# ADR 0002 — crypt(3) password formats for local proxy users

Status: accepted
Date: 2026-08-16

## Context

`PRODUCT.md` §15 requires that proxy passwords are never stored in plaintext
and that the stored format is one the deployed Squid authentication helper can
actually verify. The concrete format is explicitly declared part of the
authentication/Squid version adapter.

Squid's `basic_ncsa_auth` verifies an htpasswd-style file using the platform
`crypt(3)`. On glibc that includes `$6$` (SHA-512-crypt) and `$1$`
(MD5-crypt); musl based images support the same two. bcrypt (`$2y$`) is *not*
supported by `basic_ncsa_auth` on all platforms, and Argon2 is not supported at
all — so the strongest generally available option is SHA-512-crypt.

## Decision

- `packages/shared/src/crypto` implements `sha512-crypt` and `md5-crypt` in
  pure TypeScript on top of `node:crypto` digests.
- `sha512-crypt` with 5000 rounds (the crypt(3) default, no `rounds=` prefix,
  maximum helper compatibility) is the default; `md5-crypt` is selectable via
  `PROXY_PASSWORD_HASH_FORMAT` for legacy helpers.
- The stored hash string carries its own format marker (`$6$`, `$1$`), so a
  future format change does not invalidate existing users.
- Both implementations are verified against known-answer vectors produced by
  `openssl passwd -6` / `openssl passwd -1`.

## Consequences

- Positive: the generated NCSA file is consumed by stock `basic_ncsa_auth`
  with no custom helper and no native dependency in the image.
- Positive: control plane passwords are unaffected and use `scrypt`, which is
  stronger, because no external helper has to verify them.
- Negative: SHA-512-crypt at 5000 rounds is weaker than a modern memory-hard
  KDF. This is a constraint of the Squid helper, not a free choice. Mitigation:
  hashes are never exposed through the API and never leave the database.
- Follow-up: if a future adapter targets a helper with better support
  (e.g. a custom helper speaking to the API), add it as a new format rather
  than replacing the existing ones.
