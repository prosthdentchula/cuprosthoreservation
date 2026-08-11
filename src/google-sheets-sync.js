/**
 * DentaBook — Serverless Database Layer (Google Apps Script)
 */

// ── CONFIG ───────────────────────────────────────────────────────────────────
export const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyjV5ZDUP7PGDKjVjhprqUIUwP_0tuMQdB1Y_5UFtybc5I6RlxC-PIpnOiVYUuQ7ZbA/exec";

/**
 * Dummy function to keep App.jsx happy!
 * Authentication is now handled seamlessly on the backend by Google Apps Script, 
 * so we no longer need Google Identity Services or pop-ups.
 */
export async function initGoogleAuth() {
  return true; 
}

// ── Low-level GAS Fetch Helpers ───────────────────────────────────────────────
async function gasPost(payload, attemptTimeoutMs = 25000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), attemptTimeoutMs);

  const urlWithCacheBuster = `${WEB_APP_URL}?t=${Date.now()}`;

  try {
    const r = await fetch(urlWithCacheBuster, {
      method: "POST",
      body: JSON.stringify(payload),
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });

    const text = await r.text();

    if (!text.trimStart().startsWith("{") && !text.trimStart().startsWith("[")) {
      throw new Error(
        "GAS ส่งค่าที่ไม่ใช่ JSON กลับมา (น่าจะเป็น redirect) — ลองใหม่ หรือ redeploy script เป็น version ใหม่"
      );
    }

    const j = JSON.parse(text);
    if (!j.success) throw new Error(j.error);
    return j;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`การเชื่อมต่อหมดเวลา (${attemptTimeoutMs/1000} วินาที) — กรุณาลองใหม่อีกครั้ง`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function apiGet(range) {
  const j = await gasPost({ action: "get", range });
  return j.values || [];
}

async function apiPut(range, values) {
  return gasPost({ action: "put", range, values });
}

async function apiAppend(range, values) {
  return gasPost({ action: "append", range, values });
}

// ── Parsers (Same as before) ──────────────────────────────────────────────────
export function parseAdvisors(rows) {
  return rows.slice(1).filter((r) => r[0]).map((r) => ({
    id:          r[0],
    name:        r[1] || "",
    username:    r[2] || "",
    password:    r[3] || "",
    defaultZone: r[4] || "A",
    schedule:    (r[5] || "").split(",").filter(Boolean).map((s) => {
      const [d, sess] = s.trim().split(":");
      return { dow: Number(d), session: sess };
    }),
    // Safely handles both empty cells and literal booleans
    active: String(r[6] !== "" && r[6] !== undefined ? r[6] : "TRUE").toUpperCase() !== "FALSE",
  }));
}

export function parseStudents(rows) {
  return rows.slice(1).filter((r) => r[0]).map((r) => ({
    id:         r[0],
    name:       r[1] || "",
    username:   r[2] || "",
    password:   r[3] || "",
    program:    r[4] || "MSc",
    enrollYear: r[5] ? Number(r[5]) : null,
    active:     String(r[6] !== "" && r[6] !== undefined ? r[6] : "TRUE").toUpperCase() !== "FALSE",
  }));
}

export function parseUnits(rows) {
  return rows.slice(1).filter((r) => r[0]).map((r) => ({
    id:      Number(r[0]),
    name:    r[1] || `Unit ${r[0]}`,
    zone:    r[2] || "A",
    room:    r[3] || `Zone ${r[2] || "A"}`,
    zoneIdx: ["A","B","C"].indexOf(r[2] || "A"),
    status:  r[4] || "active",
  }));
}

export function parseSessionAdvisors(rows) {
  const map = {};
  rows.slice(1).filter((r) => r[0]).forEach((r) => {
    const key = `${r[1]}__${r[2]}`;
    map[key] = [r[3] || "", r[4] || "", r[5] || ""];
  });
  return map;
}

export function parseReservations(rows) {
  return rows.slice(1).filter((r) => r[0]).map((r) => ({
    id:          r[0],
    studentId:   r[1] || "",
    studentName: r[2] || "",
    unitId:      Number(r[3]),
    date:        r[4] || "",
    session:     r[5] || "morning",
    patientName: r[6] || "",
    hn:          r[7] || "",
    treatment:   r[8] || "",
    status:      r[9] || "confirmed",
    overbooked:  String(r[10] !== "" && r[10] !== undefined ? r[10] : "FALSE").toUpperCase() === "TRUE",
    createdAt:   r[11] || "",
    isGhost:     String(r[12] !== "" && r[12] !== undefined ? r[12] : "FALSE").toUpperCase() === "TRUE",
    inheritUnit:   String(r[13] !== "" && r[13] !== undefined ? r[13] : "FALSE").toUpperCase() === "TRUE",
    addedByAdmin:  String(r[14] !== "" && r[14] !== undefined ? r[14] : "FALSE").toUpperCase() === "TRUE",
  }));
}

export function parseAdmins(rows) {
  return rows.slice(1).filter((r) => r[0]).map((r) => ({
    id:       r[0],
    name:     r[1] || "",
    username: r[2] || "",
    password: r[3] || "",
  }));
}

export function parseMonthlyLineups(rows) {
  // Shape: { "YYYY-MM": { dow: { morning:[...], afternoon:[...] } } }
  // Sheet columns: monthKey | dow | morningA | morningB | morningC | afternoonA | afternoonB | afternoonC
  const result = {};
  rows.slice(1).filter((r) => r[0] && r[1]).forEach((r) => {
    const monthKey = r[0];
    const dow      = Number(r[1]); // 1=Mon…5=Fri
    if (!result[monthKey]) result[monthKey] = {};
    result[monthKey][dow] = {
      morning:   [r[2] || "", r[3] || "", r[4] || ""],
      afternoon: [r[5] || "", r[6] || "", r[7] || ""],
    };
  });
  return result;
}

export function parseEquipment(rows) {
  return rows.slice(1).filter((r) => r[0]).map((r) => ({
    id:           r[0],
    category:     r[1] || "ios",
    name:         r[2] || "",
    brand:        r[3] || "",
    subtype:      r[4] || "",
    serialNumber: r[5] || "",
    status:       r[6] || "active",
  })).filter((e) => e.status !== "removed");
}

export function parseEquipmentReservations(rows) {
  return rows.slice(1).filter((r) => r[0]).map((r) => ({
    id:          r[0],
    studentId:   r[1] || "",
    studentName: r[2] || "",
    equipmentId: r[3] || "",
    date:        r[4] || "",
    timeSlot:    r[5] || "",
    purpose:     r[6] || "",
    caseHn:      r[7] || "",
    status:      r[8] || "confirmed",
    createdAt:   r[9] || "",
  }));
}

// ── High-level SheetsDB API ───────────────────────────────────────────────────
export const SheetsDB = {

  // Uses the ultra-fast backend payload to fetch everything in 1 network request
async syncAll() {
  const MAX_ATTEMPTS = 3;
  const TIMEOUTS = [25000, 15000, 15000]; // first attempt: generous, for cold start
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const j = await gasPost({ action: "syncAll" }, TIMEOUTS[attempt - 1]);
      return {
        advisors:        parseAdvisors(j.data.advisors),
        students:        parseStudents(j.data.students),
        units:           parseUnits(j.data.units),
        sessionAdvisors: parseSessionAdvisors(j.data.sessionAdvisors),
        reservations:    parseReservations(j.data.reservations),
        admins:          parseAdmins(j.data.admins),
        monthlyLineups:  parseMonthlyLineups(j.data.monthlyLineups || []),
        equipment:             parseEquipment(j.data.equipment || []),
        equipmentReservations: parseEquipmentReservations(j.data.equipmentReservations || []),
      };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 500)); // short gap, don't burn the budget
      }
    }
  }
  throw lastErr;
},

