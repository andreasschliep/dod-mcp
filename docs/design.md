# dod-mcp: Design

Status: Entwurf zur Freigabe, 14.11.2026. Grundlage: Konzeptskizze „Team-MCP-Server Definition of Done“ vom 14.11.2026, Abschnitte 3 und 4. Design und Entscheidungen: Andreas Schliep. Entworfen mit Claude Code. **Alle Daten in diesem Repository sind fiktiv.**

**In zwei Sätzen:** Der Server liest die Definition of Done eines Teams aus versionierten YAML-Dateien, eine gemeinsame Basis und eine Datei je Aufgabentyp, und stellt jeden Typ als eigene Ressource bereit. Er prüft Belege, die der Agent über die offiziellen Server gesammelt hat, und Akzeptanzkriterien deterministisch, meldet je Kriterium `erfüllt`, `nicht erfüllt` oder `braucht Urteil` mit Fundstelle und erklärt nie ein Item für „done“.

Erklärbarkeit vor Funktionsumfang: Jeder Teil soll sich in zwei Sätzen erklären lassen.

## 1. Ziel und Nicht-Ziele

**Ziel.** Ein Agent (Claude Code, Claude Desktop, jeder MCP-Client) kann fragen: „Welche DoD gilt für dieses Item, was muss ich belegen, und was ist mit diesen Belegen erfüllt?“ Er bekommt je Kriterium einen Status, den Beleg oder einen Befund mit Hinweis, wie der Beleg zu holen ist, und für Urteilsfragen die Frage samt Maßstab. Mensch und Agent lesen dieselben Dateien.

**Nicht-Ziele.**

- **Kein „done“.** Der Server hat keinen Gesamtstatus und kein schreibendes Tool. Das Team entscheidet.
- **Keine Belege selbst holen.** Der Server ruft keine API auf und braucht keinen Schlüssel (Variante B der Skizze, D1).
- **Kein Modellaufruf.** Urteilsfragen beantwortet das Modell im Client (D2).
- **Keine Pflege der DoD über den Server.** Geändert wird per Pull Request auf die Dateien; die Git-Historie ist das Protokoll.
- **Keine echten Daten.** Nur fiktive Teams, Tickets und Belege.

## 2. Kontext

| Baustein          | Stand 14.11.2026                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| MCP-Spezifikation | 2026-07-28: zustandslos; Sampling, Roots und Logging abgekündigt                                          |
| TypeScript-SDK    | `@modelcontextprotocol/server` 2.4.0, wie in `miro-board-mcp` und `course-standards-mcp`                  |
| YAML-Parser       | `yaml` 2.9.1 (liefert Zeilen je Knoten; `js-yaml` kann das nicht, D6)                                     |
| Laufzeit          | Node.js ≥ 22.18 (TypeScript-Tests ohne Build über Type Stripping), lokal 26.7.0                           |
| Vorbilder         | `course-standards-mcp` (Befunde mit Zeile, Rubrik als Ressource, `needs_judgment`), `miro-board-mcp` (Fachfehler, Bestätigung vor Schreiben) |

## 3. Architektur

```
 Team ── ändert per Pull Request ──> dod/*.yaml (Team-Repository)
                                          │ bei jedem Aufruf gelesen
 Mensch ── liest, entscheidet „done“      ▼
    │                          dod-mcp (dieser Server, nur lesend)
    ▼                          ├─ Ressourcen: dod://types, dod://type/{type},
 Client (Claude Code / Desktop)│              template://{type}, rubric://dod/{type}
    │  Modell sammelt Belege   ├─ Tools:      get_dod, check_dod, lint_acceptance_criteria
    │  über offizielle Server  ├─ dod/:       laden, validieren (Datei + Zeile), zusammenführen,
    │  (SonarQube, Azure       │              Typ auflösen
    │  DevOps, GitHub, Jira)   ├─ check/:     Belege prüfen (Form, Alter, Stand, Erwartung)
    │  und übergibt sie        └─ lint/:      Regeln für Akzeptanzkriterien je Typ
    └── JSON-RPC über stdio ──>
```

Der Server hält keinen Zustand. Er liest den DoD-Ordner bei jedem Aufruf (wenige kleine Dateien), sodass eine geänderte oder neue Datei ohne Neustart gilt.

## 4. Wer entscheidet was

Drei Vokabulare, damit man am Wort sieht, wer entschieden hat (Skizze, Abschnitt 4):

| Wer                 | Wörter                                       | Wofür                                                                 |
| ------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| Server              | `erfüllt` / `nicht erfüllt` / `braucht Urteil` | je Kriterium, aus Belegen und Regeln, reproduzierbar                  |
| Modell im Client    | `plausibel` / `zweifelhaft`                  | je Urteilskriterium, mit Zitat und Fundstelle, nach `rubric://dod/{type}` |
| Team (bzw. Rolle)   | „done“                                       | das Item; eine Rolle bestätigt Bestätigungskriterien                  |

Jedes Kriterium hat eine Prüfart (`check`), und die bestimmt, was der Server tun kann:

| `check`       | Server stellt fest                                                         | Ergebnis ohne Mängel | Wer entscheidet (`who_decides`)     |
| ------------- | -------------------------------------------------------------------------- | -------------------- | ----------------------------------- |
| `evidence`    | Form, Alter, Stand (Commit) und Wert des Belegs gegen die Erwartung         | `erfüllt`            | Server, aus dem Beleg               |
| `judgment`    | nichts in der Sache; reicht Frage, Maßstab und mitgegebenes Material durch | `braucht Urteil`     | Modell schätzt ein, Team entscheidet |
| `attestation` | ob eine Bestätigung der richtigen Rolle mit Zeitpunkt und Quelle vorliegt  | `erfüllt`            | die genannte Rolle                  |

## 5. Datenformat

### 5.1 Ordner und Erkennung

```text
dod/
  base.yaml            # gilt für alle Typen
  types.yaml           # Ticket-Typ / Label → Aufgabentyp
  software-dev.yaml    # je Aufgabentyp eine Datei
  dokument.yaml
  kundenanfrage.yaml
```

