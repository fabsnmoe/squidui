import { BUILTIN_ROLES } from '@scp/shared';
import { hashControlPlanePassword, hashProxyPassword } from '@scp/shared/crypt';
import type { AppConfig } from './config.js';
import { withTransaction, type Db } from './db/pool.js';

/**
 * Idempotent bootstrap, run as part of the migrate step.
 *
 * Creates what an empty installation needs to be usable: the built-in roles,
 * one control plane administrator, the local proxy authentication provider and
 * a default listener. Running it twice changes nothing.
 */

export async function bootstrap(
  db: Db,
  config: AppConfig,
  log: (message: string) => void,
): Promise<string[]> {
  const summary: string[] = [];

  await withTransaction(db, async (client) => {
    // --- built-in roles ----------------------------------------------------
    for (const role of BUILTIN_ROLES) {
      const { rows } = await client.query<{ id: string }>(
        `insert into cp_roles (name, description, builtin)
         values ($1, $2, true)
         on conflict (name) do update set description = excluded.description
         returning id`,
        [role.name, role.description],
      );
      const roleId = rows[0]?.id;
      if (!roleId) continue;

      // Permissions of built-in roles are owned by the code, not the database:
      // replace them so a new release can add permissions to existing roles.
      await client.query('delete from cp_role_permissions where role_id = $1', [roleId]);
      for (const permission of role.permissions) {
        await client.query(
          'insert into cp_role_permissions (role_id, permission) values ($1, $2) on conflict do nothing',
          [roleId, permission],
        );
      }
    }
    summary.push(`${BUILTIN_ROLES.length} built-in roles ensured`);

    // --- bootstrap administrator ------------------------------------------
    const { rows: userCount } = await client.query<{ count: string }>('select count(*)::text as count from cp_users');
    if ((userCount[0]?.count ?? '0') === '0') {
      if (!config.bootstrapAdminPassword) {
        log(
          'WARNING: no control plane user exists and BOOTSTRAP_ADMIN_PASSWORD is not set. ' +
            'Set it in .env and run the migrate step again.',
        );
        summary.push('administrator NOT created (BOOTSTRAP_ADMIN_PASSWORD missing)');
      } else {
        const { rows } = await client.query<{ id: string }>(
          `insert into cp_users (username, display_name, password_hash, must_change_password)
           values ($1, $2, $3, true)
           returning id`,
          [
            config.bootstrapAdminUsername,
            'Bootstrap administrator',
            hashControlPlanePassword(config.bootstrapAdminPassword),
          ],
        );
        const adminId = rows[0]?.id;
        await client.query(
          `insert into cp_user_roles (user_id, role_id)
           select $1, id from cp_roles where name = 'Administrator'`,
          [adminId],
        );
        summary.push(`administrator "${config.bootstrapAdminUsername}" created`);
      }
    }

    // --- local proxy authentication provider -------------------------------
    // Always present: it is the provider that keeps working when LDAP is down
    // (PRODUCT.md section 20).
    await client.query(
      `insert into auth_providers (key, type, name, enabled, priority, config)
       values ('local', 'LOCAL', 'Local users', true, 10, '{}'::jsonb)
       on conflict (key) do nothing`,
    );
    summary.push('local provider ensured');

    // --- default listener profile ------------------------------------------
    // listener_profiles is the source of truth since ADR 0003; the legacy
    // listeners table is retained for rollback only and is no longer read.
    // Writing the default there instead left a fresh installation with no
    // listener at all, so the compiler produced a configuration without a
    // single http_port and Squid would not have accepted any traffic.
    const { rows: profileCount } = await client.query<{ count: string }>(
      'select count(*)::text as count from listener_profiles',
    );
    if ((profileCount[0]?.count ?? '0') === '0') {
      await client.query(
        `insert into listener_profiles
           (name, description, address, port, mode, enabled, authentication_mode, group_id)
         values ('Default forward proxy', 'Created during installation.',
                 '0.0.0.0', 3128, 'FORWARD', true, 'INHERIT', null)`,
      );
      summary.push('default listener profile created');
    }
  });

  if (config.seedDemoData) {
    const seeded = await seedDemoData(db);
    if (seeded) summary.push('demo data seeded');
  }

  return summary;
}

