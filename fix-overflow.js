const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://qznrajnkzgqfsgxxdwit.supabase.co';
const supabaseKey = 'sb_publishable_pJvv2oNfWpz8U3x-HcyBFA_tdzbQmy7';
const supabase = createClient(supabaseUrl, supabaseKey);

async function fixOverflow() {
  console.log("Loading Excel file to find overflow units...");
  const workbook = XLSX.readFile('CUProstho_database.xlsx', { cellDates: true });

  function getRows(sheetName) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, dateNF: 'yyyy-mm-dd' });
  }

  const unitsData = getRows('Units').slice(1).filter(r => r[0]);
  const validUnits = new Set(unitsData.map(r => Number(r[0])));

  const reservationsData = getRows('Reservations').slice(1).filter(r => r[0]);
  const missingUnitIds = new Set();
  
  reservationsData.forEach(r => {
    const unitId = Number(r[3]);
    if (unitId && !validUnits.has(unitId)) {
      missingUnitIds.add(unitId);
    }
  });

  if (missingUnitIds.size > 0) {
    console.log(`Found missing overflow units in reservations: ${Array.from(missingUnitIds).join(', ')}`);
    console.log("Inserting overflow units into the database...");
    
    const newUnits = Array.from(missingUnitIds).map(id => ({
      id: id,
      name: `Overflow Unit ${id}`,
      zone: 'Overflow',
      room: 'Overflow Zone',
      zone_idx: 3,
      status: 'active'
    }));

    const { error: unitsError } = await supabase.from('units').upsert(newUnits, { onConflict: 'id' });
    if (unitsError) throw unitsError;
    console.log("Successfully created overflow units.");
  } else {
    console.log("No missing overflow units found.");
  }

  console.log("Fetching actual valid students from database...");
  const { data: dbStudents, error: studentErr } = await supabase.from('students').select('id');
  if (studentErr) throw studentErr;
  const validStudents = new Set(dbStudents.map(s => String(s.id)));
  
  console.log("Re-migrating reservations to restore overflow unit assignments...");
  const seenReservations = new Set();
  const reservations = reservationsData.map(r => ({
    id: String(r[0]),
    student_id: validStudents.has(String(r[1])) ? String(r[1]) : null,
    student_name: String(r[2] || ""),
    unit_id: Number(r[3]),
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
    const key = `${r.unit_id}_${r.date}_${r.session}`;
    if (seenReservations.has(key)) return false;
    seenReservations.add(key);
    return true;
  });

  if (reservations.length > 0) {
    const chunkSize = 200;
    for (let i = 0; i < reservations.length; i += chunkSize) {
      const { error } = await supabase.from('reservations').upsert(reservations.slice(i, i + chunkSize), { onConflict: 'id' });
      if (error) {
        console.error("Error inserting reservations:", error);
        throw error;
      }
    }
  }

  console.log("Reservations successfully restored!");
}

fixOverflow().catch(console.error);