- Jede andere `*.yaml` im Ordner ist eine Typ-Datei. **Der Typname ist der Dateiname** ohne Endung (`^[a-z][a-z0-9-]{0,39}$`), und das Feld `type` in der Datei muss ihm gleichen. Ein neuer Typ ist also genau eine neue Datei.
- Der Ordner kommt aus `DOD_DIR` (Standard: `<repo>/dod`). In Ergebnissen erscheinen nur Dateinamen, nie absolute Pfade.
- Jede Datei trägt `version` (ganze Zahl, wird bei jeder Änderung erhöht) und einen Kopfkommentar; fiktive Dateien sagen es in der ersten Zeile.
- Die zusammengeführte Fassung eines Typs heißt zum Beispiel `kundenanfrage@3+base@2`. Diese Kennung steht in jedem Ergebnis, damit ein Bericht sagt, gegen welche Fassung geprüft wurde.

### 5.2 Basis und Typ-Datei

```yaml
# FIKTIVES BEISPIEL: dod/kundenanfrage.yaml
type: kundenanfrage
version: 3
title: Kundenanfrage
extends: base                 # Pflicht; ein Typ erbt immer die Basis
criteria:
  - id: FRIST
    text: Die erste Antwort ging innerhalb der vereinbarten Frist raus.
    check: evidence
    source: helpdesk.first_response
    expect: { field: first_response_at, not_after: due_at }
    fetch_with: [helpdesk:get_ticket]
  - id: VOLLSTAENDIG
    text: Die Antwort geht auf jede Frage der Anfrage ein.
    check: judgment
    question: Welche Frage der Anfrage bleibt in der Antwort offen?
    plausible_if: [Jede nummerierte Frage hat einen Absatz in der Antwort, der sie beantwortet.]
    doubtful_if: [Eine Frage wird nur mit einem Verweis auf später beantwortet.]
  - id: ZUSAGE
    text: Zusagen zu Preis oder Termin sind freigegeben.
    check: attestation
    role: Vertrieb
acceptance:
  template: |
    Fragen:
    1. …
    Frist: TT.MM.JJJJ oder „2 Arbeitstage“
  rules:
    - id: AK-FELDER
      kind: fields
      fields:
        - { name: Fragen, list: true, min_items: 1 }
        - { name: Frist, format: date_or_duration }
```

**Felder eines Kriteriums.** Schlüssel englisch wie im Beispiel der Skizze, Inhalte deutsch.

| Feld            | `evidence` | `judgment` | `attestation` | Bedeutung                                                                      |
| --------------- | ---------- | ---------- | ------------- | ------------------------------------------------------------------------------ |
| `id`            | Pflicht    | Pflicht    | Pflicht       | `^[A-Z][A-Z0-9-]{1,39}$`, eindeutig über Basis und Typ                          |
| `text`          | Pflicht    | Pflicht    | Pflicht       | das Kriterium, wie es im Team-Wiki stünde                                      |
| `source`        | Pflicht    | –          | –             | fachliche Belegquelle, z. B. `sonarqube.quality_gate`                          |
| `expect`        | Pflicht    | –          | –             | wann der Rohwert das Kriterium erfüllt (5.3)                                   |
| `max_age_hours` | optional   | –          | optional      | ältere Belege sind `beleg_veraltet`; ohne Angabe keine Altersprüfung           |
| `same_ref`      | optional   | –          | –             | Beleg muss zum Stand des Items gehören (Commit), sonst `beleg_anderer_stand`    |
| `fetch_with`    | optional   | optional   | optional      | Tools, die den Beleg liefern (`server:tool`); Hinweis bei fehlendem Beleg (8.2) |
| `question`      | –          | Pflicht    | –             | die Urteilsfrage, so gestellt, dass sie Lücken sucht                           |
| `plausible_if`, `doubtful_if` | – | optional | –             | Maßstäbe für die Rubrik                                                        |
| `role`          | –          | –          | Pflicht       | die Rolle, die bestätigt                                                       |

Ein Feld, das zur Prüfart nicht passt (etwa `role` bei `evidence`), ist ein Fehler, kein stilles Ignorieren.

Die Werkzeugnamen in `fetch_with` sind in den Beispieldaten Platzhalter (`tickets:`, `ci:`, `scm:`, `helpdesk:`, `docs:`). Echt sind nur `sonarqube:get_project_quality_gate_status` (SonarQube MCP Server, Skizze [S2]) und `course-standards:check_terms` (eigener Server).

### 5.3 Erwartung an einen Beleg (`expect`)

Ein fester, kleiner Satz von Operatoren, genau einer je Kriterium. Optional wählt `field` einen Schlüssel aus einem Rohwert, der ein Objekt ist.

| Operator         | erfüllt, wenn                                                   | Beispiel                                              |
| ---------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| `equals`         | Wert ist gleich (Text, Zahl oder Wahrheitswert)                 | `{ field: status, equals: OK }`                       |
| `one_of`         | Wert ist einer der genannten                                    | `{ field: result, one_of: [succeeded, partiallySucceeded] }` |
| `min`, `max`     | Zahl ≥ bzw. ≤ Grenze; bei Listen die Anzahl                     | `{ field: failed, max: 0 }`                           |
| `present: true`  | Wert ist weder leer noch `null` noch leere Liste                | `{ present: true }`                                   |
| `not_after`      | Zeitpunkt in `field` liegt nicht nach dem Zeitpunkt im genannten Feld | `{ field: first_response_at, not_after: due_at }` |

Keine regulären Ausdrücke aus YAML (D7). Ein Rohwert, auf den der Operator nicht passt (fehlendes Feld, Text statt Zahl), ergibt `beleg_ungueltig`.

### 5.4 Vorlage und Regeln für Akzeptanzkriterien (`acceptance`)

- `template` (nur Typ-Dateien): Markdown-Gerüst, ausgeliefert als `template://{type}`.
- `rules` (Basis und Typ): Liste von Regeln mit `id` (`^AK-[A-Z0-9-]+$`), `kind` und Parametern. Die Basis-Regeln gelten für jeden Typ; ein Typ ergänzt eigene.

