import { Navigate, Route, Routes } from 'react-router-dom';
import type { Permission } from '@scp/shared';
import { EmptyState, Page, PageHeader } from '@scp/ui';
import { useSession } from './lib/session.js';
import { usePortal } from './lib/portal.js';
import { AppShell } from './shell/AppShell.js';
import { LoginPage } from './pages/LoginPage.js';
import { PortalApp } from './pages/portal/PortalApp.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { AuthenticationOverviewPage } from './pages/authentication/OverviewPage.js';
import { ProvidersPage } from './pages/authentication/ProvidersPage.js';
import { LocalUsersPage } from './pages/authentication/LocalUsersPage.js';
import { ProxyGroupsPage } from './pages/authentication/GroupsPage.js';
import { AuthenticationTestPage } from './pages/authentication/TestPage.js';
import { AccessRulesPage } from './pages/policies/AccessRulesPage.js';
import { NetworksPage } from './pages/policies/NetworksPage.js';
import { ListenersPage } from './pages/ListenersPage.js';
import { NodeGroupsPage } from './pages/NodeGroupsPage.js';
import { NodesPage } from './pages/NodesPage.js';
import { ConfigurationReviewPage } from './pages/ConfigurationReviewPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

function Guard({ permission, children }: { permission: Permission; children: JSX.Element }): JSX.Element {
  const { can } = useSession();
  if (can(permission)) return children;
  return (
    <Page>
      <PageHeader title="Not available" description="You do not have permission to view this page." />
      <EmptyState
        icon="shield"
        title="Missing permission"
        description={`This page requires the ${permission} permission. Ask a control plane administrator to grant it.`}
      />
    </Page>
  );
}

export function App(): JSX.Element {
  const { user, loading } = useSession();
  const { user: portalUser, loading: portalLoading } = usePortal();

  if (loading || portalLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <span className="scp-spinner" style={{ width: 24, height: 24 }} aria-label="Loading" />
      </div>
    );
  }

  // A proxy identity gets the self-service portal and nothing else. The two
  // shells never coexist, so no control plane route is even mounted for them.
  if (portalUser) {
    return (
      <Routes>
        <Route path="*" element={<PortalApp />} />
      </Routes>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route
          index
          element={
            <Guard permission="DASHBOARD_READ">
              <DashboardPage />
            </Guard>
          }
        />
        <Route
          path="nodes"
          element={
            <Guard permission="NODE_READ">
              <NodesPage />
            </Guard>
          }
        />
        <Route
          path="listeners"
          element={
            <Guard permission="LISTENER_READ">
              <ListenersPage />
            </Guard>
          }
        />
        <Route
          path="policies/rules"
          element={
            <Guard permission="POLICY_READ">
              <AccessRulesPage />
            </Guard>
          }
        />
        <Route
          path="policies/networks"
          element={
            <Guard permission="POLICY_READ">
              <NetworksPage />
            </Guard>
          }
        />
        <Route
          path="authentication"
          element={
            <Guard permission="PROXY_AUTH_READ">
              <AuthenticationOverviewPage />
            </Guard>
          }
        />
        <Route
          path="authentication/providers"
          element={
            <Guard permission="AUTH_PROVIDER_READ">
              <ProvidersPage />
            </Guard>
          }
        />
        <Route
          path="authentication/users"
          element={
            <Guard permission="PROXY_USER_READ">
              <LocalUsersPage />
            </Guard>
          }
        />
        <Route
          path="authentication/groups"
          element={
            <Guard permission="PROXY_GROUP_READ">
              <ProxyGroupsPage />
            </Guard>
          }
        />
        <Route
          path="authentication/test"
          element={
            <Guard permission="AUTH_PROVIDER_TEST">
              <AuthenticationTestPage />
            </Guard>
          }
        />
        <Route
          path="node-groups"
          element={
            <Guard permission="NODE_READ">
              <NodeGroupsPage />
            </Guard>
          }
        />
        <Route
          path="configuration/review"
          element={
            <Guard permission="CONFIG_READ">
              <ConfigurationReviewPage />
            </Guard>
          }
        />
        <Route
          path="observability/logs"
          element={
            <Guard permission="TRAFFIC_READ">
              <LogsPage />
            </Guard>
          }
        />
        <Route
          path="system/audit"
          element={
            <Guard permission="AUDIT_READ">
              <AuditPage />
            </Guard>
          }
        />
        <Route path="system/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
