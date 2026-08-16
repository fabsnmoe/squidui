# Ergänzung Authentifizierung – Version 1.2

Alle bisherigen Anforderungen bleiben bestehen. Die folgenden Anforderungen präzisieren und erweitern den Bereich **Proxy Authentication**.

# 1. Trennung der Identitäten

Die Anwendung unterscheidet strikt zwischen:

```text
Control Plane Identity
```

und:

```text
Proxy Identity
```

## Control Plane Identity

Wird verwendet für:

- Anmeldung am WebUI
- API-Zugriff
- RBAC
- Administration
- Audit Logging

## Proxy Identity

Wird verwendet für:

- Authentifizierung von Clients gegenüber Squid
- Proxy-Policies
- Benutzergruppen
- benutzerabhängige Access Rules
- Traffic-Auswertung

Beide Identitätssysteme dürfen technisch unabhängig voneinander betrieben werden.

Ein lokaler Control-Plane-Benutzer ist **nicht automatisch** ein lokaler Proxy-Benutzer.

---

# 2. Authentifizierungsmodi

Unter:

```text
Authentication → Overview
```

muss ein globaler Authentifizierungsmodus konfigurierbar sein.

Unterstützte Modi:

```text
Disabled
Optional
Required
```

---

# 3. Authentication Disabled

Modus:

```text
Authentication: Disabled
```

Bedeutung:

- Squid fordert keine Proxy-Authentifizierung an.
- Clients benötigen keine Zugangsdaten.
- Benutzeridentitäten werden nicht vorausgesetzt.
- Policies können weiterhin anhand anderer Merkmale ausgewertet werden.

Beispielsweise:

```text
Source Network
Destination
Port
Schedule
TLS Rule
```

Die Anwendung muss ausdrücklich einen einfachen Betriebsmodus ermöglichen:

```text
Any Source
→ Any Destination
→ ALLOW
```

ohne Benutzeranmeldung.

Damit kann Squid beispielsweise als vollständig transparenter administrativer Forward Proxy innerhalb eines vertrauenswürdigen Netzes betrieben werden.

---

# 4. Full Unauthenticated Access

Es muss ein vorkonfigurierbares Policy-Szenario geben:

```text
Authentication:
Disabled

Access:
ALLOW

Source:
Configured Networks

Destination:
Any

Schedule:
Always
```

Im UI beispielsweise:

```text
Proxy Access

Authentication
○ Required
○ Optional
● Disabled

Default access
● Allow
○ Deny
```

Eine Konfiguration:

```text
Authentication = Disabled
Default Access = Allow
```

muss ausdrücklich unterstützt werden.

---

# 5. Sicherheitswarnung bei offenem Proxy

Wenn gleichzeitig gilt:

```text
Authentication = Disabled
```

und:

```text
Default Access = Allow
```

muss die UI prüfen, welche Source Networks beziehungsweise Listener freigegeben sind.

Bei einer potenziell öffentlich erreichbaren Konfiguration muss eine deutliche Warnung erscheinen:

```text
Warning

This configuration may create an unauthenticated open proxy.

Clients from the configured source networks can use this
proxy without credentials.

Verify listener addresses, firewall rules and allowed
source networks before deployment.
```

Die Anwendung darf diese Betriebsart nicht grundsätzlich verhindern.

Sie soll jedoch verhindern, dass eine solche Konfiguration versehentlich entsteht.

---

# 6. Authentication Required

Modus:

```text
Authentication: Required
```

Bedeutung:

Ein Client muss erfolgreich authentifiziert sein, bevor Regeln ausgeführt werden können, die authentifizierten Proxyzugriff voraussetzen.

Nicht authentifizierte Clients erhalten eine entsprechende Proxy-Authentication-Anforderung beziehungsweise werden gemäß Policy abgewiesen.

---

# 7. Authentication Optional

Zusätzlich muss unterstützt werden:

```text
Authentication: Optional
```

Dieser Modus ermöglicht gleichzeitig:

```text
authenticated users
+
anonymous users
```

Beispiel:

```text
Employees
authenticated via LDAP
        │
        ├── unrestricted business access
        │
        ▼

Guest Network
no authentication
        │
        ├── restricted internet access
        │
        ▼
```

Damit können Policies beispielsweise lauten:

```text
Rule 10
User Group: Developers
Destination: Developer Services
ALLOW

Rule 20
Source: Guest Network
User: Unauthenticated
Destination: Internet
ALLOW

Rule 30
Any
DENY
```

---

# 8. Unauthenticated Identity

Die Policy Engine erhält einen speziellen Identitätstyp:

```text
UNAUTHENTICATED
```

Dieser kann explizit in Regeln verwendet werden.