| `kind`               | Parameter                                         | Prüft                                                                                      |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `gherkin`            | –                                                 | jedes Szenario hat Gegeben/Angenommen, Wenn und Dann (DE und EN), in dieser Reihenfolge     |
| `observable_then`    | `phrases`                                         | Dann-Schritte ohne Unbeobachtbares („versteht“, „ist zufrieden“, „funktioniert korrekt“)    |
| `vague_words`        | `words`                                           | vage Wörter in jeder Zeile („schnell“, „usw.“)                                             |
| `numbers_need_units` | `units`                                           | Zahlen ohne Einheit oder Bezugswort („unter 2“ statt „unter 2 s“)                          |
| `fields`             | `fields: [{name, list?, min_items?, format?}]`    | Pflichtfelder wie `Zweck:`, `Zielgruppe:`; Listenlänge; Format `date`, `duration`, `date_or_duration` |

Eine neue Regelart ist eine Codeänderung, ein neuer Typ mit vorhandenen Regelarten nicht (D7).

### 5.5 Zuordnung (`types.yaml`)

```yaml
# FIKTIVES BEISPIEL
version: 1
mappings:
  software-dev: { ticket_types: [Story, Bug], labels: [code] }
  dokument: { ticket_types: [Dokument], labels: [doku] }
  kundenanfrage: { ticket_types: [Anfrage], labels: [kunde] }
```

- Vergleich ohne Groß-/Kleinschreibung, Leerzeichen am Rand abgeschnitten.
- Ein Ticket-Typ oder Label darf nur einem Aufgabentyp zugeordnet sein; sonst ist `types.yaml` ungültig (mit Zeile).
- Ein Schlüssel ohne passende Typ-Datei ist ein Fehler. Eine Typ-Datei ohne Zuordnung ist erlaubt; sie ist dann nur mit ausdrücklichem `type` erreichbar und in `dod://types` als `mapped: false` markiert.

### 5.6 Vererbung: nur ergänzen

Ein Typ erbt alle Kriterien und Regeln der Basis und darf nur ergänzen. Durchgesetzt wird das an drei Stellen:

1. **Striktes Schema.** Es gibt keinen Schlüssel zum Entfernen oder Ändern. Jeder unbekannte Schlüssel ist ein Fehler. Schlüssel, die nach Entfernen oder Überschreiben aussehen (`remove`, `exclude`, `omit`, `without`, `override`, `replace`, auch im Plural), bekommen einen eigenen, klaren Fehlercode.
2. **ID-Kollision.** Ein Kriterium oder eine Regel mit einer ID aus der Basis gilt als Überschreiben, auch wenn der Inhalt gleich ist.
3. **`extends: base` ist Pflicht.** Fehlt es oder steht dort etwas anderes, hätte der Typ die Basis abgelegt.

**Validierungsfehler.** Jeder Fehler hat Datei, Zeile, Spalte, Code und Meldung; bei Kollisionen zusätzlich die Stelle in der Basis. Die Zeile kommt vom YAML-Knoten (bei fehlenden Pflichtfeldern: der Knoten des Eltern-Objekts).

| Code                              | Wann                                                                    |
| --------------------------------- | ----------------------------------------------------------------------- |
| `yaml_syntax`                     | Datei ist kein gültiges YAML                                            |
| `feld_fehlt`                      | Pflichtfeld fehlt (auch prüfartabhängig: `question`, `role`, `expect`)  |
| `unbekanntes_feld`                | Schlüssel nicht im Schema oder nicht passend zur Prüfart                |
| `falscher_wert`                   | falscher Typ, unbekannte Prüfart, mehr als ein Operator in `expect`     |
| `basis_kriterium_ueberschrieben`  | Kriterium- oder Regel-ID der Basis im Typ; `override`/`replace`         |
| `basis_kriterium_entfernt`        | `remove`/`exclude`/`omit`/`without`; `extends` fehlt oder ist nicht `base` |
| `id_doppelt`                      | dieselbe ID zweimal in einer Datei                                      |
| `typ_passt_nicht_zur_datei`       | `type` ungleich Dateiname, oder Dateiname verletzt das Muster           |
| `zuordnung_ungueltig`             | `types.yaml`: unbekannter Typ, Ticket-Typ oder Label doppelt vergeben   |

Beispiel (Tool-Antwort, Text):

```text
dod_ungueltig: Die DoD für software-dev ist ungültig (1 Fehler).
  software-dev.yaml:31:7 basis_kriterium_ueberschrieben: Kriterium ZWEITE-PERSON steht schon in base.yaml:24. Ein Typ darf die Basis nur ergänzen.
Hint: Gilt das Kriterium zusätzlich, gib ihm eine eigene ID. Soll sich die Basis ändern, ändere base.yaml per Pull Request.
```

**Folgen eines Fehlers.** Eine ungültige Typ-Datei legt nur diesen Typ lahm. Sie bleibt als Ressource sichtbar und zeigt dort ihre Fehler (D5); die Tools melden für diesen Typ `dod_ungueltig`. Ist `base.yaml` ungültig, sind alle Typen ungültig. Ist `types.yaml` ungültig, geht die Auflösung über Ticket-Typ und Labels nicht mehr, ein ausdrückliches `type` schon.

## 6. Typ-Auflösung

Eingabe (bei `get_dod`, `check_dod`, `lint_acceptance_criteria` gleich): `type`, `ticket_type`, `labels`.

1. Aus `ticket_type` und jedem Label die Kandidaten nach `types.yaml` sammeln.
2. **Ohne `type`:** genau ein Kandidat → dieser Typ (`resolution.via: ticket_type` bzw. `label`). Kein Kandidat → `typ_unbekannt`. Mehrere → `typ_mehrdeutig`.
3. **Mit `type`:** Er muss eine gültige oder ungültige Typ-Datei sein, sonst `typ_unbekannt`. Ergeben Ticket-Typ und Labels Kandidaten, muss `type` darunter sein, sonst `typ_widerspruch`. So löst ein ausdrückliches `type` eine Mehrdeutigkeit auf, sichtbar als `resolution.via: explicit` mit allen Kandidaten (Frage F2).
4. Nichts angegeben → `typ_fehlt`.

Es gibt keinen Standardtyp. Beispiele mit den fiktiven Daten: `ticket_type: Story` → `software-dev`; `ticket_type: Epic` → `typ_unbekannt` (Hint nennt bekannte Ticket-Typen und Labels); `ticket_type: Story, labels: [doku]` → `typ_mehrdeutig` (Hint: „Story → software-dev, doku → dokument. Labels im Ticket korrigieren oder `type` mit einem der Kandidaten angeben.“).

