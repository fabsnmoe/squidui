import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../audit/sink.js';
import { actorOf, notFound, requirePermission } from '../http/context.js';
import { AuthenticationProviderRegistry } from '../providers/registry.js';
import { compileCurrentConfiguration, persistConfigVersion } from '../services/configuration.js';
import type { AppContext } from '../server.js';

/** Configuration review: compile, inspect, store (Phase 5/7 slice). */

export async function registerConfigurationRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  /** Read-only preview. Artefacts with secrets are returned redacted. */
  app.get('/configuration/preview', async (request) => {
    requirePermission(request, 'CONFIG_READ');
    const registry = await AuthenticationProviderRegistry.load(db, config);
    const compiled = await compileCurrentConfiguration(db, registry, {
      generatorVersion: config.build.appVersion,
    });

    return {
      squidConf: compiled.squidConf,
      adapterId: compiled.adapterId,
      warnings: compiled.warnings,
      findings: compiled.findings,
      issues: compiled.issues,
      ir: compiled.ir,
      artefacts: compiled.artefacts.map((artefact) => ({
        path: artefact.path,
        mode: artefact.mode,
        owner: artefact.owner,
        group: artefact.group,
        sensitive: artefact.sensitive,
        description: artefact.description,
        lineCount: artefact.content === '' ? 0 : artefact.content.trimEnd().split('\n').length,
        // Password hashes never leave the API, not even to an authorised
        // operator: there is no operational reason to read them.
        content: artefact.sensitive ? null : artefact.content,
      })),
    };
  });

  /** Compiles and stores a version, so review and diff have a baseline. */
  app.post('/configuration/compile', async (request) => {
    const principal = requirePermission(request, 'CONFIG_COMPILE');
    const registry = await AuthenticationProviderRegistry.load(db, config);
    const compiled = await compileCurrentConfiguration(db, registry, {
      generatorVersion: config.build.appVersion,
    });
    const versionId = await persistConfigVersion(db, compiled, principal.username);

    await recordAudit(db, {
      action: 'CONFIG_COMPILED',
      actor: actorOf(request),
      targetType: 'config_version',
      targetId: versionId,
      payload: {
        warnings: compiled.warnings.length,
        findings: compiled.findings.map((finding) => finding.code),
        mode: compiled.ir.authentication.mode,
      },
    });

    return {
      id: versionId,
      warnings: compiled.warnings,
      findings: compiled.findings,
      issues: compiled.issues,
    };
  });

  /**
   * Deployment export: the complete artefact set including the ones the review
   * endpoint redacts.
   *
   * This is the deliberate exception to "password hashes never leave the API".
   * Something has to deliver the NCSA file to the proxy node, and this is that
   * channel - it is what the node agent will consume. It therefore requires
   * CONFIG_DEPLOY (the highest configuration permission), is audited on every
   * call, and is never used by the web UI.
   */
  app.get('/configuration/export', async (request) => {
    const principal = requirePermission(request, 'CONFIG_DEPLOY');
    const registry = await AuthenticationProviderRegistry.load(db, config);
    const compiled = await compileCurrentConfiguration(db, registry, {
      generatorVersion: config.build.appVersion,
      includeSecrets: true,
      secretEncryptionKey: config.secretEncryptionKey,
    });

    await recordAudit(db, {
      action: 'CONFIG_COMPILED',
      actor: actorOf(request),
      targetType: 'config_export',
      payload: {
        export: true,
        artefacts: compiled.artefacts.map((artefact) => artefact.path),
        mode: compiled.ir.authentication.mode,
        requestedBy: principal.username,
      },
    });

    return {
      adapterId: compiled.adapterId,
      generatedAt: compiled.ir.generatedAt,
      squidConf: compiled.squidConf,
      warnings: compiled.warnings,
      findings: compiled.findings,
      artefacts: compiled.artefacts.map((artefact) => ({
        path: artefact.path,
        mode: artefact.mode,
        owner: artefact.owner,
        group: artefact.group,
        sensitive: artefact.sensitive,
        description: artefact.description,
        content: artefact.content,
      })),
    };
  });

  app.get('/configuration/versions', async (request) => {
    requirePermission(request, 'CONFIG_READ');
    const { rows } = await db.query(
      `select id, created_at, created_by, adapter_id,
              jsonb_array_length(warnings) as warning_count,
              jsonb_array_length(findings) as finding_count
       from config_versions order by created_at desc limit 50`,
    );
    return { items: rows, total: rows.length };
  });

  app.get('/configuration/versions/:id', async (request) => {
    requirePermission(request, 'CONFIG_READ');
    const { id } = request.params as { id: string };
    const { rows } = await db.query(
      'select id, created_at, created_by, adapter_id, squid_conf, warnings, findings, ir from config_versions where id = $1',
      [id],
    );
    if (rows.length === 0) throw notFound('Configuration version not found.');
    return rows[0];
  });
}
