# Entwicklungs- und Umsetzungsplan

## Squid Control Plane – Ergänzungen v1.1

**Dokumentversion:** 1.1
**Status:** verbindliche Entwicklungsbaseline

Alle bisherigen Phasen bleiben bestehen. Folgende Änderungen werden verbindlich ergänzt.

---

# 1. Neue Architektur-Gates

Zusätzlich zu den bisherigen Gates gelten:

## Gate H – Docker Compose First

Kein Release gilt als lauffähig, solange die vollständige Control Plane nicht mittels:

```bash
docker compose build
docker compose up -d
```

aus dem Repository gestartet werden kann.

---

## Gate I – Local Image Build

Kein Deployment darf voraussetzen, dass selbst entwickelte Images aus Docker Hub, GHCR oder einer anderen Registry gezogen werden.

Registry-Support kann später ergänzt werden.

Der lokale Build auf dem Server ist Pflicht.

---

## Gate J – Design System First

Feature-Agenten dürfen keine individuellen Seitenlayouts oder lokalen UI-Designs entwickeln.

Alle UI-Features müssen das gemeinsame Designsystem verwenden.

---

# 2. Phase 0 ergänzen – UI Architecture

Vor Beginn der eigentlichen UI-Implementierung müssen folgende Artefakte existieren:

```text
docs/design/
├── design-principles.md
├── navigation.md
├── layout.md
├── colors.md
├── typography.md
├── components.md
├── interaction-patterns.md
└── accessibility.md
```

---

# 3. UI Design Tokens

Zentrale Tokens definieren:

```text
Spacing
Typography
Radius
Shadow
Breakpoints
Semantic Colors
Status Colors
Animation Duration
Z-Index
```

Featurecode darf keine willkürlichen Werte verwenden, wenn dafür ein Design Token existiert.

---

# 4. Komponentenstrategie

Frühzeitig bauen:

```text
AppShell
Sidebar
Topbar
PageHeader

Button
IconButton
Input
Textarea
Select
Combobox
Checkbox
Switch

Card
MetricCard
StatusCard

DataTable
FilterBar
SearchInput

Dialog
Drawer
Popover
Tooltip

Tabs
Breadcrumbs

StatusBadge
HealthIndicator

Skeleton
EmptyState
ErrorState

CodeViewer
DiffViewer

Toast
InlineAlert

ChartContainer

CommandPalette
```

---

# 5. Storybook / Component Showcase

Es soll eine isolierte Komponentenansicht geben.

Ziel:

* visuelle Konsistenz
* Dark/Light Testing
* States prüfen
* Komponenten unabhängig entwickeln

Mindestens dokumentieren:

```text
Default
Hover
Focus
Disabled
Loading
Error
Dark Mode
```

---

# 6. Phase 1 ändern – Docker ist kein späteres Deploymentthema

Bereits Phase 1 muss folgende Artefakte erzeugen:

```text
apps/web/Dockerfile
apps/api/Dockerfile

deployments/compose/compose.yml
deployments/compose/compose.dev.yml
deployments/compose/compose.prod.yml

.env.example
.dockerignore
```

---

# 7. Docker Build Test in CI

Jeder Pull Request muss mindestens testen:

```bash
docker compose build
```

Buildfehler sind Merge-blockierend.

---

# 8. Production Build

Die Dockerfiles verwenden Multi-Stage Builds.

Beispielschema Web:

```text
Node Build Image
       │
       ▼
npm/pnpm install
       │
       ▼
Vite Build
       │
       ▼
minimal Web Runtime
```

API:

```text
Node Build Image
       │
       ▼
dependencies
       │
       ▼
TypeScript build
       │
       ▼
production runtime image
```

---

# 9. Build Context

Der Compose Build muss vom Repository-Root reproduzierbar sein.

Beispiel:

```yaml
services:
  web:
    build:
      context: ../..
      dockerfile: apps/web/Dockerfile

  api:
    build:
      context: ../..
      dockerfile: apps/api/Dockerfile
```

Dies ermöglicht gemeinsamen Zugriff auf Monorepo-Packages.

