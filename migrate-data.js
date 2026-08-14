const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://qznrajnkzgqfsgxxdwit.supabase.co';
const supabaseKey = 'sb_publishable_pJvv2oNfWpz8U3x-HcyBFA_tdzbQmy7';
const supabase = createClient(supabaseUrl, supabaseKey);

async function migrateData() {
  console.log("Loading Excel file...");
  const workbook = XLSX.readFile('CUProstho_database.xlsx', { cellDates: true });

  function getRows(sheetName) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, dateNF: 'yyyy-mm-dd' });
  }
  
  async function doUpsert(table, data, conflictKey = 'id') {
      if (data.length === 0) return;
      console.log(`Inserting ${data.length} records into ${table}...`);
      const { error } = await supabase.from(table).upsert(data, { onConflict: conflictKey });
      if (error) {
          console.error(`Error in table ${table}:`, error);
          throw error;
      }
  }

  // 1. Advisors
  console.log("Migrating Advisors...");
  const advisors = getRows('Advisors').slice(1).filter(r => r[0]).map(r => ({
    id: String(r[0]),
    name: String(r[1] || ""),
    username: String(r[2] || ""),
    password: String(r[3] || ""),
    default_zone: String(r[4] || "A"),
    schedule: String(r[5] || ""),
    active: String(r[6] !== "" ? r[6] : "TRUE").toUpperCase() !== "FALSE",
  }));
  await doUpsert('advisors', advisors);

  // 2. Students
  console.log("Migrating Students...");
  const seenStudents = new Set();
  const students = getRows('Students').slice(1).filter(r => r[0]).map(r => ({
    id: String(r[0]),
    name: String(r[1] || ""),
    username: String(r[2] || ""),
    password: String(r[3] || ""),
    program: String(r[4] || "MSc"),
    enroll_year: r[5] ? Number(r[5]) : null,
    active: String(r[6] !== "" ? r[6] : "TRUE").toUpperCase() !== "FALSE",
  })).filter(s => {
    if (seenStudents.has(s.username)) return false;
    seenStudents.add(s.username);
    return true;
  });
  const validStudents = new Set(students.map(s => s.id));
  await doUpsert('students', students);

  // 3. Units
  console.log("Migrating Units...");
  const units = getRows('Units').slice(1).filter(r => r[0]).map(r => ({
    id: Number(r[0]),
    name: String(r[1] || `Unit ${r[0]}`),
    zone: String(r[2] || "A"),
    room: String(r[3] || `Zone ${r[2] || "A"}`),
    zone_idx: ["A","B","C"].indexOf(String(r[2] || "A")),
    status: String(r[4] || "active"),
  }));
  const validUnits = new Set(units.map(u => u.id));
  await doUpsert('units', units);

  // 4. Session Advisors
  console.log("Migrating Session Advisors...");
  const sessionAdvisors = getRows('Session_Advisors').slice(1).filter(r => r[0]).map(r => ({
    id: String(r[0]),
    date: String(r[1]),
    session: String(r[2]),
    zone_a_id: String(r[3] || ""),
    zone_b_id: String(r[4] || ""),
    zone_c_id: String(r[5] || ""),
    notes: String(r[6] || ""),
  })).map(sa => {
    if (!sa.zone_a_id) sa.zone_a_id = null;
    if (!sa.zone_b_id) sa.zone_b_id = null;
    if (!sa.zone_c_id) sa.zone_c_id = null;
    return sa;
  });
  await doUpsert('session_advisors', sessionAdvisors);

  // 5. Reservations
  console.log("Migrating Reservations...");
  const seenReservations = new Set();
  const reservations = getRows('Reservations').slice(1).filter(r => r[0]).map(r => ({
    id: String(r[0]),
    student_id: validStudents.has(String(r[1])) ? String(r[1]) : null,
    student_name: String(r[2] || ""),
    unit_id: validUnits.has(Number(r[3])) ? Number(r[3]) : null,
    date: String(r[4] || ""),
    session: String(r[5] || "morning"),
    patient_name: String(r[6] || ""),
    hn: String(r[7] || ""),
    treatment: String(r[8] || ""),
    status: String(r[9] || "confirmed"),
    overbooked: String(r[10] !== "" ? r[10] : "FALSE").toUpperCase() === "TRUE",
    created_at: r[11] || new Date().toISOString(),
    is_ghost: String(r[12] !== "" ? r[12] : "FALSE").toUpperCase() === "TRUE",
    inherit_unit: String(r[13] !== "" ? r[13] : "FALSE").toUpperCase() === "TRUE",
    added_by_admin: String(r[14] !== "" ? r[14] : "FALSE").toUpperCase() === "TRUE",
  })).filter(r => {
    // Only unique unit + date + session combinations are allowed if unit_id is set
    if (r.unit_id === null) return true; 
    const key = `${r.unit_id}_${r.date}_${r.session}`;
    if (seenReservations.has(key)) return false;
    seenReservations.add(key);
    return true;
  });
  
  if (reservations.length > 0) {
    const chunkSize = 200;
    for (let i = 0; i < reservations.length; i += chunkSize) {
      await doUpsert('reservations', reservations.slice(i, i + chunkSize));
    }
  }

  // 6. Admins
  console.log("Migrating Admins...");
  const admins = getRows('Admins').slice(1).filter(r => r[0]).map(r => ({
    id: String(r[0]),
    name: String(r[1] || ""),
    username: String(r[2] || ""),
    password: String(r[3] || ""),
  }));
  await doUpsert('admins', admins);

  // 7. Monthly Lineups
  console.log("Migrating Monthly Lineups...");
  const monthlyLineups = getRows('MonthlyLineups').slice(1).filter(r => r[0] && r[1]).map(r => ({
    month_key: String(r[0]),
    dow: Number(r[1]) || 0,
    morning_a: String(r[2] || ""),
    morning_b: String(r[3] || ""),
    morning_c: String(r[4] || ""),
    afternoon_a: String(r[5] || ""),
    afternoon_b: String(r[6] || ""),
    afternoon_c: String(r[7] || ""),
  }));
  await doUpsert('monthly_lineups', monthlyLineups, 'month_key,dow');

  // 8. Equipment
  console.log("Migrating Equipment...");
  const equipment = getRows('Equipment').slice(1).filter(r => r[0]).map(r => ({
    id: String(r[0]),
    category: String(r[1] || "ios"),
    name: String(r[2] || ""),
    brand: String(r[3] || ""),
    subtype: String(r[4] || ""),
    serial_number: String(r[5] || ""),
    status: String(r[6] || "active"),
  }));
  const validEquipment = new Set(equipment.map(e => e.id));
  await doUpsert('equipment', equipment);

  // 9. Equipment Reservations
  console.log("Migrating Equipment Reservations...");
  const seenEqRes = new Set();
  const equipmentReservations = getRows('EquipmentReservations').slice(1).filter(r => r[0]).map(r => ({
    id: String(r[0]),
    student_id: validStudents.has(String(r[1])) ? String(r[1]) : null,
    student_name: String(r[2] || ""),
    equipment_id: validEquipment.has(String(r[3])) ? String(r[3]) : null,
    date: String(r[4] || ""),
    time_slot: String(r[5] || ""),
    purpose: String(r[6] || ""),
    case_hn: String(r[7] || ""),
    status: String(r[8] || "confirmed"),
    created_at: r[9] || new Date().toISOString(),
  })).filter(r => {
    if (r.equipment_id === null) return true;
    const key = `${r.equipment_id}_${r.date}_${r.time_slot}`;
    if (seenEqRes.has(key)) return false;
    seenEqRes.add(key);
    return true;
  });
  
  if (equipmentReservations.length > 0) {
    const chunkSize = 200;
    for (let i = 0; i < equipmentReservations.length; i += chunkSize) {
      await doUpsert('equipment_reservations', equipmentReservations.slice(i, i + chunkSize));
    }
  }

  console.log("Migration complete!");
}

migrateData().catch(console.error);