## 7. Ressourcen

| URI                     | Typ                | Inhalt                                                                                                    |
| ----------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `dod://types`           | `application/json` | Basis (Datei, Version, Anzahl Kriterien), je Typ: Titel, Versionen, Fassung, URI, Zuordnung, gültig ja/nein; Fehler |
| `dod://type/{type}`     | `application/json` | **eine Ressource je Typ-Datei**: Basis und Typ zusammengeführt, jedes Kriterium mit `origin` (`base` oder Typ), Datei und Zeile; Regeln mit Herkunft; Verweise auf Vorlage und Rubrik |
| `template://{type}`     | `text/markdown`    | Vorlage für Akzeptanzkriterien und die Liste der Regeln, die `lint_acceptance_criteria` für diesen Typ anwendet |
| `rubric://dod/{type}`   | `text/markdown`    | Urteilskriterien aus Basis und Typ: Frage, Maßstäbe `plausibel`/`zweifelhaft`, Anleitung (Zitat Pflicht); Bestätigungen als „nicht vom Modell zu entscheiden: Rolle X“ |

- Die drei Typ-Ressourcen sind Ressourcen-Templates mit `list`-Callback: `resources/list` zählt jede Typ-Datei im Ordner auf, ohne Codeänderung für neue Typen. `complete` ergänzt `{type}`.
- Eine ungültige Typ-Datei wird ebenfalls gelistet (Titel mit „ungültig“). Lesen liefert `{ type, valid: false, errors: [...] }` bzw. eine Markdown-Fehlerliste, damit man beim Lesen sieht, welche Zeile zu ändern ist (D5).
- Ein Typ ohne Datei ergibt `ResourceNotFoundError` (JSON-RPC −32602), wie in `course-standards-mcp`.
- Rubrik und Vorlage entstehen aus derselben Datei, gegen die der Server prüft; Prüfung und Lesestoff können nicht auseinanderlaufen.
- `dod://type/{type}/version/{n}` (frühere Fassungen) bleibt offen, zusammen mit `diff_dod` (Abschnitt 15).

## 8. Tools

Alle drei sind nur lesend (`readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`). Jedes liefert eine kurze Markdown-Zusammenfassung, das JSON als Text und `structuredContent` passend zu einem `outputSchema` (zod v4). Fachfehler kommen als `isError` mit `code`, Meldung und `hint`, ohne `structuredContent` (Erfahrung aus `miro-board-mcp`: der Inspector prüft es sonst gegen das Schema).

### 8.1 `get_dod`

```ts
input = z.object({
  type: z.string().optional(),
  ticket_type: z.string().max(100).optional(),
  labels: z.array(z.string().max(100)).max(50).optional(),
});
```

- Mit Angaben: die zusammengeführte DoD des aufgelösten Typs, dieselbe Form wie `dod://type/{type}`, plus `resolution`. Für jedes Beleg-Kriterium stehen `source`, `expect`, `max_age_hours`, `same_ref` und `fetch_with` darin, damit der Agent weiß, was er sammeln muss.
- Ohne Angaben: die Übersicht wie `dod://types`. Das hilft Clients, die Ressourcen nicht von sich aus lesen.
- Fachfehler: `typ_unbekannt`, `typ_mehrdeutig`, `typ_widerspruch`, `dod_ungueltig`, `dod_nicht_lesbar`.

### 8.2 `check_dod`

```ts
const Evidence = z.object({
  criterion: z.string(),                  // Kriterium-ID
  source: z.string().max(200),            // System, z. B. "sonarqube"
  tool: z.string().max(200),              // MCP-Tool, das den Wert geliefert hat
  arguments: z.record(z.string(), z.unknown()).optional(), // zum Nachvollziehen
  retrieved_at: z.string(),               // ISO 8601 mit Zeitzone
  raw: z.unknown(),                       // Rohwert, wie das Tool ihn lieferte (≤ 10 KB serialisiert)
  ref: z.string().max(100).optional(),    // Stand, zu dem der Wert gehört (Commit)
  link: z.string().url().max(500).optional(),
});
input = z.object({
  item: z.object({
    id: z.string().min(1).max(100),
    type: z.string().optional(),
    ticket_type: z.string().optional(),
    labels: z.array(z.string()).max(50).optional(),
    ref: z.string().max(100).optional(),  // aktueller Commit des Items
  }),
  evidence: z.array(Evidence).max(100).default([]),
  as_of: z.string().optional(),           // Bezugszeitpunkt fürs Alter; Standard: jetzt
});
```

Zeitpunkte prüft der Server selbst und nicht im Schema, damit ein fehlerhafter Beleg nur sein Kriterium trifft und nicht den ganzen Aufruf.

**Ablauf je Kriterium.** Liegen mehrere Belege vor, entscheidet der jüngste mit lesbarem Zeitpunkt; die anderen nennt der Befund `mehrere_belege`.

| Prüfart       | Lage                                                                 | Status           | Befund                     |
| ------------- | -------------------------------------------------------------------- | ---------------- | -------------------------- |
| `evidence`, `attestation` | kein Beleg                                               | `nicht erfüllt`  | `beleg_fehlt` bzw. bei Bestätigung `bestaetigung_fehlt` (F1) |
| `evidence`, `attestation` | Zeitpunkt unlesbar, ohne Zeitzone oder nach `as_of`; Rohwert passt nicht zu `expect` | `nicht erfüllt` | `beleg_ungueltig` |
| `evidence`, `attestation` | älter als `max_age_hours`                                | `nicht erfüllt`  | `beleg_veraltet`           |
| `evidence`    | `same_ref`, aber Item oder Beleg ohne `ref`                          | `nicht erfüllt`  | `stand_fehlt`              |
| `evidence`    | `same_ref` und `ref` verschieden (gleich auch, wenn einer Präfix des anderen ist, ab 7 Zeichen) | `nicht erfüllt` | `beleg_anderer_stand` |
| `evidence`    | Wert erfüllt `expect` nicht                                          | `nicht erfüllt`  | `erwartung_verfehlt`       |
| `attestation` | `raw.role` ist nicht die verlangte Rolle, oder `raw.by` fehlt         | `nicht erfüllt`  | `rolle_passt_nicht`        |
| `evidence`, `attestation` | sonst einwandfrei, aber `tool` nicht in `fetch_with`     | `braucht Urteil` | `quelle_unerwartet`        |
| `evidence`, `attestation` | einwandfrei                                              | `erfüllt`        | –                          |
| `judgment`    | immer; mitgegebene Belege erscheinen als Material                    | `braucht Urteil` | –                          |