---

# 10. Git Build Metadata

Während des Builds werden eingebettet:

```text
APP_VERSION
GIT_SHA
BUILD_DATE
```

Diese Informationen dürfen keinen Einfluss auf die funktionale Build-Ausgabe außer den Metadaten haben.

---

# 11. OCI Image Metadata

Images sollen Labels besitzen für:

```text
org.opencontainers.image.title
org.opencontainers.image.version
org.opencontainers.image.revision
org.opencontainers.image.created
org.opencontainers.image.source
```

---

# 12. Docker Compose Produktionsstruktur

Ziel:

```text
compose.yml
        │
        ├── common service definitions
        │
        ├── networks
        └── volumes

compose.prod.yml
        │
        ├── production restart policy
        ├── production resource settings
        └── production exposure

compose.dev.yml
        │
        ├── hot reload
        ├── source mounts
        └── development ports
```

---

# 13. Network Layout

Compose-Netze beispielsweise:

```text
frontend
backend
database
```

Erreichbarkeit:

```text
web
  │
  ▼
api
  │
  ├── postgres
  └── redis
```

PostgreSQL und Redis erhalten standardmäßig keine Host-Port-Freigabe.

---

# 14. Volumes

Named Volumes:

```text
postgres_data
redis_data      // falls Persistenz notwendig
backup_data
```

Keine produktiven Daten in Container Layern speichern.

---

# 15. Deployment Scripts

Im Repository:

```text
scripts/
├── install.sh
├── update.sh
├── backup.sh
├── restore.sh
└── healthcheck.sh
```

Scripts sind Wrapper um dokumentierte Standardoperationen und dürfen keine versteckte Deploymentlogik enthalten.

---

# 16. Supported Fresh Installation

E2E-Test muss folgenden Ablauf automatisiert oder halbautomatisiert prüfen:

```bash
git clone <repo>
cd <repo>

cp .env.example .env

docker compose \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml \
  build

docker compose \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml \
  up -d
```

Danach:

```text
GET /health/ready
```

muss erfolgreich sein.

---

# 17. Update-Test

CI bzw. Release-Test:

```text
Version N
   ↓
DB mit Testdaten
   ↓
checkout Version N+1
   ↓
build
   ↓
migration
   ↓
up
   ↓
Daten weiterhin vorhanden
```

---

# 18. Rollback des Application Stacks

Anwendungsrollback muss über Git möglich sein.

Prinzip:

```text
Current:
v1.2.0

Problem detected

git checkout v1.1.3
docker compose build
docker compose up -d
```

Datenbankmigrationen müssen dabei berücksichtigt werden.

Deshalb müssen Releases dokumentieren:

```text
Application rollback supported:
YES / NO

Minimum database schema:
X
```

---

# 19. Phase 1 UI Deliverable

Phase 1 liefert nicht nur ein leeres React-Projekt.

Mindestens:

```text
App Shell
Sidebar
Topbar
Theme System
Command Palette
Page Header
Basic Routing
Loading System
Error Boundary
Toast System
```

---

# 20. Modern UI Quality Gate

Vor Merge einer neuen Seite muss geprüft werden:

### Layout

* klare Seitentitel
* verständliche Beschreibung
* primäre Aktion sichtbar
* keine unnötige Informationsdichte

### States

* Loading
* Empty
* Error
* Success

### Themes

* Light
* Dark

### Accessibility

* Keyboard
* Focus
* Labels
* Kontrast

### Responsive

* Desktop
* Tablet

---

# 21. Visual Regression Testing

Für Kernseiten werden Screenshots gespeichert und automatisiert verglichen.

Mindestens:

```text
Dashboard
Nodes
Node Detail
Access Rules
Rule Editor
Configuration Review
Logs
TLS Inspection
System Settings
```

Getrennt für:

```text
Light
Dark
```

---

# 22. Referenzauflösung

Primär entwickeln für:

```text
1440 × 900
1920 × 1080
```

Zusätzlich testen:

```text
1280 × 720
Tablet
```

---

# 23. Dashboard als eigener UX-Meilenstein

