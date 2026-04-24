/**
 * Attendance feature — awareness descriptor (rc.92).
 *
 * Single source of truth for what Luna tells users about the attendance
 * reconciliation pilot. Registered at startup via the feature-awareness
 * registry; `capabilities.ts`, `web-ui-guide.ts`, `telegram.ts /help`,
 * and `matrix.ts !help` all pull their attendance content from here.
 *
 * Keep this file in lockstep with the feature's capabilities. If a new
 * endpoint or Telegram command ships, add it here in the SAME commit —
 * otherwise Luna will happily invent answers about a feature she has
 * actually has.
 */
import { registerFeature } from '../core/feature-awareness.js';

const ATTENDANCE_SYSTEM_PROMPT = `## Attendance Reconciliation (operations pilot — Phase A)
The attendance feature ingests roster + daily check-in data, validates it, and stores it for supervisor reconciliation. Currently only the foundation is live; morning exception lists and the 8:31am management report ship in a later phase. What works TODAY:

**Admin UI at /attendance/admin** — role-gated web interface with four tabs:
- Ingest CSV: pick a module + data type, drag-and-drop the CSV, pick which CSV column maps to each logical field (badge_id, full_name, timestamp_in, etc.), run ingestion, see per-row accepted/skipped results.
- Setup: CRUD for sites, shifts+breaks, modules (with supervisor assignment), absence codes. Seeds the VP's 7 default codes (U/V/DI/PP/P/PT/SI) with one click per site.
- Operations: issue supervisor invitation tokens, file pre-approved future absences (vacation, leave, permit), grant/revoke roles.
- Reports: every ingestion's full audit log — what was read, what was skipped and why.

**Telegram CSV attachments** — HR peers (with the 'hr' role) send a CSV as a Telegram attachment with caption:
- "Roster Data <moduleId>" — upserts the employee roster for that module
- "Check-in Data <moduleId> <YYYY-MM-DD>" — imports one day of T&A records
The caller must have configured the column mapping in the admin UI first (Telegram flow reuses the saved mapping).

**/attendance command suite on Telegram (works for anyone, not only ALLOWED_CHAT_ID):**
- /attendance whoami — show my attendance roles (admin / hr / supervisor / manager)
- /attendance claim <token> — supervisor redeems an admin-issued invitation, links their Telegram chat_id to their module, grants the supervisor role
- /attendance absence <badge> <code> <YYYY-MM-DD> [end-date] [notes] — supervisor (or hr/admin) files a pre-approved future absence so it won't surface as a morning exception

**When to recommend what:**
- User asks "how do I upload the roster / check-in data" → explain both paths (admin UI for first-time setup with column mapping, Telegram attachment for daily uploads after mapping is saved)
- User is a supervisor wanting to register → admin needs to issue them an invite first via Operations tab, then they run "/attendance claim <token>"
- User wants to file a vacation in advance → /attendance absence command or the Operations tab's "Future absences" panel
- User asks "who's missing today" or "send the morning exceptions" → that's Phase B, not yet shipped — tell them honestly when it arrives in a later release

Never fabricate attendance numbers, exception lists, or daily reports — those require Phase B. You CAN explain the current pilot state and guide setup.`;

const ATTENDANCE_TELEGRAM_HELP_BLOCK = `<b>👥 Attendance</b> (pilot)
/attendance — help
/attendance whoami — show your roles
/attendance claim &lt;token&gt; — redeem supervisor invitation
/attendance absence &lt;badge&gt; &lt;code&gt; &lt;YYYY-MM-DD&gt; [end] [notes]
CSV upload: attach file with caption <code>Roster Data &lt;moduleId&gt;</code> or <code>Check-in Data &lt;moduleId&gt; &lt;YYYY-MM-DD&gt;</code>
Admin UI: /attendance/admin`;

const ATTENDANCE_MATRIX_HELP_BLOCK = `👥 Attendance (pilot — note: Telegram handles the live command suite and CSV uploads; Matrix parity is pending)
Admin UI: open /attendance/admin in your browser`;

