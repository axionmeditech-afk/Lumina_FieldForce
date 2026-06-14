import type { LeaveRequest, PublicHoliday } from "@/lib/types";
import { getMySqlPool, isMySqlStateEnabled } from "@/server/services/mysql-state";
import type { Pool, RowDataPacket } from "mysql2/promise";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tableExists(pool: Pool, tableName: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>("SHOW TABLES LIKE ?", [tableName]);
  return Array.isArray(rows) && rows.length > 0;
}

function normalizeEmail(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

/**
 * Resolve a Dolibarr `nmy5_user.rowid` from a user email.
 */
async function resolveDolibarrUserId(pool: Pool, email: string): Promise<number | null> {
  if (!(await tableExists(pool, "nmy5_user"))) return null;
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT rowid FROM `nmy5_user` WHERE LOWER(TRIM(email)) = ? LIMIT 1",
    [normalizeEmail(email)]
  );
  if (!rows?.[0]?.rowid) return null;
  return Number(rows[0].rowid);
}

/**
 * Map app leave type → Dolibarr fk_type integer.
 * Default Dolibarr holiday config IDs:
 *   1 = Congés payés (paid leave / planned)
 *   4 = RTT / Sick leave (unplanned)
 * We attempt to read from nmy5_holiday_config first; fall back to hardcoded.
 */
async function resolveDolibarrFkType(pool: Pool, leaveType: string): Promise<number> {
  try {
    if (await tableExists(pool, "nmy5_holiday_config")) {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT rowid FROM `nmy5_holiday_config` ORDER BY rowid ASC LIMIT 8"
      );
      if (Array.isArray(rows) && rows.length > 0) {
        // planned → first config row (usually ID 1 = Congés payés)
        // unplanned → 4th config row if exists (usually RTT / sick), else first
        if (leaveType === "unplanned" && rows.length >= 4) {
          return Number(rows[3].rowid);
        }
        return Number(rows[0].rowid);
      }
    }
  } catch {
    // fall through
  }
  return leaveType === "unplanned" ? 4 : 1;
}

/**
 * Map half-day to Dolibarr halfday column value.
 * Dolibarr convention:
 *   0  = full day (both start and end are full days)
 *   2  = start is morning half-day
 *  -2  = end is afternoon half-day
 *  -1  = start afternoon, end morning (rarely used)
 */
function resolveDolibarrHalfday(isHalfDay: boolean): number {
  return isHalfDay ? 2 : 0;
}

// ---------------------------------------------------------------------------
// Sync leave request → nmy5_holiday
// ---------------------------------------------------------------------------

/**
 * Insert a new leave request into Dolibarr's `nmy5_holiday` table
 * and add an audit log to `nmy5_holiday_logs`.
 * Returns the Dolibarr holiday rowid on success, null on failure.
 */