Das Dashboard wird nicht ausschließlich nach vorhandenen Backenddaten gestaltet.

Zuerst wird definiert:

> Was muss ein Administrator innerhalb von fünf Sekunden erkennen?

Antwort:

```text
1. Funktioniert mein Proxy?
2. Sind alle Nodes erreichbar?
3. Gibt es fehlgeschlagene Deployments?
4. Gibt es Configuration Drift?
5. Gibt es ungewöhnliche Traffic-/Error-Werte?
6. Gibt es dringende Warnungen?
```

Erst danach werden Widgets gewählt.

---

# 24. Regel-Editor UX

Der Regel-Editor soll nicht als riesiges Formular entstehen.

Bevorzugter Ablauf:

```text
Basic
  ↓
Source
  ↓
Identity
  ↓
Destination
  ↓
Schedule
  ↓
Action
  ↓
Review
```

Für einfache Regeln können alle Bereiche in einem übersichtlichen Drawer dargestellt werden.

Komplexe Regeln verwenden einen Wizard.

---

# 25. Destructive Operations

Gefährliche Aktionen benötigen moderne Confirmation-Flows.

Nicht:

```text
Are you sure?
[Yes] [No]
```

sondern:

```text
Delete Root CA?

TLS inspection using this certificate will stop working on
3 proxy nodes.

Affected nodes:
• Proxy-DE-01
• Proxy-DE-02
• Proxy-DE-03

This action cannot be undone.

Type "delete" to continue.

[Cancel]       [Delete certificate]
```

---

# 26. KI-Agenten – neue Frontend-Regel

KI-Assistenten dürfen keine neue UI-Komponente erstellen, bevor geprüft wurde, ob eine passende Komponente bereits in:

```text
packages/ui
```

existiert.

---

# 27. KI-Agenten – neue Docker-Regeln

KI-Assistenten dürfen:

* Dockerfiles erweitern
* Compose Services ergänzen
* Healthchecks ergänzen

Sie dürfen nicht ohne ADR:

* Docker Socket mounten
* `privileged: true` verwenden
* `network_mode: host` für die Control Plane verwenden
* Host Root Filesystem mounten
* Datenbankports öffentlich exponieren
* Secrets in Build Args legen

---

# 28. KI-Agenten – Git-Regeln

Generierter Code darf keine Annahme machen, dass ein CI-System Images veröffentlicht.

Die Anwendung muss jederzeit aus einem normalen Git Checkout baubar bleiben.

Folgender Zustand ist fehlerhaft:

```text
docker compose up
→ versucht ghcr.io/project/api:latest zu laden
→ Registry Login erforderlich
```

Primärer Zustand:

```text
docker compose build
→ lokale Images entstehen

docker compose up
→ lokale Images werden verwendet
```

---

# 29. Entwicklerworkflow

Entwicklung:

```bash
git clone <repository>
cd squid-control-plane

docker compose \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.dev.yml \
  up --build
```

Optional können Frontend und Backend während der Entwicklung nativ gestartet werden.

Die Docker-Entwicklungsumgebung bleibt jedoch jederzeit funktionsfähig.

---

# 30. Production Workflow

Server:

```bash
git fetch --tags
git checkout v1.0.0

docker compose \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml \
  build --pull

docker compose \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml \
  run --rm migrate

docker compose \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml \
  up -d --remove-orphans
```

Anschließend:

```bash
docker compose ps
```

und automatisierter Application Healthcheck.

---

# 31. Release-Artefakte

Ein Git Release enthält mindestens:

```text
Source Tag
Release Notes
Upgrade Notes
Migration Notes
Supported Squid Versions
Supported Agent Versions
Known Issues
Rollback Information
```

Prebuilt Images können später optional angeboten werden.

Sie sind nicht Voraussetzung für den offiziellen Deploymentpfad.

---

# 32. Ergänzte Phasenübersicht

Neue Reihenfolge:

```text
Phase 0
Architecture + Threat Model + UX Architecture

Phase 1
Repository + Docker Compose + Design System + Application Skeleton

Phase 2
Identity & Security

Phase 3
Agent & Enrollment

Phase 4
Monitoring

Phase 5
Configuration Core

Phase 6
Policies

Phase 7
Safe Deployment

Phase 8
Logs & Traffic

Phase 9
Authentication

Phase 10
TLS Inspection

Phase 11
Cache & Upstreams

Phase 12
Advanced Administration

Phase 13
Multi-Node

Phase 14
UX Polish + Production Hardening

Phase 15
Release 1.0
```

---

# 33. Phase 14 erweitern – UX Polish

Vor 1.0 wird ein vollständiger UI-/UX-Pass durchgeführt.

Prüfung aller Seiten auf:

```text
Design consistency
Spacing
Typography
Icons
Light Mode
Dark Mode
Loading States
Empty States
Error States
Transitions
Responsive Behaviour
Accessibility
Content wording
```

---

# 34. Anti-SAP Review 😄

Als bewusst einfaches Product Gate gilt:

> Würde ein Nutzer beim ersten Öffnen denken, dass die Oberfläche aus einer modernen Webanwendung stammt?

Falls die Oberfläche eher erinnert an:

```text
Legacy ERP
alte Router WebUI
phpMyAdmin aus vergangenen Zeiten
klassische Java Admin Console
```

ist das Designziel nicht erreicht.

Technische Funktionalität allein reicht nicht für die Abnahme.

---

# 35. Definition of Done ergänzen

Eine Story mit UI ist nur Done, wenn:

* Designsystem verwendet
* Light Mode getestet
* Dark Mode getestet
* Loading State vorhanden
* Empty State vorhanden
* Error State vorhanden
* responsive Verhalten vorhanden
* Accessibility berücksichtigt
* keine unnötig dichte Formularstruktur vorhanden

Eine Story mit Backend-/Deploymentänderung ist nur Done, wenn:

```bash
docker compose build
```

weiterhin erfolgreich ist.

---

# 36. Release 1.0 – Docker Acceptance Test

Auf einem frischen unterstützten Linux-Server:

```text
Docker installiert
Git installiert
kein Node.js installiert
kein npm installiert
kein PostgreSQL installiert
kein Redis installiert
```

muss folgendes möglich sein:

```text
Git Repository klonen
        ↓
Release Tag auswählen
        ↓
.env konfigurieren
        ↓
docker compose build
        ↓
Migration
        ↓
docker compose up
        ↓
Control Plane erreichbar
```

Damit wird bewiesen, dass keine versteckten Host-Abhängigkeiten existieren.

---

# 37. Zielzustand

Die fertige Anwendung soll gleichzeitig drei Eigenschaften besitzen:

```text
                    Squid Control Plane

             ┌────────────┼────────────┐
             │            │            │
             ▼            ▼            ▼
          Modern       Reliable      Portable
             │            │            │
        modernes UI    Safe Deploy   Docker Compose
        intuitive UX   Rollback      Git-based Build
        Dark/Light     Validation    local Images
```

Keine dieser drei Dimensionen darf für die anderen geopfert werden.

# PHASE 9 – PROXY IDENTITY & AUTHENTICATION

## Ziel

Entwicklung einer providerunabhängigen Proxy-Identity-Plattform, die gleichzeitig folgende Betriebsarten unterstützt:

```text
No Authentication
Local Authentication
LDAP Authentication
Local + LDAP
Optional Authentication
```

---

# 9.1 Identity Architecture

Zuerst muss die technische Trennung umgesetzt werden:

```text
Control Plane Users
```

und:

```text
Proxy Users
```

Diese dürfen keine gemeinsame Datenbankentität verwenden.

---

# 9.2 Authentication Mode

Implementieren:

```text
DISABLED
OPTIONAL
REQUIRED
```

im:

```text
ProxyAuthenticationConfiguration
```

Backend, IR und UI müssen alle drei Modi vollständig verstehen.

---

# 9.3 Policy Engine erweitern

Identity Matcher:

```text
ANY
AUTHENTICATED
UNAUTHENTICATED
USER
GROUP
```

Unit Tests für jeden Matcher.

---