- **Werkzeugabgleich.** Verglichen wird nur der Tool-Name nach dem letzten `:` oder `__`. So passen `mcp__sonarqube__get_project_quality_gate_status`, `sonarqube:get_project_quality_gate_status` und `get_project_quality_gate_status` gleichermaßen; den Servernamen vergibt jeder Client selbst.
- **Hinweis je Befund.** Bei `beleg_fehlt`, `beleg_veraltet`, `beleg_anderer_stand` und `stand_fehlt` sagt `hint`, mit welchem Tool und für welchen Stand der Beleg zu holen ist, z. B. „Mit get_project_quality_gate_status für Commit 9f2c1ab holen.“ Bei `bestaetigung_fehlt`: „Bestätigung der Rolle Betrieb einholen; der Agent bestätigt nicht selbst.“
- **Reproduzierbar.** `as_of` steht im Ergebnis. Gleiche Eingabe mit gleichem `as_of` ergibt dieselbe Ausgabe.
- **Belege zu unbekannten Kriterien** sind kein Fehler; sie stehen unter `unused_evidence`.
- **Kein Gesamtstatus.** Die Zusammenfassung zählt nur. Der Text endet mit „Ob DEMO-42 done ist, entscheidet das Team.“

Ausgabe (gekürzt, fiktiv):

```jsonc
{
  "item": { "id": "DEMO-42", "ref": "9f2c1ab" },
  "type": "software-dev",
  "dod_version": "software-dev@4+base@2",
  "resolution": { "via": "ticket_type", "candidates": ["software-dev"] },
  "as_of": "2026-11-14T10:00:00Z",
  "summary": { "criteria": 9, "erfuellt": 4, "nicht_erfuellt": 3, "braucht_urteil": 2 },
  "criteria": [
    {
      "id": "QUALITY-GATE", "origin": "software-dev", "check": "evidence",
      "text": "Das Quality Gate ist für den geprüften Commit grün.",
      "status": "nicht erfüllt",
      "evidence": { "source": "sonarqube", "tool": "get_project_quality_gate_status",
                    "retrieved_at": "2026-11-14T09:40:00Z", "age_hours": 0.3,
                    "raw": "{\"status\":\"OK\"}", "ref": "71be0d4" },
      "findings": [{ "code": "beleg_anderer_stand",
                     "message": "Der Beleg gehört zu 71be0d4, das Item steht auf 9f2c1ab." }],
      "hint": "Mit get_project_quality_gate_status für Commit 9f2c1ab holen.",
      "who_decides": "Server, aus dem Beleg"
    },
    {
      "id": "FOLGEARBEIT", "origin": "base", "check": "judgment",
      "status": "braucht Urteil",
      "question": "Welche offene Folgearbeit aus dem Ergebnis ist noch nicht als eigenes Item erfasst?",
      "rubric": "rubric://dod/software-dev",
      "who_decides": "Modell schätzt ein, Team entscheidet"
    }
  ],
  "unused_evidence": [],
  "limits": ["Belege stammen vom Agenten; der Server prüft Form, Alter, Stand und Wert, nicht ihre Echtheit."]
}
```

Rohwerte werden in der Ausgabe auf 200 Zeichen gekürzt.

### 8.3 `lint_acceptance_criteria`

```ts
input = z.object({
  text: z.string().max(50_000),
  type: z.string().optional(),
  ticket_type: z.string().optional(),
  labels: z.array(z.string()).max(50).optional(),
});
```

Nur Text, kein Dateipfad: Akzeptanzkriterien stehen im Ticket, der Agent übergibt sie (D14). Der Server wendet die Regeln aus Basis und Typ an und meldet jeden Befund mit Zeile (1-basiert, bezogen auf `text`), Spalte, Auszug (≤ 120 Zeichen), Regel-ID, Herkunft, Meldung und Hinweis. Fehlt ein Feld ganz, zeigt die Zeile auf Zeile 1.

| Regelart             | Befund                                         | Schwere   |
| -------------------- | ---------------------------------------------- | --------- |
| `gherkin`            | `kein_szenario`, `gwt_unvollstaendig`          | `fehler`  |
| `gherkin`            | `reihenfolge` (Gegeben nach Wenn, Wenn nach Dann) | `warnung` |
| `observable_then`    | `dann_nicht_beobachtbar`                       | `warnung` |
| `vague_words`        | `vages_wort`                                   | `warnung` |
| `numbers_need_units` | `zahl_ohne_einheit`                            | `warnung` |
| `fields`             | `feld_fehlt`, `feld_leer`, `liste_zu_kurz`, `feld_format` | `fehler` |

**Erkennung, deterministisch:**

- **Szenarien.** Eine Zeile `Szenario:`/`Scenario:` beginnt ein Szenario. Ohne solche Zeilen ist jeder durch Leerzeilen getrennte Block mit mindestens einem Schritt ein Szenario. Schritte erkennt der Server am Zeilenanfang (nach Aufzählungszeichen): `Angenommen`, `Gegeben (sei)`, `Given`; `Wenn`, `When`; `Dann`, `Then`; `Und`, `Aber`, `And`, `But` setzen den vorigen Schritt fort.
- **Wörter und Phrasen.** Ohne Groß-/Kleinschreibung, an Wortgrenzen (Unicode), wörtlich, nicht als regulärer Ausdruck.
- **Zahlen.** Nur Wörter, die ganz aus einer Zahl bestehen (`2`, `0,5`, `30%`). Daten, Uhrzeiten, Versionen, IDs und Aufzählungsnummern am Zeilenanfang zählen nicht. In Ordnung ist eine Zahl, an der eine Einheit hängt oder auf die eine Einheit aus `units` oder ein großgeschriebenes Wort folgt (deutsches Substantiv: „3 Einträge“). Bei Bereichen („2 bis 5 Sekunden“, „2–5 s“) zählt die Einheit am Ende.
- **Felder.** Eine Zeile `Name:` (auch als Aufzählung oder fett). Listen sind die Aufzählungszeilen bis zur nächsten Leerzeile oder zum nächsten Feld.