export async function syncLeaveToDolibarrHoliday(leave: LeaveRequest): Promise<number | null> {
  if (!isMySqlStateEnabled()) return null;

  try {
    const pool = await getMySqlPool();

    // Ensure the nmy5_holiday table exists
    if (!(await tableExists(pool, "nmy5_holiday"))) return null;

    // Resolve user
    const fkUser = await resolveDolibarrUserId(pool, leave.userEmail || "");
    if (!fkUser) return null;

    const fkType = await resolveDolibarrFkType(pool, leave.leaveType);
    const halfday = resolveDolibarrHalfday(leave.isHalfDay);
    const leaveDate = leave.leaveDate; // YYYY-MM-DD
    const leaveEndDate = leave.leaveEndDate || leave.leaveDate;
    const nbOpenDay = leave.leaveDays;
    const description = (leave.note || "").slice(0, 2000);
    const refExt = `lff_${leave.id}`;

    // INSERT into nmy5_holiday
    const [result] = await pool.query<any>(
      `INSERT INTO \`nmy5_holiday\`
        (\`entity\`, \`ref_ext\`, \`fk_user\`, \`fk_type\`, \`date_create\`,
         \`date_debut\`, \`date_fin\`, \`halfday\`, \`nb_open_day\`,
         \`statut\`, \`description\`, \`fk_validator\`)
       VALUES (1, ?, ?, ?, NOW(), ?, ?, ?, ?, 1, ?, NULL)`,
      [refExt, fkUser, fkType, leaveDate, leaveEndDate, halfday, nbOpenDay, description]
    );

    const holidayId = result?.insertId ? Number(result.insertId) : null;

    // Log to nmy5_holiday_logs
    if (holidayId && (await tableExists(pool, "nmy5_holiday_logs"))) {
      try {
        await pool.query(
          `INSERT INTO \`nmy5_holiday_logs\`
            (\`date_action\`, \`fk_user_action\`, \`fk_user_update\`,
             \`fk_type\`, \`prevstate\`, \`new_state\`)
           VALUES (NOW(), ?, ?, ?, 0, 1)`,
          [fkUser, fkUser, fkType]
        );
      } catch {
        // Logging is best-effort; do not fail the main sync
      }
    }

    return holidayId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sync approval/rejection → nmy5_holiday + nmy5_holiday_logs + nmy5_holiday_users
// ---------------------------------------------------------------------------

/**
 * Update the Dolibarr holiday status on approval or rejection.
 * Also writes an audit log and updates the user's leave balance on approval.
 */
export async function syncLeaveApprovalToDolibarr(
  dolibarrHolidayId: number,
  approved: boolean,
  reviewerEmail?: string,
  leaveDays?: number
): Promise<void> {
  if (!isMySqlStateEnabled()) return;

  try {
    const pool = await getMySqlPool();
    if (!(await tableExists(pool, "nmy5_holiday"))) return;

    const newStatut = approved ? 3 : 5; // 3 = Approved, 5 = Refused
    const prevStatut = 1; // Was Draft/Pending

    // Resolve validator (reviewer) user ID
    let fkValidator: number | null = null;
    if (reviewerEmail) {
      fkValidator = await resolveDolibarrUserId(pool, reviewerEmail);
    }

    // Update nmy5_holiday status
    if (fkValidator) {
      await pool.query(
        "UPDATE `nmy5_holiday` SET `statut` = ?, `fk_validator` = ?, `date_valid` = NOW() WHERE `rowid` = ?",
        [newStatut, fkValidator, dolibarrHolidayId]
      );
    } else {
      await pool.query(
        "UPDATE `nmy5_holiday` SET `statut` = ?, `date_valid` = NOW() WHERE `rowid` = ?",
        [newStatut, dolibarrHolidayId]
      );
    }

    // Read fk_user and fk_type from the holiday record for logging / balance
    const [holidayRows] = await pool.query<RowDataPacket[]>(
      "SELECT `fk_user`, `fk_type`, `nb_open_day` FROM `nmy5_holiday` WHERE `rowid` = ? LIMIT 1",
      [dolibarrHolidayId]
    );
    const fkUser = holidayRows?.[0]?.fk_user ? Number(holidayRows[0].fk_user) : null;
    const fkType = holidayRows?.[0]?.fk_type ? Number(holidayRows[0].fk_type) : 1;
    const nbOpenDay = leaveDays ?? (holidayRows?.[0]?.nb_open_day ? Number(holidayRows[0].nb_open_day) : 1);

    // Log to nmy5_holiday_logs
    if (fkUser && (await tableExists(pool, "nmy5_holiday_logs"))) {
      try {
        await pool.query(
          `INSERT INTO \`nmy5_holiday_logs\`
            (\`date_action\`, \`fk_user_action\`, \`fk_user_update\`,
             \`fk_type\`, \`prevstate\`, \`new_state\`)
           VALUES (NOW(), ?, ?, ?, ?, ?)`,
          [fkValidator || fkUser, fkUser, fkType, prevStatut, newStatut]
        );
      } catch {
        // best-effort logging
      }
    }

    // On approval: update nmy5_holiday_users balance
    if (approved && fkUser && (await tableExists(pool, "nmy5_holiday_users"))) {
      try {
        await pool.query(
          `INSERT INTO \`nmy5_holiday_users\` (\`fk_user\`, \`nb_holiday\`, \`fk_type\`)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE
             \`nb_holiday\` = \`nb_holiday\` - ?`,
          [fkUser, -nbOpenDay, fkType, nbOpenDay]
        );
      } catch {
        // best-effort balance update
      }
    }
  } catch {
    // Dolibarr sync failure must not break the app flow
  }
}

// ---------------------------------------------------------------------------
// Fetch public holidays from nmy5_c_hrm_public_holiday
// ---------------------------------------------------------------------------

interface PublicHolidayRow extends RowDataPacket {
  id: number;
  day: number;
  month: number;
  year: number;
  code: string;
  dayrule: string;
  fk_country: number | null;
}

/**
 * Read public holidays from Dolibarr's `nmy5_c_hrm_public_holiday` table.
 */
export async function fetchPublicHolidays(): Promise<PublicHoliday[]> {
  if (!isMySqlStateEnabled()) return [];

  try {
    const pool = await getMySqlPool();
    if (!(await tableExists(pool, "nmy5_c_hrm_public_holiday"))) return [];

    const [rows] = await pool.query<PublicHolidayRow[]>(
      "SELECT `id`, `day`, `month`, `year`, `code`, `dayrule`, `fk_country` FROM `nmy5_c_hrm_public_holiday` ORDER BY `month` ASC, `day` ASC"
    );

    return rows.map((row) => ({
      id: Number(row.id),
      day: Number(row.day),
      month: Number(row.month),
      year: Number(row.year || 0),
      code: String(row.code || ""),
      dayRule: String(row.dayrule || ""),
      countryId: row.fk_country ? Number(row.fk_country) : null,
    }));
  } catch {
    return [];
  }
}