# 9.4 Local Authentication Provider

Implementieren:

```text
LocalProxyUser
LocalProxyGroup
LocalProxyUserGroup
```

Backend-Endpunkte beispielsweise:

```text
GET    /api/v1/proxy-users
POST   /api/v1/proxy-users
GET    /api/v1/proxy-users/:id
PATCH  /api/v1/proxy-users/:id
DELETE /api/v1/proxy-users/:id

POST   /api/v1/proxy-users/:id/password

GET    /api/v1/proxy-groups
POST   /api/v1/proxy-groups
PATCH  /api/v1/proxy-groups/:id
DELETE /api/v1/proxy-groups/:id
```

---

# 9.5 Password Handling

Passwortworkflow:

```text
Web UI
  │
  │ TLS
  ▼
API
  │
  │ validation
  ▼
Authentication Service
  │
  ▼
appropriate password hash
```

Plaintext Password existiert nur für die Dauer der notwendigen Verarbeitung im Speicher.

Nicht erlaubt:

```text
logging
audit payload
database plaintext
API echo
```

---

# 9.6 Local Provider Adapter

Implementieren:

```text
AuthenticationProviderAdapter
```

mit erster Implementierung:

```text
LocalAuthenticationProvider
```

Der Provider erzeugt die vom Squid-Adapter benötigten Artefakte.

---

# 9.7 LDAP Provider

Danach:

```text
LdapAuthenticationProvider
```

Funktionen:

```text
Connection Test
Bind
User Lookup
Group Lookup
Authentication
Health
```

Credentials über Secret Storage.

---

# 9.8 Multi-Provider Orchestration

Implementieren:

```text
AuthenticationProviderRegistry
```

mit:

```text
enabled
priority
health
capabilities
```

Provider müssen gleichzeitig aktiv sein können.

---

# 9.9 Provider Failure Handling

Tests:

```text
LDAP unavailable
Local available
```

Erwartung:

Lokale Authentifizierung bleibt funktionsfähig.

---

# 9.10 UI – Authentication Overview

Seite:

```text
Authentication → Overview
```

enthält:

```text
Authentication Mode

○ Disabled
○ Optional
● Required
```

sowie:

```text
Active Providers

Local Users       ● Healthy
Company LDAP      ● Healthy
```

---

# 9.11 UI – Local Users

Implementieren:

```text
Authentication → Local Users
```

Funktionen:

- Create User
- Edit User
- Disable User
- Delete User
- Replace Password
- Assign Groups
- Search
- Filter

---

# 9.12 UI – Proxy Groups

Implementieren:

```text
Authentication → Groups
```

Unterstützen:

- lokale Gruppen
- externe LDAP-Gruppen
- logische Gruppen

---

# 9.13 UI – Provider Management

```text
Authentication → Providers
```

Darstellung beispielsweise:

```text
Local Users
────────────────
Status       Healthy
Users        18
Groups       6
Priority     10
Enabled      Yes


Company LDAP
────────────────
Status       Healthy
Server       ldap.example.internal
Priority     20
Enabled      Yes
```

---

# 9.14 Authentication Disabled Flow

E2E-Test:

```text
Set authentication DISABLED
        ↓
Create Allow Any Policy
        ↓
Compile Config
        ↓
Validate
        ↓
Deploy
        ↓
curl through proxy without credentials
        ↓
SUCCESS
```

---

# 9.15 Required Local Authentication Flow

```text
Create local proxy user
        ↓
Authentication REQUIRED
        ↓
Enable Local Provider
        ↓
Deploy
        ↓
curl without credentials
        ↓
DENIED / AUTH REQUIRED

curl with local credentials
        ↓
SUCCESS
```

---

# 9.16 Required LDAP Authentication Flow

Entsprechender E2E-Test mit Test-LDAP.

Für CI soll ein reproduzierbarer LDAP-Testcontainer beziehungsweise Fixture verfügbar sein.

---

# 9.17 Parallel Local + LDAP Flow

Pflicht-E2E-Test:

```text
Local User
        │
        ├──────────┐
        │          │
LDAP User          │
        │          │
        └───── Proxy
```