async writeReservation(res) {
    const row = [
      res.id, res.studentId, res.studentName, String(res.unitId),
      res.date, res.session, res.patientName, res.hn, res.treatment,
      res.status, res.overbooked ? "TRUE" : "FALSE", res.createdAt,
      res.isGhost ? "TRUE" : "FALSE",
      res.inheritUnit ? "TRUE" : "FALSE",
      res.addedByAdmin ? "TRUE" : "FALSE",
    ];
    return apiAppend("Reservations!A:O", [row]);
  },

  async updateReservationFields(reservationId, { patientName, hn, treatment }) {
    const rows = await apiGet("Reservations!A:A");
    const rowIdx = rows.findIndex((r) => r[0] === reservationId);
    if (rowIdx === -1) throw new Error(`Reservation ${reservationId} not found`);
    // Cols G, H, I = patientName, hn, treatment (1-indexed: 7,8,9)
    await apiPut(`Reservations!G${rowIdx + 1}:I${rowIdx + 1}`, [[patientName, hn, treatment]]);
  },

  async updateReservationStatus(reservationId, newStatus) {
    const rows = await apiGet("Reservations!A:A");
    const rowIdx = rows.findIndex((r) => r[0] === reservationId);
    if (rowIdx === -1) throw new Error(`Reservation ${reservationId} not found`);
    await apiPut(`Reservations!J${rowIdx + 1}`, [[newStatus]]);
  },

  async saveSessionOverride(date, session, zoneAId, zoneBId, zoneCId, notes = "") {
    const rows = await apiGet("Session_Advisors!A:G");
    const existing = rows.findIndex((r) => r[1] === date && r[2] === session);
    const row = [
      existing > 0 ? rows[existing][0] : `SA-${date}-${session.slice(0,2).toUpperCase()}`,
      date, session, zoneAId, zoneBId, zoneCId, notes,
    ];
    if (existing > 0) {
      await apiPut(`Session_Advisors!A${existing + 1}:G${existing + 1}`, [row]);
    } else {
      await apiAppend("Session_Advisors!A:G", [row]);
    }
  },

  async saveAdvisorSchedule(advisorId, scheduleArray) {
    const scheduleStr = scheduleArray.map((s) => `${s.dow}:${s.session}`).join(",");
    const rows = await apiGet("Advisors!A:A");
    const rowIdx = rows.findIndex((r) => r[0] === advisorId);
    if (rowIdx === -1) throw new Error(`Advisor ${advisorId} not found`);
    await apiPut(`Advisors!F${rowIdx + 1}`, [[scheduleStr]]);
  },

  async updateAdvisor(advisor) {
    const rows = await apiGet("Advisors!A:A");
    const rowIdx = rows.findIndex((r) => r[0] === advisor.id);
    if (rowIdx === -1) throw new Error(`Advisor ${advisor.id} not found`);
    const schedStr = (advisor.schedule || []).map((s) => `${s.dow}:${s.session}`).join(",");
    const row = [
      advisor.id, advisor.name, advisor.username, advisor.password,
      advisor.defaultZone, schedStr, advisor.active !== false ? "TRUE" : "FALSE",
    ];
    await apiPut(`Advisors!A${rowIdx+1}:G${rowIdx+1}`, [row]);
  },

  async appendAdvisor(advisor) {
    const schedStr = (advisor.schedule || []).map((s) => `${s.dow}:${s.session}`).join(",");
    const row = [
      advisor.id, advisor.name, advisor.username, advisor.password,
      advisor.defaultZone, schedStr, "TRUE",
    ];
    return apiAppend("Advisors!A:G", [row]);
  },

  async updateStudent(student) {
    const rows = await apiGet("Students!A:A");
    const rowIdx = rows.findIndex((r) => r[0] === student.id);
    if (rowIdx === -1) throw new Error(`Student ${student.id} not found`);
    const row = [student.id, student.name, student.username, student.password, student.program || "MSc", student.enrollYear || "", student.active !== false ? "TRUE" : "FALSE"];
    await apiPut(`Students!A${rowIdx+1}:G${rowIdx+1}`, [row]);
  },

  async appendStudent(student) {
    const row = [student.id, student.name, student.username, student.password, student.program || "MSc", student.enrollYear || "", "TRUE"];
    return apiAppend("Students!A:G", [row]);
  },

  async saveUnitStatus(unitId, newStatus) {
    const rows = await apiGet("Units!A:A");
    const rowIdx = rows.findIndex((r) => Number(r[0]) === unitId);
    if (rowIdx === -1) throw new Error(`Unit ${unitId} not found`);
    await apiPut(`Units!E${rowIdx + 1}`, [[newStatus]]);
  },

  async writeEquipmentReservation(res) {
    const row = [
      res.id, res.studentId, res.studentName, res.equipmentId,
      res.date, res.timeSlot, res.purpose, res.caseHn || "",
      res.status, res.createdAt,
    ];
    return apiAppend("EquipmentReservations!A:J", [row]);
  },

  async updateEquipmentReservationStatus(id, newStatus) {
    const rows = await apiGet("EquipmentReservations!A:A");
    const idx = rows.findIndex((r) => r[0] === id);
    if (idx === -1) throw new Error(`Equipment reservation ${id} not found`);
    await apiPut(`EquipmentReservations!I${idx + 1}`, [[newStatus]]);
  },

  async appendEquipment(eq) {
    const row = [eq.id, eq.category, eq.name, eq.brand, eq.subtype || "", eq.serialNumber || "", "active"];
    return apiAppend("Equipment!A:G", [row]);
  },

  async updateEquipment(eq) {
    const rows = await apiGet("Equipment!A:A");
    const idx = rows.findIndex((r) => r[0] === eq.id);
    if (idx === -1) throw new Error(`Equipment ${eq.id} not found`);
    const row = [eq.id, eq.category, eq.name, eq.brand, eq.subtype || "", eq.serialNumber || "", eq.status || "active"];
    await apiPut(`Equipment!A${idx + 1}:G${idx + 1}`, [row]);
  },

  async saveEquipmentStatus(id, status) {
    const rows = await apiGet("Equipment!A:A");
    const idx = rows.findIndex((r) => r[0] === id);
    if (idx === -1) throw new Error(`Equipment ${id} not found`);
    await apiPut(`Equipment!G${idx + 1}`, [[status]]);
  },

  async saveMonthlyLineup(monthKey, dow, morningIds, afternoonIds) {
    // Sheet columns: monthKey | dow | morningA | morningB | morningC | afternoonA | afternoonB | afternoonC
    const rows = await apiGet("MonthlyLineups!A:B");
    const rowIdx = rows.findIndex((r) => r[0] === monthKey && Number(r[1]) === dow);
    const row = [
      monthKey,
      String(dow),
      morningIds[0]   || "",
      morningIds[1]   || "",
      morningIds[2]   || "",
      afternoonIds[0] || "",
      afternoonIds[1] || "",
      afternoonIds[2] || "",
    ];
    if (rowIdx !== -1) {
      await apiPut(`MonthlyLineups!A${rowIdx + 1}:H${rowIdx + 1}`, [row]);
    } else {
      await apiAppend("MonthlyLineups!A:H", [row]);
    }
  },
};