Ausgabe: `{ type, dod_version, resolution, rules_applied: [{id, kind, origin}], summary: {fehler, warnung}, findings: [...], truncated }`, höchstens 100 Befunde.

## 9. Fachfehler und Protokollfehler

Wie in den beiden Vorbildern: Ein **Fachfehler** heißt, das Tool hat die Anfrage verstanden, kann sie mit dieser Eingabe aber nicht erledigen. Er kommt als Tool-Ergebnis mit `isError: true`, stabilem `code`, Meldung und `hint`, damit sich der Agent korrigiert. Ein **Protokollfehler** (unbekanntes Tool, kaputte Anfrage, unbekannte Ressource) kommt als JSON-RPC-Fehler. Unerwartete Ausnahmen fängt der Server, schreibt den Stack nach stderr und meldet nur „internal_error, siehe Server-Log“.

| Code               | Wann                                                         | Hint                                                                  |
| ------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `typ_fehlt`        | weder `type` noch `ticket_type` noch `labels`                | Ticket-Typ und Labels aus dem Ticket übergeben                        |
| `typ_unbekannt`    | kein Kandidat, oder `type` ohne Datei                        | nennt Typen, Ticket-Typen und Labels aus `types.yaml`                 |
| `typ_mehrdeutig`   | mehrere Kandidaten ohne `type`                               | nennt je Kandidat, was ihn ausgelöst hat; Labels korrigieren oder `type` wählen |
| `typ_widerspruch`  | `type` ist nicht unter den Kandidaten                        | nennt die Kandidaten                                                  |
| `dod_ungueltig`    | Basis, Typ-Datei oder (bei Auflösung über Ticket) `types.yaml` ungültig | Fehler mit Datei:Zeile:Spalte; Datei korrigieren, der Server liest bei jedem Aufruf neu |
| `dod_nicht_lesbar` | Ordner fehlt oder `base.yaml` fehlt                          | nennt `DOD_DIR`                                                       |
| `text_leer`        | `lint_acceptance_criteria` mit leerem Text                   | –                                                                     |

`text` über 50.000 Zeichen und zu viele Belege lehnt schon das Eingabeschema ab; das SDK meldet das ebenfalls als `isError`.

## 10. Transport und Sicherheit

**stdio**, ein Nutzer, ein Rechner, kein Schlüssel. stdout trägt nur JSON-RPC, alles andere geht nach stderr. Eine geteilte Organisations-DoD über Streamable HTTP mit OAuth 2.1 ist ein späterer Schritt (Skizze, Abschnitt 4).

| #  | Bedrohung                                                       | Begrenzung                                                                                               |
| -- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| T1 | Agent erfindet oder überträgt Belege falsch                     | strukturierte Belege mit Tool, Argumenten, Zeitpunkt, Rohwert; Abgleich mit `fetch_with`, Alter, Stand; der Mensch sieht jeden Tool-Aufruf im Verlauf; für teure Kriterien später dieselbe Prüfung in CI (offen) |
| T2 | Ein Agentenbericht wird als „done“ gelesen                      | kein Gesamtstatus, kein schreibendes Tool, `who_decides` je Kriterium, Schlusssatz im Text               |
| T3 | Prompt Injection in Rohwerten oder Akzeptanzkriterien           | der Server behandelt sie als Daten, führt nichts aus, kürzt Rohwerte; das Modell im Client bleibt das Risiko |
| T4 | Ein Typ schwächt die Basis still ab                              | striktes Schema, ID-Kollision, Pflicht `extends: base` (5.6)                                             |
| T5 | YAML-Missbrauch (Alias-Bombe, riesige Datei)                    | `yaml` mit Core-Schema, ohne eigene Tags, `maxAliasCount: 100`, Dateien ≤ 100 KB, ≤ 50 Typ-Dateien, ≤ 200 Kriterien je Datei |
| T6 | ReDoS über Muster aus Teamdateien                               | keine regulären Ausdrücke aus YAML; Wortlisten werden escaped                                            |
| T7 | Kundendaten im Modellkontext (Kundenanfragen)                   | der Server braucht für Belege nur Zeitstempel und Zahlen; was das Modell für Urteile liest, regelt der Client (Skizze, Frage 7) |
| T8 | Pfade                                                           | nur der konfigurierte Ordner, nur `*.yaml` darin, keine Unterordner, keine Pfadeingabe in Tools          |

## 11. Grenzen

| Grenze                                                     | Wie der Server es zeigt                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Belege kommen vom Agenten (Variante B)                     | `limits` im Ergebnis; `quelle_unerwartet` → `braucht Urteil`                   |
| Wer eine Bestätigung gegeben hat, prüft der Server nicht   | `by` muss nur gesetzt sein; `limits`                                           |
| Zahlen-Regel nutzt Großschreibung deutscher Substantive    | in der Vorlage und in `limits` des Lint-Ergebnisses genannt                    |
| Wortlisten finden keine Umschreibungen                     | Lint ist eine Hilfe, kein Urteil; die Rubrik fragt nach dem Inhalt             |
| Szenarien ohne Schlüsselwörter (Fließtext)                 | `kein_szenario` statt Raten                                                    |
| Frühere Fassungen und Vergleich                            | offen (`diff_dod`, `…/version/{n}`)                                           |

## 12. Fiktive Beispieldaten

Ein erfundenes Team mit drei Aufgabentypen, angelehnt an die Tabelle der Skizze (3.1):