Beide müssen bei aktivierten Providern erfolgreich authentifizierbar sein.

---

# 9.18 Optional Authentication Flow

Testumgebung:

```text
Employee Network
+
Guest Network
```

Policies:

```text
Authenticated Employees
→ Any
→ ALLOW

Guest Network
+ Unauthenticated
→ Web
→ ALLOW

Any
→ DENY
```

Testfälle:

```text
LDAP Employee → SUCCESS
Local Employee → SUCCESS
Guest without credentials → SUCCESS
unauthenticated forbidden source → DENIED
```

---

# 9.19 Open Proxy Safety Test

Bei:

```text
Authentication DISABLED
Default ALLOW
Listener 0.0.0.0
Source ANY
```

muss die Anwendung mindestens einen Security Warning erzeugen.

Die Warnung darf kein technisches Verbot sein, sofern der Benutzer mit entsprechender Berechtigung die Konfiguration bewusst aktivieren möchte.

---

# 9.20 Permissions ergänzen

Neue Permissions:

```text
PROXY_AUTH_READ
PROXY_AUTH_CONFIGURE

PROXY_USER_READ
PROXY_USER_CREATE
PROXY_USER_UPDATE
PROXY_USER_DELETE
PROXY_USER_PASSWORD_RESET

PROXY_GROUP_READ
PROXY_GROUP_MANAGE

AUTH_PROVIDER_READ
AUTH_PROVIDER_MANAGE
AUTH_PROVIDER_TEST
```

---

# 9.21 Audit Events ergänzen

Mindestens:

```text
PROXY_USER_CREATED
PROXY_USER_UPDATED
PROXY_USER_DISABLED
PROXY_USER_DELETED
PROXY_USER_PASSWORD_CHANGED

PROXY_GROUP_CREATED
PROXY_GROUP_UPDATED
PROXY_GROUP_DELETED

AUTH_MODE_CHANGED

AUTH_PROVIDER_CREATED
AUTH_PROVIDER_UPDATED
AUTH_PROVIDER_ENABLED
AUTH_PROVIDER_DISABLED
AUTH_PROVIDER_TESTED
```

Passwörter oder Authentifizierungs-Testcredentials dürfen niemals Bestandteil des Audit Payloads sein.

---

# 9.22 Dashboard Integration

Dashboard zeigt:

```text
Authentication Mode
Provider Health
Authentication Failures
Authenticated Requests
Unauthenticated Requests
```

---

# 9.23 Logs erweitern

Sofern verfügbar, Traffic Logs unterscheiden:

```text
Identity:
fabian
```

und:

```text
Identity:
Unauthenticated
```

Filter:

```text
Authenticated
Unauthenticated
Specific User
Provider
```

---

# 9.24 Definition of Done Phase 9

Phase 9 gilt erst als abgeschlossen, wenn:

- Disabled Mode funktioniert
- Required Mode funktioniert
- Optional Mode funktioniert
- lokale Nutzerverwaltung funktioniert
- lokale Gruppen funktionieren
- LDAP funktioniert
- Local und LDAP gleichzeitig funktionieren
- unauthentifizierte Policies funktionieren
- Provider Priorities funktionieren
- Provider Health angezeigt wird
- Password Handling Security Tests bestehen
- Open Proxy Warning funktioniert
- Squid Config daraus generiert wird
- Config `squid -k parse` besteht
- E2E Tests mit echtem Squid bestehen

---

# 9.25 Product Demo

PO-Abnahme:

### Demo 1

```text
Authentication OFF
→ jeder Client im Lab-Netz darf ins Internet
```

### Demo 2

```text
Authentication REQUIRED
→ lokaler Benutzer funktioniert
→ LDAP-Benutzer funktioniert
→ anonymer Client wird abgewiesen
```

### Demo 3

```text
Authentication OPTIONAL
→ Mitarbeiter authentifiziert
→ Gast anonym
→ beide erhalten unterschiedliche Policies
```

Erst wenn alle drei Demonstrationen erfolgreich sind, gilt die Phase als abgenommen.