/**
 * Example data for evaluation environments. Guarded by SEED_DEMO_DATA and
 * skipped as soon as any rule exists, so it can never overwrite real config.
 */
async function seedDemoData(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ count: string }>('select count(*)::text as count from access_rules');
  if ((rows[0]?.count ?? '0') !== '0') return false;

  await withTransaction(db, async (client) => {
    const networks = [
      ['Office network', 'Employee workstations', ['10.10.0.0/16']],
      ['Guest network', 'Visitor Wi-Fi, no credentials expected', ['10.20.0.0/24']],
      ['Lab network', 'Test systems', ['10.30.0.0/24']],
    ] as const;
    const networkIds = new Map<string, string>();
    for (const [name, description, cidrs] of networks) {
      const { rows: inserted } = await client.query<{ id: string }>(
        `insert into networks (name, description, cidrs) values ($1, $2, $3)
         on conflict (name) do update set description = excluded.description
         returning id`,
        [name, description, cidrs],
      );
      if (inserted[0]) networkIds.set(name, inserted[0].id);
    }

    const groups = ['Administrators', 'Developers', 'Employees', 'Guests', 'Service accounts'];
    const groupIds = new Map<string, string>();
    for (const name of groups) {
      const { rows: inserted } = await client.query<{ id: string }>(
        `insert into proxy_groups (name, source, description)
         values ($1, 'LOCAL', 'Seeded example group')
         on conflict do nothing
         returning id`,
        [name],
      );
      if (inserted[0]) groupIds.set(name, inserted[0].id);
    }

    const demoUsers = [
      ['proxy-admin', 'Proxy administrator', 'Administrators'],
      ['service-api', 'Service account for the API gateway', 'Service accounts'],
      ['test-user', 'Lab test account', 'Developers'],
    ] as const;
    for (const [username, displayName, group] of demoUsers) {
      const { rows: inserted } = await client.query<{ id: string }>(
        `insert into proxy_users (username, display_name, description, status, password_hash, password_format, password_updated_at)
         values ($1, $2, 'Seeded example user', 'ACTIVE', $3, 'sha512-crypt', now())
         on conflict do nothing
         returning id`,
        [username, displayName, hashProxyPassword(`demo-${username}-password`)],
      );
      const userId = inserted[0]?.id;
      const groupId = groupIds.get(group);
      if (userId && groupId) {
        await client.query(
          'insert into proxy_user_groups (user_id, group_id) values ($1, $2) on conflict do nothing',
          [userId, groupId],
        );
      }
    }

    const guestId = networkIds.get('Guest network');
    await client.query(
      `insert into access_rules (position, name, description, action, source, identity, destination, schedule)
       values
         (10, 'Guests without credentials', 'Anonymous guest access to the web',
          'ALLOW',
          $1::jsonb,
          '{"kind":"UNAUTHENTICATED"}'::jsonb,
          '{"kind":"SPECIFIC","ports":[80,443]}'::jsonb,
          '{"kind":"ALWAYS"}'::jsonb),
         (20, 'Authenticated employees', 'Any authenticated user may reach the internet',
          'ALLOW',
          '{"kind":"ANY"}'::jsonb,
          '{"kind":"AUTHENTICATED"}'::jsonb,
          '{"kind":"ANY"}'::jsonb,
          '{"kind":"ALWAYS"}'::jsonb),
         (30, 'Deny everything else', 'Explicit final deny',
          'DENY',
          '{"kind":"ANY"}'::jsonb,
          '{"kind":"ANY"}'::jsonb,
          '{"kind":"ANY"}'::jsonb,
          '{"kind":"ALWAYS"}'::jsonb)`,
      [guestId ? JSON.stringify({ kind: 'NETWORKS', networkIds: [guestId] }) : '{"kind":"ANY"}'],
    );

    await client.query(
      `insert into proxy_nodes (name, hostname, status, squid_version, last_seen_at)
       values ('proxy-de-01', 'proxy-de-01.example.internal', 'UNKNOWN', '6.6', null)
       on conflict (name) do nothing`,
    );
  });

  return true;
}