| Datei                | Version | Beleg (`evidence`)                                                 | Urteil (`judgment`)                          | Bestätigung (`attestation`) | Regeln für Akzeptanzkriterien             |
| -------------------- | ------- | ------------------------------------------------------------------ | -------------------------------------------- | --------------------------- | ----------------------------------------- |
| `base.yaml`          | 2       | `ERGEBNIS-VERLINKT`                                                | `FOLGEARBEIT`                                | `ZWEITE-PERSON` (Teammitglied) | `AK-VAGE`                              |
| `software-dev.yaml`  | 4       | `QUALITY-GATE`, `BUILD`, `TESTS` (alle `same_ref`, 24 h), `TESTAENDERUNG-AUSGEWIESEN` | `AK-GETESTET`              | `RUNBOOK` (Betrieb)         | `AK-GWT`, `AK-DANN`, `AK-EINHEIT`, `AK-VAGE-SW` |
| `dokument.yaml`      | 2       | `PFLICHTABSCHNITTE`, `LINKS` (72 h), `BEGRIFFE`                    | `ZWECK-ZIELGRUPPE`, `SYSTEMSTAND`            | `FACHFREIGABE` (Fachverantwortung) | `AK-FELDER` (Zweck, Zielgruppe, Umfang), `AK-VAGE-DOK` |
| `kundenanfrage.yaml` | 3       | `FRIST`                                                            | `VOLLSTAENDIG`, `WISSENSBASIS`               | `ZUSAGE` (Vertrieb)         | `AK-FELDER` (Fragen als Liste, Frist), `AK-VAGE-KA` |

Dazu `examples/` mit fiktiven Belegen (JSON) je Typ, einmal mit Lücken und einmal vollständig, und Akzeptanzkriterien je Typ mit absichtlichen Befunden. Tests und Demo nutzen dieselben Dateien. Testfälle für ungültige DoDs liegen unter `test/fixtures/`.

## 13. Entscheidungen

**D1 Belege sammelt der Agent (Variante B).** Entscheidung: Der Agent holt Belege über die offiziellen Server und übergibt sie strukturiert; der Server prüft Form, Alter, Stand und Wert. Alternative: Server holt sie selbst über APIs (A). Grund: kein Schlüssel, Rechte der angemeldeten Person, keine eigenen API-Clients, mit festen Testdaten prüfbar (Skizze 3.3). A bleibt der CI vorbehalten.

**D2 Urteil im Client-Modell.** Entscheidung: Für Urteilskriterien liefert der Server Frage und Maßstab, das Modell schätzt ein. Alternative: Modellaufruf im Server oder Sampling. Grund: reproduzierbar, testbar, kein Schlüssel; Sampling ist abgekündigt. Die Rubrik entsteht aus derselben Datei.

**D3 Kein Gesamtstatus.** Entscheidung: nur Status je Kriterium und Zählung. Alternative: `done: true/false` oder Ampel. Grund: „done“ entscheidet das Team; ein Gesamtwert würde als Entscheidung gelesen.

**D4 Eine Datei je Typ, Typname = Dateiname.** Entscheidung: Erkennung über den Ordnerinhalt, eine Ressource je Datei über `list`-Callback. Alternative: alle Typen in einer Datei oder eine Typ-Liste im Code. Grund: neuer Typ ohne Codeänderung; jede Änderung ist ein überschaubarer Diff einer Datei.

**D5 Ungültige Typen bleiben sichtbar.** Entscheidung: Eine ungültige Typ-Datei wird gelistet und zeigt beim Lesen ihre Fehler; nur ihre Tools melden `dod_ungueltig`, andere Typen arbeiten weiter. Alternative: Server startet nicht, oder die Datei verschwindet still. Grund: Wer die Ressource liest, sieht sofort Datei und Zeile; ein Tippfehler in einem Typ legt nicht das ganze Team lahm.

**D6 Parser `yaml` statt `js-yaml`.** Entscheidung: `yaml` mit `LineCounter`; zod-Fehlerpfade werden auf Knoten und Zeilen abgebildet. Alternative: `js-yaml` wie in `course-standards-mcp`. Grund: Fehler mit Datei und Zeile sind Pflicht, `js-yaml` liefert Positionen nur für Syntaxfehler.

**D7 Feste Operatoren und Regelarten.** Entscheidung: fünf `expect`-Operatoren und fünf Regelarten im Code, in YAML nur parametriert. Alternative: Regex oder Ausdrücke in YAML. Grund: erklärbar, testbar, kein ReDoS; neue Typen brauchen keinen Code, neue Prüfarten bewusst schon.

**D8 Typ-Auflösung ohne Standard.** Entscheidung: genau ein Kandidat aus Ticket-Typ und Labels; ein ausdrückliches `type` nur als Wahl unter den Kandidaten oder ohne Ticketangaben. Alternative: Vorrang Ticket-Typ vor Label, oder ein Standardtyp. Grund: Ein falsch zugeordnetes Item würde gegen die falsche DoD geprüft und sähe trotzdem „grün“ aus.

**D9 Fehlender Beleg ist `nicht erfüllt`.** Entscheidung: `beleg_fehlt` ergibt `nicht erfüllt`. Alternative: `braucht Urteil`. Grund: „braucht Urteil“ heißt, mit dem vorhandenen Material kann jemand entscheiden; ohne Material ist das Kriterium nicht nachgewiesen (Frage F1).

**D10 `as_of` als Eingabe.** Entscheidung: Bezugszeitpunkt optional als Eingabe, im Ergebnis immer genannt. Alternative: immer die Serveruhr. Grund: gleiche Eingabe, gleiche Ausgabe; Tests ohne Uhr-Mocks.

**D11 Unerwartete Quelle ist `braucht Urteil`.** Entscheidung: Ein Beleg aus einem Tool, das nicht in `fetch_with` steht, wird nicht verworfen, sondern dem Menschen vorgelegt. Alternative: `nicht erfüllt`. Grund: Teams nutzen verschiedene Systeme; der Server kann nicht wissen, ob der Wert gleichwertig ist, ein Mensch schon.

**D12 Drei Tools.** Entscheidung: `get_dod`, `check_dod`, `lint_acceptance_criteria`; `get_dod` ohne Angaben ersetzt ein `list_types`. Alternative: je Typ ein Tool oder ein eigenes Listen-Tool. Grund: wenige Tools, weniger Fehlgriffe des Modells; die Typen sind Daten, keine Tools.

**D13 Kein Cache.** Entscheidung: Ordner bei jedem Aufruf lesen. Alternative: einmal beim Start laden. Grund: wenige kleine Dateien; eine neue Typ-Datei erscheint ohne Neustart.

