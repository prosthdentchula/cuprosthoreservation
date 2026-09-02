import { supabase } from './supabaseClient.js';

export async function initGoogleAuth() {
  return true; // Keep for backward compatibility
}

async function fetchAll(table) {
  let allData = [];
  let from = 0;
  const step = 1000;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(from, from + step - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allData.push(...data);
    if (data.length < step) break;
    from += step;
  }
  return { data: allData };
}

export const SheetsDB = {
  async syncAll() {
    const [
      { data: advisors },
      { data: students },
      { data: units },
      { data: sessionAdvisors },
      { data: admins },
      { data: monthlyLineups },
      { data: equipment },
      { data: equipmentReservations },
      { data: reservations }
    ] = await Promise.all([
      fetchAll('advisors'),
      fetchAll('students'),
      fetchAll('units'),
      fetchAll('session_advisors'),
      fetchAll('admins'),
      fetchAll('monthly_lineups'),
      fetchAll('equipment'),
      fetchAll('equipment_reservations'),
      fetchAll('reservations')
    ]);

    // Map Supabase rows to match the old format expected by App.jsx
    return {
      advisors: (advisors || []).map(a => ({
        id: a.id,
        name: a.name,
        username: a.username,
        password: a.password,
        defaultZone: a.default_zone,
        schedule: a.schedule ? a.schedule.split(",").map(s => {
          const [d, sess] = s.split(":");
          return { dow: Number(d), session: sess };
        }) : [],
        active: a.active,
      })),
      students: (students || []).map(s => ({
        id: s.id,
        name: s.name,
        username: s.username,
        password: s.password,
        program: s.program,
        enrollYear: s.enroll_year,
        active: s.active,
      })),
      units: (units || []).map(u => {
        const isOv = u.id >= 25 && u.id <= 48;
        let { name, zone, room, zone_idx: zoneIdx } = u;
        if (isOv) {
          const i = u.id - 25;
          zoneIdx = Math.floor(i / 8);
          const zLabel = ["A", "B", "C"][zoneIdx];
          name = `Unit ${zLabel}-OV${(i % 8) + 1}`;
          zone = zLabel;
          room = `Zone ${zLabel}`;
        }
        return {
          id: u.id,
          name,
          zone,
          room,
          zoneIdx,
          status: u.status,
          overflow: isOv,
        };
      }),
      sessionAdvisors: (sessionAdvisors || []).reduce((map, sa) => {
        map[`${sa.date}__${sa.session}`] = [sa.zone_a_id || "", sa.zone_b_id || "", sa.zone_c_id || ""];
        return map;
      }, {}),
      reservations: (reservations || []).map(r => ({
        id: r.id,
        studentId: r.student_id,
        studentName: r.student_name,
        unitId: r.unit_id,
        date: r.date,
        session: r.session.split('-')[0],
        patientName: r.patient_name,
        hn: r.hn,
        treatment: r.treatment,
        status: r.status,
        overbooked: r.overbooked,
        createdAt: r.created_at,
        isGhost: r.is_ghost,
        inheritUnit: r.inherit_unit,
        addedByAdmin: r.added_by_admin,
      })),
      admins: (admins || []),
      monthlyLineups: (monthlyLineups || []).reduce((acc, m) => {
        if (!acc[m.month_key]) acc[m.month_key] = {};
        acc[m.month_key][m.dow] = {
          morning: [m.morning_a || "", m.morning_b || "", m.morning_c || ""],
          afternoon: [m.afternoon_a || "", m.afternoon_b || "", m.afternoon_c || ""],
        };
        return acc;
      }, {}),
      equipment: (equipment || []).map(e => ({
        id: e.id,
        category: e.category,
        name: e.name,
        brand: e.brand,
        subtype: e.subtype,
        serialNumber: e.serial_number,
        status: e.status,
      })),
      equipmentReservations: (equipmentReservations || []).map(r => ({
        id: r.id,
        studentId: r.student_id,
        studentName: r.student_name,
        equipmentId: r.equipment_id,
        date: r.date,
        timeSlot: r.time_slot.split('-')[0],
        purpose: r.purpose,
        caseHn: r.case_hn,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  },

  async writeReservation(res) {
    const { error } = await supabase.from('reservations').insert([{
      id: res.id,
      student_id: res.studentId,
      student_name: res.studentName,
      unit_id: res.unitId,
      date: res.date,
      session: res.session,
      patient_name: res.patientName,
      hn: res.hn,
      treatment: res.treatment,
      status: res.status,
      overbooked: res.overbooked,
      is_ghost: res.isGhost,
      inherit_unit: res.inheritUnit,
      added_by_admin: res.addedByAdmin,
      created_at: res.createdAt
    }]);
    if (error) {
      if (error.code === '23505') throw new Error("ขออภัย! ยูนิตนี้ถูกจองไปแล้วในเสี้ยววินาทีที่ผ่านมา โปรดเลือกยูนิตอื่น");
      throw error;
    }
    return { success: true };
  },

  async updateReservationFields(reservationId, { patientName, hn, treatment }) {
    const { error } = await supabase.from('reservations').update({
      patient_name: patientName,
      hn: hn,
      treatment: treatment
    }).eq('id', reservationId);
    if (error) throw error;
  },

  async updateReservationStatus(reservationId, newStatus) {
    let updatePayload = { status: newStatus };
    if (newStatus === 'cancelled') {
      const { data: res } = await supabase.from('reservations').select('session').eq('id', reservationId).single();
      if (res && !res.session.includes('-cancelled')) {
        updatePayload.session = res.session + '-cancelled-' + Date.now();
      }
    }
    const { error } = await supabase.from('reservations').update(updatePayload).eq('id', reservationId);
    if (error) throw error;
  },

  async saveSessionOverride(date, session, zoneAId, zoneBId, zoneCId, notes = "") {
    const id = `SA-${date}-${session.slice(0,2).toUpperCase()}`;
    const { error } = await supabase.from('session_advisors').upsert([{
      id,
      date,
      session,
      zone_a_id: zoneAId || null,
      zone_b_id: zoneBId || null,
      zone_c_id: zoneCId || null,
      notes
    }], { onConflict: 'date,session' });
    if (error) throw error;
  },

  async saveAdvisorSchedule(advisorId, scheduleArray) {
    const schedStr = scheduleArray.map((s) => `${s.dow}:${s.session}`).join(",");
    const { error } = await supabase.from('advisors').update({ schedule: schedStr }).eq('id', advisorId);
    if (error) throw error;
  },

  async updateAdvisor(advisor) {
    const schedStr = (advisor.schedule || []).map((s) => `${s.dow}:${s.session}`).join(",");
    const { error } = await supabase.from('advisors').update({
      name: advisor.name,
      username: advisor.username,
      password: advisor.password,
      default_zone: advisor.defaultZone,
      schedule: schedStr,
      active: advisor.active
    }).eq('id', advisor.id);
    if (error) throw error;
  },

  async appendAdvisor(advisor) {
    const schedStr = (advisor.schedule || []).map((s) => `${s.dow}:${s.session}`).join(",");
    const { error } = await supabase.from('advisors').insert([{
      id: advisor.id,
      name: advisor.name,
      username: advisor.username,
      password: advisor.password,
      default_zone: advisor.defaultZone,
      schedule: schedStr,
      active: true
    }]);
    if (error) throw error;
  },

  async batchDeactivateUsers(studentIds, advisorIds) {
    if (studentIds.length > 0) {
      await supabase.from('students').update({ active: false }).in('id', studentIds);
    }
    if (advisorIds.length > 0) {
      await supabase.from('advisors').update({ active: false }).in('id', advisorIds);
    }
    return { success: true };
  },

  async batchUpdateStatus(sheetName, ids, statusColIdx, newValue) {
    // Determine the table name
    let table = sheetName.toLowerCase();
    if (table === 'equipmentreservations') table = 'equipment_reservations';
    
    // Status column name
    const { error } = await supabase.from(table).update({ status: newValue }).in('id', ids);
    if (error) throw error;
    return { success: true };
  },

  async updateStudent(student) {
    const { error } = await supabase.from('students').update({
      name: student.name,
      username: student.username,
      password: student.password,
      program: student.program || "MSc",
      enroll_year: student.enrollYear || null,
      active: student.active
    }).eq('id', student.id);
    if (error) throw error;
  },

  async appendStudent(student) {
    const { error } = await supabase.from('students').insert([{
      id: student.id,
      name: student.name,
      username: student.username,
      password: student.password,
      program: student.program || "MSc",
      enroll_year: student.enrollYear || null,
      active: true
    }]);
    if (error) throw error;
  },

  async batchAppendStudents(studentsList) {
    const records = studentsList.map(s => ({
      id: s.id,
      name: s.name,
      username: s.username,
      password: s.password,
      program: s.program || "MSc",
      enroll_year: s.enrollYear || null,
      active: true
    }));
    const { error } = await supabase.from('students').insert(records);
    if (error) throw error;
  },

  async saveUnitStatus(unitId, newStatus) {
    const { error } = await supabase.from('units').update({ status: newStatus }).eq('id', unitId);
    if (error) throw error;
  },

  async writeEquipmentReservation(res) {
    const { error } = await supabase.from('equipment_reservations').insert([{
      id: res.id,
      student_id: res.studentId,
      student_name: res.studentName,
      equipment_id: res.equipmentId,
      date: res.date,
      time_slot: res.timeSlot,
      purpose: res.purpose,
      case_hn: res.caseHn,
      status: res.status,
      created_at: res.createdAt
    }]);
    if (error) {
      if (error.code === '23505') throw new Error("ขออภัย! อุปกรณ์นี้ถูกจองไปแล้วในช่วงเวลานี้ โปรดเลือกช่วงเวลาอื่น");
      throw error;
    }
    return { success: true };
  },

  async updateEquipmentReservationStatus(id, newStatus) {
    let updatePayload = { status: newStatus };
    if (newStatus === 'cancelled') {
      const { data: res } = await supabase.from('equipment_reservations').select('time_slot').eq('id', id).single();
      if (res && !res.time_slot.includes('-cancelled')) {
        updatePayload.time_slot = res.time_slot + '-cancelled-' + Date.now();
      }
    }
    const { error } = await supabase.from('equipment_reservations').update(updatePayload).eq('id', id);
    if (error) throw error;
  },

  async appendEquipment(eq) {
    const { error } = await supabase.from('equipment').insert([{
      id: eq.id,
      category: eq.category,
      name: eq.name,
      brand: eq.brand,
      subtype: eq.subtype,
      serial_number: eq.serialNumber,
      status: 'active'
    }]);
    if (error) throw error;
  },

  async updateEquipment(eq) {
    const { error } = await supabase.from('equipment').update({
      category: eq.category,
      name: eq.name,
      brand: eq.brand,
      subtype: eq.subtype,
      serial_number: eq.serialNumber,
      status: eq.status
    }).eq('id', eq.id);
    if (error) throw error;
  },

  async saveEquipmentStatus(id, status) {
    const { error } = await supabase.from('equipment').update({ status: status }).eq('id', id);
    if (error) throw error;
  },

  async saveMonthlyLineup(monthKey, dow, morningIds, afternoonIds) {
    const { error } = await supabase.from('monthly_lineups').upsert([{
      month_key: monthKey,
      dow: dow,
      morning_a: morningIds[0] || "",
      morning_b: morningIds[1] || "",
      morning_c: morningIds[2] || "",
      afternoon_a: afternoonIds[0] || "",
      afternoon_b: afternoonIds[1] || "",
      afternoon_c: afternoonIds[2] || ""
    }], { onConflict: 'month_key,dow' });
    if (error) throw error;
  }
};