Beispiel:

```text
Source:
Guest VLAN

Identity:
Unauthenticated

Destination:
Any

Action:
Allow
```

Dadurch ist anonymes Proxying nicht nur ein Sonderfall, sondern regulärer Bestandteil der Policy Engine.

---

# 9. Authentication Providers

Unter:

```text
Authentication
├── Overview
├── Providers
├── Local Users
├── Groups
└── Test
```

müssen mehrere Provider gleichzeitig aktiviert werden können.

Beispiele:

```text
Local Users           Enabled
LDAP – Company AD     Enabled
LDAP – Lab            Disabled
```

---

# 10. Parallelbetrieb mehrerer Provider

Provider sind keine gegenseitig ausschließenden Einstellungen.

Folgende Konfiguration muss möglich sein:

```text
Authentication Mode:
Required

Providers:

1. Local
2. LDAP – Company
```

Damit können sich sowohl:

```text
lokale Proxy-Benutzer
```

als auch:

```text
LDAP-Benutzer
```

am selben Squid-System authentifizieren.

---

# 11. Typisches Einsatzszenario

Lokale Benutzer können beispielsweise als:

- Notfallaccounts
- Service Accounts
- externe Nutzer
- Labornutzer
- temporäre Nutzer
- Administrator-Testaccounts

verwendet werden.

Während reguläre Mitarbeiter über LDAP authentifiziert werden.

Beispiel:

```text
             Proxy Authentication

                    ┌─────────┐
                    │ Squid   │
                    └────┬────┘
                         │
             ┌───────────┴───────────┐
             │                       │
             ▼                       ▼
        Local Provider          LDAP Provider
             │                       │
       proxy-admin             alice
       service-user            bob
       emergency               charlie
```

---

# 12. Provider Priority

Provider erhalten eine definierte Reihenfolge.

UI:

| Priority | Provider | Status |
|---:|---|---|
| 10 | Local Users | Enabled |
| 20 | Company LDAP | Enabled |

Die Reihenfolge muss deterministisch gespeichert werden.

---

# 13. Lokale Proxy-Nutzerverwaltung

Neuer Menüpunkt:

```text
Authentication
├── Overview
├── Providers
├── Local Users
├── Groups
└── Authentication Test
```

Local Users zeigt:

| Username | Groups | Status | Last Changed |
|---|---|---|---|
| proxy-admin | Administrators | Active | 16.08.2026 |
| service-api | Services | Active | 15.08.2026 |
| test-user | Lab | Disabled | 12.08.2026 |

---

# 14. Lokaler Benutzer

Eigenschaften:

```text
Username
Display Name
Description
Password
Status
Groups
Created At
Updated At
```

Optional später:

```text
Expiration Date
Password Expiration
Allowed Networks
```

---

# 15. Passwortspeicherung

Proxy-Passwörter dürfen niemals im Klartext gespeichert werden.

Insbesondere nicht in:

```text
PostgreSQL
Logs
Audit Events
Generated Config
API Responses
```

Es muss ein für den tatsächlich eingesetzten Squid-Authentication-Helper geeignetes Passwortformat verwendet werden.

Die konkrete Hashing-/Helper-Implementierung ist Bestandteil des jeweiligen Squid-Version-Adapters beziehungsweise Authentication-Adapters.

---

# 16. Passwortänderung

UI:

```text
Local User
──────────────────────────

Username
service-user

Groups
Services

Password
••••••••••••

[ Replace Password ]
```

Ein bestehendes Passwort darf nicht wieder angezeigt werden.

---

# 17. Lokale Proxy-Gruppen

Lokale Benutzer müssen Gruppen zugeordnet werden können.

Beispielsweise:

```text
Administrators
Developers
Employees
Guests
Service Accounts
```

Diese Gruppen können in Access Policies verwendet werden.

---

# 18. LDAP-Gruppen und lokale Gruppen

Das interne Policy-Modell darf nicht davon abhängen, woher eine Gruppe stammt.

Beispiel:

```text
Identity Group
├── LOCAL:Developers
└── LDAP:CN=Developers,...
```

Optional kann daraus eine logische Policy-Gruppe entstehen:

```text
Developer Access
├── Local Developers
└── LDAP Developers
```

Policies können dann auf:

```text
Developer Access
```

referenzieren.

---

# 19. Authentifizierungsstatus in Policies

Für die Identity-Komponente einer Regel sind mindestens verfügbar:

```text
Any
Authenticated
Unauthenticated
Specific User
User Group
```

Beispiel:

```text
Rule 10

Source:
Guest Network

Identity:
Unauthenticated

Destination:
Any

Action:
ALLOW
```

oder:

```text
Rule 20

Identity:
Authenticated

Destination:
Any

Action:
ALLOW
```

---

# 20. Provider-Ausfall

Bei mehreren Providern muss das Verhalten bei Provider-Ausfall definiert sein.

Beispiel:

```text
Local Provider
AVAILABLE

LDAP Provider
UNAVAILABLE
```

Der Ausfall von LDAP darf lokale Accounts nicht automatisch unbrauchbar machen.

Die UI muss anzeigen:

```text
LDAP – Company
× Unreachable

Local Users
● Healthy
```

---

# 21. Provider Test

Jeder Provider erhält:

```text
[Test Connection]
```

LDAP:

```text
✓ Server reachable
✓ TLS established
✓ Bind successful
✓ Search base accessible
```

Local:

```text
✓ Local authentication provider ready
12 active users
4 groups
```

---

# 22. Authentication Test

Zentrale Testseite:

```text
Authentication → Test
```

Eingabe:

```text
Username
Password
Source IP (optional)
```

Ergebnis:

```text
Authentication successful

Provider:
Local Users

User:
service-user

Groups:
Services
Proxy Users
```

oder:

```text
Authentication successful

Provider:
Company LDAP

User:
fabian

Groups:
Employees
Developers
```

Das eingegebene Passwort darf weder persistiert noch geloggt werden.

---

# 23. Dashboard

Das Dashboard soll den Authentifizierungsmodus anzeigen.

Beispielsweise:

```text
Authentication
────────────────

Mode
Optional

Providers
● Local
● Company LDAP
```

Bei deaktivierter Authentifizierung:

```text
Authentication
────────────────

Mode
Disabled

Clients may access the proxy without credentials.
```

---

# 24. Datenmodell ergänzen

Zusätzliche beziehungsweise präzisierte Entitäten:

```text
ProxyAuthenticationConfiguration

AuthenticationProvider
├── LocalAuthenticationProvider
└── LdapAuthenticationProvider

ProxyUser
ProxyGroup
ProxyUserGroup

ExternalIdentity
ExternalGroup

LogicalIdentityGroup
LogicalIdentityGroupMember
```

---

# 25. ProxyAuthenticationConfiguration

Beispiel:

```json
{
  "mode": "OPTIONAL",
  "providers": [
    {
      "id": "local",
      "enabled": true,
      "priority": 10
    },
    {
      "id": "ldap-company",
      "enabled": true,
      "priority": 20
    }
  ]
}
```

Mögliche Werte:

```text
DISABLED
OPTIONAL
REQUIRED
```

---

# 26. Policy Identity Model

Die Configuration IR muss mindestens folgende Identitätsmatcher kennen:

```text
ANY
AUTHENTICATED
UNAUTHENTICATED
USER
GROUP
```

Damit bleiben Authentifizierung und Policy Engine voneinander sauber getrennt.

---

# 27. Abnahmekriterien

Die Authentifizierungsfunktion gilt nur als vollständig, wenn folgende Szenarien erfolgreich getestet sind.

### Szenario A – vollständig ohne Authentifizierung

```text
Authentication:
Disabled

Access:
Allow Any
```

Client kann ohne Benutzername und Passwort über den Proxy kommunizieren.

---

### Szenario B – nur lokale Benutzer

```text
Authentication:
Required

Provider:
Local
```

Lokaler Benutzer kann sich authentifizieren.

Unbekannter Benutzer wird abgewiesen.

---

### Szenario C – nur LDAP

```text
Authentication:
Required

Provider:
LDAP
```

LDAP-Benutzer kann sich authentifizieren.

---

### Szenario D – Local + LDAP parallel

```text
Authentication:
Required

Providers:
Local
LDAP
```

Sowohl:

```text
local-user
```

als auch:

```text
ldap-user
```

können denselben Proxy verwenden.

---

### Szenario E – Mixed Mode

```text
Authentication:
Optional
```

Gleichzeitig funktionieren:

```text
authenticated employee
```

und:

```text
unauthenticated guest
```

mit unterschiedlichen Policies.

---

# 28. Grundsatz

Die Proxy-Authentifizierung ist ein optionales Policymerkmal.

Sie darf niemals vorausgesetzt werden.

Das Produkt muss deshalb sämtliche folgenden Betriebsmodelle gleichwertig unterstützen:

```text
No Authentication
```

```text
Local Authentication
```

```text
LDAP Authentication
```

```text
Local + LDAP
```

```text
Authenticated + Unauthenticated parallel
```

Damit kann die Squid Control Plane sowohl in sehr einfachen vertrauenswürdigen Netzen als auch in umfangreichen Unternehmensumgebungen eingesetzt werden.