**D14 Lint nur über Text.** Entscheidung: `lint_acceptance_criteria` nimmt nur `text`. Alternative: `path` wie in `course-standards-mcp`. Grund: Akzeptanzkriterien stehen im Ticket; keine Pfadeingabe heißt keine Pfadprüfung.

**D15 Sprache.** Entscheidung: Status, Befunde, Fehlercodes, Ressourcen und Meldungen deutsch; YAML-Schlüssel, Code, Kommentare und Commit-Messages englisch. Alternative: alles englisch wie die beiden Vorbilder. Grund: Die Skizze und das Teamgespräch sind deutsch, die Statuswörter stehen in der Skizze; Schlüssel bleiben wie im Skizzenbeispiel englisch.

**D16 SDK und Werkzeuge wie die Vorbilder.** `@modelcontextprotocol/server` 2.4.0, TypeScript strict (`NodeNext`), zod v4, `node --test`, ESLint, Prettier; `@modelcontextprotocol/client` 2.4.0 für den Protokolltest.

**D17 Ausgabe-Budget.** Rohwerte ≤ 200 Zeichen, Auszüge ≤ 120 Zeichen, ≤ 100 Lint-Befunde. Ziel unter 8.000 Tokens für eine DoD mit 20 Kriterien.

## 14. Projektlayout und Testplan

```
dod-mcp/
  dod/                         fiktive DoD (Abschnitt 12)
  examples/                    fiktive Belege (JSON) und Akzeptanzkriterien (Markdown)
  src/server.ts                McpServer, stdio, Registrierung
  src/config.ts                DOD_DIR, Grenzen
  src/logger.ts                nur stderr
  src/errors.ts                DomainError, success, guarded
  src/dod/yamlFile.ts          Parsen mit Positionen, zod-Pfad → Zeile
  src/dod/schema.ts            zod-Schemas für Basis, Typ, types.yaml
  src/dod/load.ts              Ordner lesen, validieren, Fehlerliste
  src/dod/merge.ts             Basis + Typ mit Herkunft, Fassungskennung
  src/dod/resolve.ts           Typ-Auflösung (Abschnitt 6)
  src/check/expect.ts          Operatoren
  src/check/checkDod.ts        Status und Befunde (8.2)
  src/lint/                    Regelarten und Lint-Lauf (8.3)
  src/render/                  Rubrik und Vorlage als Markdown
  src/resources.ts  src/tools/
  test/                        node:test; test/fixtures/ mit ungültigen DoDs
  docs/design.md
```

**Tests:**

1. **Laden:** die Beispieldaten sind gültig; je ungültigem Fixture der erwartete Code mit Datei und Zeile (Basiskriterium überschrieben, `remove`, `extends` fehlt, unbekanntes Feld, `judgment` ohne `question`, doppelte ID, YAML-Syntax, Typ ≠ Dateiname, Label doppelt in `types.yaml`).
2. **Neuer Typ ohne Code:** Beispielordner in ein Temp-Verzeichnis kopieren, `einkauf.yaml` hinzufügen; `dod://types`, `resources/list`, `get_dod`, Vorlage und Rubrik kennen den Typ.
3. **Auflösung:** eindeutig, unbekannt, mehrdeutig, ausdrücklich unter Kandidaten, Widerspruch, nichts angegeben.
4. **`check_dod`:** jeder Befund aus 8.2 einzeln; Zählung; `unused_evidence`; gleiche Ausgabe bei gleichem `as_of`; Beispielbelege mit Lücken und vollständig.
5. **Lint:** je Typ ein Text mit Befunden an bekannten Zeilen und ein sauberer Text ohne Befund; Zahlen mit Daten, Uhrzeiten, Bereichen.
6. **Protokoll:** Server als Kindprozess über stdio mit dem offiziellen Client; drei Tools, alle `readOnlyHint`; `resources/list` enthält `dod://types` und je Typ-Datei `dod://type/…`, `template://…`, `rubric://dod/…`; unbekanntes Tool → JSON-RPC-Fehler; mehrdeutiger Typ → `isError` mit `hint`.
7. **Budget:** `check_dod` auf `software-dev` unter 8.000 Tokens (Zeichen / 4).
8. **Vor jedem Commit:** Portfolio-Denylist ohne Treffer (nur Dateinamen ausgeben).

## 15. Offene Punkte

- **`diff_dod` und `dod://type/{type}/version/{n}`:** brauchen die Git-Historie des Team-Repositorys (lesend, z. B. `git show <rev>:dod/<type>.yaml`). Erst wenn klar ist, ob der Server Git aufrufen darf oder der Client zwei Fassungen übergibt.
- **`procedure://done-check`, `…/refinement`, `…/dod-review`** und die Prompt-Vorlagen **`refine_item`** und **`dod_review`** aus der Skizze.
- **Prüfung in CI (Variante A):** dieselbe `check_dod`-Logik als CLI mit Lese-Token für Quality Gate und Build.
- **Organisations-DoD als Minimum** (Skizze, Frage 1): eine weitere Ebene über `base.yaml` mit derselben Regel „nur ergänzen“.
- **Streamable HTTP mit OAuth 2.1** für eine geteilte DoD.

## 16. Fragen zur Freigabe

| #  | Frage                                                                                                         | Vorschlag                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| F1 | Fehlender Beleg oder fehlende Bestätigung: `nicht erfüllt` (D9)?                                               | ja                                                                                             |
| F2 | Darf ein ausdrückliches `type` eine Mehrdeutigkeit auflösen, wenn es unter den Kandidaten ist (D8)?            | ja, sichtbar als `resolution.via: explicit`                                                    |
| F3 | Zwei kleine Zusätze jetzt mitbauen? (a) CLI `dod-validate` für Pull Requests auf `dod/`, nutzt denselben Loader und zeigt Fehler mit Datei und Zeile im CI-Log; (b) Prompt-Vorlage `done_check(item)` | (a) ja, etwa 40 Zeilen; (b) ja, ohne neue Logik, macht die Demo im Gespräch durchgängig        |
| F4 | Sprache wie D15: Fachvokabular deutsch, Code und Commits englisch?                                             | ja                                                                                             |