const ATTENDANCE_SELF_DESCRIPTION_BULLET =
  '**Attendance Reconciliation** (Phase A — foundation live, reconciliation coming): ' +
  'Admin UI /attendance/admin · Telegram CSV uploads (caption Roster/Check-in Data) · ' +
  '/attendance whoami, claim, absence · supervisor invites · future-absence filing';

registerFeature({
  key: 'attendance',
  name: 'Attendance Reconciliation',
  status: 'shipping',
  systemPromptSection: ATTENDANCE_SYSTEM_PROMPT,
  telegramHelpBlock: ATTENDANCE_TELEGRAM_HELP_BLOCK,
  matrixHelpBlock: ATTENDANCE_MATRIX_HELP_BLOCK,
  selfDescriptionBullet: ATTENDANCE_SELF_DESCRIPTION_BULLET,
  webUIGuides: [
    {
      url: '/attendance/admin',
      name: 'Attendance Admin',
      nameEs: 'Administracion de Asistencia',
      description: 'HR/admin console for the attendance reconciliation pilot. Upload roster and daily check-in CSVs with runtime column mapping (no hardcoded HR schema), configure sites/shifts/modules/absence codes, issue supervisor Telegram invitations, file pre-approved future absences.',
      descriptionEs: 'Consola para RH/admin del piloto de reconciliacion de asistencia. Subir CSV de roster y checadas con mapeo de columnas en tiempo real (sin esquema de RH codificado), configurar sitios/turnos/modulos/codigos de ausencia, emitir invitaciones de supervisor por Telegram, registrar ausencias futuras pre-aprobadas.',
      features: [
        'Drag-and-drop CSV upload with 10-row preview + per-field column mapping',
        'Auto-detection of common EN/ES header names (badge, gafete, nombre, fecha, entrada, etc.)',
        'Per-row skip reasons and warnings in ingestion report',
        'Supervisor invitation tokens (one-shot, 24h expiry by default)',
        'VP default absence codes (U/V/DI/PP/P/PT/SI) seedable per site',
        'Role-based access: admin / hr / supervisor / manager',
      ],
      featuresEs: [
        'Carga CSV con arrastrar-y-soltar, vista previa de 10 filas y mapeo por campo',
        'Deteccion automatica de encabezados comunes EN/ES (badge, gafete, nombre, fecha, entrada, etc.)',
        'Razones de omision por fila y advertencias en el reporte de ingesta',
        'Tokens de invitacion de supervisor (un solo uso, expiran en 24h por defecto)',
        'Codigos de ausencia predeterminados (U/V/DI/PP/P/PT/SI) sembrables por sitio',
        'Acceso por rol: admin / hr / supervisor / manager',
      ],
      whenToSuggest: [
        'User asks how to upload roster or check-in data',
        'User asks to configure shifts, modules, or supervisors for attendance',
        'User asks about pre-approved absences, vacations, or permits',
        'User mentions attendance reconciliation, HR data, or badge records',
      ],
      tips: [
        'First-time setup: create site → shift (with breaks) → module → seed absence codes',
        'Upload once via the admin UI to configure the column mapping; Telegram attachments then reuse it',
        'Telegram caption format: "Roster Data <moduleId>" or "Check-in Data <moduleId> <YYYY-MM-DD>"',
        'Supervisors register via /attendance claim <token> after an admin issues the invite',
      ],
      tipsEs: [
        'Configuracion inicial: crear sitio → turno (con descansos) → modulo → sembrar codigos de ausencia',
        'Sube una vez por el admin UI para configurar el mapeo de columnas; los adjuntos de Telegram lo reutilizan',
        'Formato de caption en Telegram: "Roster Data <moduleId>" o "Check-in Data <moduleId> <YYYY-MM-DD>"',
        'Los supervisores se registran con /attendance claim <token> despues de que un admin emite la invitacion',
      ],
    },
  ],
});
