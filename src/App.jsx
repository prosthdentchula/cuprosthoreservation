import { useState, useEffect, useRef } from "react";
import { SheetsDB, initGoogleAuth } from "./supabase-sync.js";
import * as XLSX from "xlsx";

const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Outfit:wght@300;400;500;600&family=Sarabun:wght@300;400;500;600&display=swap";
document.head.appendChild(fontLink);

/* ── Viewport meta: prevents accidental zoom-triggered page reloads on iOS ── */
(()=>{
  if (!document.querySelector('meta[name="viewport"]')) {
    const m = document.createElement("meta");
    m.name = "viewport";
    m.content = "width=device-width, initial-scale=1, maximum-scale=1";
    document.head.appendChild(m);
  }
})();

/* ── Session persistence helpers (survives page reload / zoom-refresh) ──────
   Stores the logged-in user in sessionStorage so a reload doesn't log them out.
   sessionStorage is cleared automatically when the browser tab is closed.      */
const SESSION_KEY = "cuprostho_session";
function saveSession(u)    { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(u)); } catch(_){} }
function loadSession()     { try { const s = sessionStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; } catch(_){ return null; } }
function clearSession()    { try { sessionStorage.removeItem(SESSION_KEY); } catch(_){} }

/* ═══ SEED DATA  (initial state before first Sheets sync) ═══════════════════════
   dow: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
   ══════════════════════════════════════════════════════════════════════════════ */
const SEED_ADVISORS = [
  { id:"ADV001", name:"Dr. Siriporn Komarakul",    username:"siriporn",  password:"adv1234", defaultZone:"A",
    schedule:[{dow:1,session:"morning"},{dow:3,session:"morning"},{dow:5,session:"morning"}], active:true },
  { id:"ADV002", name:"Dr. Thanawat Phumiphan",    username:"thanawat",  password:"adv1234", defaultZone:"B",
    schedule:[{dow:1,session:"morning"},{dow:2,session:"afternoon"},{dow:4,session:"morning"}], active:true },
  { id:"ADV003", name:"Dr. Kannika Rungrojwanich", username:"kannika",   password:"adv1234", defaultZone:"C",
    schedule:[{dow:2,session:"morning"},{dow:3,session:"morning"},{dow:5,session:"afternoon"}], active:true },
  { id:"ADV004", name:"Dr. Wanchai Srisawat",      username:"wanchai",   password:"adv1234", defaultZone:"A",
    schedule:[{dow:2,session:"morning"},{dow:4,session:"morning"},{dow:4,session:"afternoon"}], active:true },
  { id:"ADV005", name:"Dr. Patcharee Limsakul",    username:"patcharee", password:"adv1234", defaultZone:"B",
    schedule:[{dow:1,session:"afternoon"},{dow:3,session:"morning"},{dow:5,session:"morning"}], active:true },
];

const SEED_STUDENTS = [
  { id:"D6001", name:"Ariya Sutthirak",       username:"D6001", password:"1234", program:"MSc",       enrollYear:2023, active:true },
  { id:"D6002", name:"Pimchanok Lertwattana", username:"D6002", password:"1234", program:"PhD",       enrollYear:2022, active:true },
  { id:"D6003", name:"Thanakorn Wichit",      username:"D6003", password:"1234", program:"Resident",  enrollYear:2024, active:true },
  { id:"D6004", name:"Lalita Maneechai",      username:"D6004", password:"1234", program:"HigherGrad",enrollYear:2023, active:true },
  { id:"D6005", name:"Kritsana Boonsong",     username:"D6005", password:"1234", program:"MSc",       enrollYear:2024, active:true },
];

const SEED_ADMINS = [{ id:"A001", name:"Admin", username:"admin", password:"admin" }];

/* ═══ Constants & helpers ════════════════════════════════════════════════════════ */
const PROGRAMS = ["MSc","PhD","Resident","HigherGrad"];
const PROGRAM_LABELS = { MSc:"M.Sc.", PhD:"Ph.D.", Resident:"Resident", HigherGrad:"Higher Grad." };
const DOW_LABELS = ["อา","จ","อ","พ","พฤ","ศ","ส"];
const DOW_FULL   = ["อาทิตย์","จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์"];

const isWednesday  = (s) => new Date(s+"T12:00:00").getDay() === 3;
const isWeekend    = (s) => { const d = new Date(s+"T12:00:00").getDay(); return d===0||d===6; };
const getDow       = (s) => new Date(s+"T12:00:00").getDay();
const getAvailableSessions = (s) => { if (isWeekend(s)) return []; if (isWednesday(s)) return ["morning"]; return ["morning","afternoon"]; };

/* ─── Booking cutoff logic ───────────────────────────────────────────────────
   Morning session:   cutoff 08:00 — no new bookings at/after 08:00 on that day
   Afternoon session: cutoff 11:00 — no new bookings at/after 11:00 on that day
   ─────────────────────────────────────────────────────────────────────────── */
function isBookingClosed(dateStr, session) {
  const now = new Date();
  const nowDate = getLocalISOStatic(now);
  if (dateStr !== nowDate) return false;          // future dates always open
  const h = now.getHours(), m = now.getMinutes();
  const totalMins = h * 60 + m;
  if (session === "morning")   return totalMins >= 8 * 60;   // 08:00
  if (session === "afternoon") return totalMins >= 11 * 60;  // 11:00
  return false;
}
// Static version of getLocalISO (used before today is defined)
function getLocalISOStatic(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split("T")[0];
}

const today       = new Date();
const getLocalISO = (d) => new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().split("T")[0];
const todayStr    = getLocalISO(today);
const threeMonthsAgo = new Date(today); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth()-3);
const eighteenMonthsAgo = new Date(today); eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth()-18);
const eighteenMonthsAgoStr = getLocalISO(eighteenMonthsAgo);

/* ── Class Year helper ─────────────────────────────────────────────────────────
   Academic year advances on August 1 each calendar year.
   enrollYear = the calendar year the student first enrolled (stored in Sheets).
   classYear  = how many years have passed since enrolment, counting each Aug 1.
   Example: enrolled 2023, today = 2025-03-10 → classYear = 3 (Aug 2023→2, Aug 2024→3)
   ─────────────────────────────────────────────────────────────────────────── */
function getClassYear(enrollYear) {
  if (!enrollYear) return null;
  const yr  = today.getFullYear();
  const aug1 = new Date(yr, 7, 1); // August 1 of current calendar year
  const academicYear = today >= aug1 ? yr : yr - 1; // current academic year start
  return academicYear - Number(enrollYear) + 1;
}
/* ── Countdown to next Aug 1 advancement ───────────────────────────────────── */
function getCountdownToNextAug1() {
  const now = new Date();
  let nextAug1 = new Date(now.getFullYear(), 7, 1);
  if (now >= nextAug1) nextAug1 = new Date(now.getFullYear() + 1, 7, 1);
  const diffMs   = nextAug1 - now;
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "วันนี้!";
  const months = Math.floor(diffDays / 30);
  const days   = diffDays % 30;
  if (months === 0) return `${diffDays} วัน`;
  if (days   === 0) return `${months} เดือน`;
  return `${months} เดือน ${days} วัน`;
}
const COUNTDOWN_TO_ADV = getCountdownToNextAug1();
const next14Days  = Array.from({length:21},(_,i)=>{ const d=new Date(today); d.setDate(d.getDate()+i); return getLocalISO(d); }).filter(d=>!isWeekend(d)).slice(0,14);
const displayDate = (s) => new Date(s+"T12:00:00").toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric"});
const shortDay    = (s) => new Date(s+"T12:00:00").toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"});

const INIT_UNITS = [
  // Regular units 1–24
  ...Array.from({length:24},(_,i)=>({
    id: i+1, name:`Unit ${String(i+1).padStart(2,"0")}`,
    zone: i<8?"A":i<16?"B":"C", room: i<8?"Zone A":i<16?"Zone B":"Zone C",
    zoneIdx: i<8?0:i<16?1:2, status:[3,11,19].includes(i+1)?"maintenance":"active",
    overflow: false,
  })),
  // Overflow units: 8 per zone, ids 25–32 (A), 33–40 (B), 41–48 (C)
  ...Array.from({length:24},(_,i)=>{
    const zoneIdx = Math.floor(i/8);
    const ovNum   = (i % 8) + 1;
    const zLabel  = ["A","B","C"][zoneIdx];
    return {
      id: 25+i, name:`Unit ${zLabel}-OV${ovNum}`,
      zone: zLabel, room:`Zone ${zLabel}`,
      zoneIdx, status:"active", overflow: true,
    };
  }),
];

/* ═══ EQUIPMENT (Intraoral Scanners & Dongles) ═══════════════════════════════ */
const SEED_EQUIPMENT = [
  { id:"IOS01", category:"ios", name:"TRIOS 5",              brand:"3Shape",           subtype:"", serialNumber:"EQ-01", status:"active" },
  { id:"IOS02", category:"ios", name:"Medit i700",           brand:"Medit",            subtype:"", serialNumber:"EQ-02", status:"active" },
  { id:"IOS03", category:"ios", name:"PANDA P2",             brand:"PANDA Scanner",    subtype:"", serialNumber:"EQ-03", status:"active" },
  { id:"IOS04", category:"ios", name:"PANDA P3",             brand:"PANDA Scanner",    subtype:"", serialNumber:"EQ-04", status:"active" },
  { id:"IOS05", category:"ios", name:"TRIOS 5",              brand:"3Shape",           subtype:"", serialNumber:"EQ-05", status:"active" },
  { id:"IOS06", category:"ios", name:"TRIOS 5",              brand:"3Shape",           subtype:"", serialNumber:"EQ-06", status:"active" },
  { id:"IOS07", category:"ios", name:"PRIMESCAN",            brand:"Dentsply Sirona",  subtype:"", serialNumber:"EQ-07", status:"active" },
  { id:"IOS08", category:"ios", name:"PRIMESCAN",            brand:"Dentsply Sirona",  subtype:"", serialNumber:"EQ-08", status:"active" },
  { id:"IOS09", category:"ios", name:"SIRIOS X3",            brand:"SIRIOS",           subtype:"", serialNumber:"EQ-09", status:"active" },
  { id:"IOS10", category:"ios", name:"SIRIOS X3",            brand:"SIRIOS",           subtype:"", serialNumber:"EQ-10", status:"active" },
  { id:"DGL01", category:"dongle", name:"3Shape",            brand:"3Shape",           subtype:"CAD", serialNumber:"DGL-01", status:"active" },
  { id:"DGL02", category:"dongle", name:"ExoCAD Dental CAD", brand:"Exocad",           subtype:"CAD", serialNumber:"DGL-02", status:"active" },
  { id:"DGL03", category:"dongle", name:"ExoCAD Dental CAD", brand:"Exocad",           subtype:"CAD", serialNumber:"DGL-03", status:"active" },
  { id:"DGL04", category:"dongle", name:"ExoCAD Dental CAD", brand:"Exocad",           subtype:"CAD", serialNumber:"DGL-04", status:"active" },
  { id:"DGL05", category:"dongle", name:"ExoCAD Dental CAD", brand:"Exocad",           subtype:"CAD", serialNumber:"DGL-05", status:"active" },
  { id:"DGL06", category:"dongle", name:"ExoCAD Dental CAD", brand:"Exocad",           subtype:"CAD", serialNumber:"DGL-06", status:"active" },
  { id:"DGL07", category:"dongle", name:"ExoCAD Dental CAD", brand:"Exocad",           subtype:"CAD", serialNumber:"DGL-07", status:"active" },
  { id:"DGL08", category:"dongle", name:"ExoCAD Dental CAD", brand:"Exocad",           subtype:"CAD", serialNumber:"DGL-08", status:"active" },
  { id:"DGL09", category:"dongle", name:"ExoCAD Dental CAD", brand:"Exocad",           subtype:"CAD", serialNumber:"DGL-09", status:"active" },
  { id:"DGL10", category:"dongle", name:"ExoCAD Dental CAD", brand:"Exocad",           subtype:"CAD", serialNumber:"DGL-10", status:"active" },
];

const EQUIP_CATEGORY_LABELS = { ios:"เครื่องสแกนช่องปาก (IOS)", dongle:"ดองเกิลโปรแกรม" };
const EQUIP_SUBTYPE_LABELS  = { CAD:"CAD", "Implant Planning":"วางแผนรากฟันเทียม" };

/* Equipment is booked per hour-block 08:00–17:00 (finer-grained than unit sessions,
   since one scanner/dongle typically serves many students in a day). */
const EQUIP_TIME_SLOTS = Array.from({ length: 9 }, (_, i) => {
  const h = 8 + i;
  return `${String(h).padStart(2, "0")}:00-${String(h + 1).padStart(2, "0")}:00`;
});

/* Auto-assign advisors for a given date+session.
   Zone A/B/C is determined purely by position in the advisors array —
   the first matching advisor gets Zone A, second gets Zone B, third gets Zone C.
   defaultZone is no longer used for assignment (kept as a reference label only). */
function autoAssignAdvisors(dateStr, session, advisors) {
  const dow = getDow(dateStr);
  const matches = advisors.filter(a =>
    a.active &&
    a.schedule.some(s => s.dow === dow && s.session === session)
  );
  return [
    matches[0]?.id || "",
    matches[1]?.id || "",
    matches[2]?.id || "",
  ];
}

/* Build session advisor map for next 14 days from advisor schedules.
   Priority: per-day override > monthly lineup (by dow) > auto-assign.
   monthlyLineups shape: { "YYYY-MM": { 1: { morning:[...], afternoon:[...] }, 2:{...}, ... } }
   dow: 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri */
function buildSessionAdvisors(advisors, monthlyLineups = {}) {
  const map = {};
  next14Days.forEach(d => {
    getAvailableSessions(d).forEach(s => {
      const monthKey = d.slice(0, 7);           // "YYYY-MM"
      const dow      = getDow(d);               // 0–6, weekdays are 1–5
      const dowSlot  = monthlyLineups[monthKey]?.[dow];
      if (dowSlot && dowSlot[s] && dowSlot[s].some(id => id)) {
        map[`${d}__${s}`] = [...dowSlot[s]];
      } else {
        map[`${d}__${s}`] = autoAssignAdvisors(d, s, advisors);
      }
    });
  });
  return map;
}

/* ── Clean sequential ID generator ──────────────────────────────────────────
   Produces human-readable IDs:
     Reservations: R-YYYYMMDD-NNNN  (e.g. R-20250313-0042)
     Students:     D followed by 4-digit zero-padded number (e.g. D6042)
     Advisors:     ADV followed by 3-digit zero-padded number (e.g. ADV012)
   Uses the existing list to find the next available number.              */
function generateId(type, existingItems) {
  if (type === "reservation") {
    const d = todayStr.replace(/-/g,"");
    const todayRsvs = existingItems.filter(r=>r.createdAt===todayStr||r.id.startsWith(`R-${d}`));
    const n = String(todayRsvs.length + 1).padStart(4,"0");
    // Add a 3-character random suffix to prevent collisions during simultaneous bookings
    const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `R-${d}-${n}-${rand}`;
  }
  if (type === "student") {
    const nums = existingItems.map(s=>parseInt(s.id.replace(/\D/g,""),10)).filter(n=>!isNaN(n));
    const next = nums.length ? Math.max(...nums)+1 : 6001;
    return `D${next}`;
  }
  if (type === "advisor") {
    const nums = existingItems.map(a=>parseInt(a.id.replace(/\D/g,""),10)).filter(n=>!isNaN(n));
    const next = nums.length ? Math.max(...nums)+1 : 1;
    return `ADV${String(next).padStart(3,"0")}`;
  }
  if (type === "equipmentReservation") {
    const d = todayStr.replace(/-/g, "");
    const todayRsvs = existingItems.filter(r => r.createdAt === todayStr || r.id.startsWith(`ER-${d}`));
    const n = String(todayRsvs.length + 1).padStart(4, "0");
    const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `ER-${d}-${n}-${rand}`;
  }
  return `${type}-${Date.now()}`;
}
const C = {
  ink:"#16191f", muted:"#6b7280", faint:"#9ca3af", line:"#e5e7eb",
  soft:"#f4f5f7", white:"#ffffff",
  accent:"#1e3a5f", accentLight:"#e8eef7",
  amber:"#92400e", amberBg:"#fef3c7", amberLine:"#fcd34d",
  red:"#991b1b", redBg:"#fee2e2",
  green:"#065f46", greenBg:"#d1fae5", greenLine:"#6ee7b7",
  pink:"#9d174d", pinkBg:"#fce7f3",
  blue:"#1d4ed8", blueBg:"#eff6ff",
};
const btnStyle = (v="primary") => ({
  padding:"9px 18px", borderRadius:8,
  border:v==="ghost"?`1px solid ${C.line}`:"none",
  cursor:"pointer", fontFamily:"'Sarabun','Outfit',sans-serif", fontSize:13.5, fontWeight:500,
  background:v==="primary"?C.ink:v==="danger"?C.redBg:v==="amber"?C.amberBg:"transparent",
  color:v==="primary"?"#fff":v==="danger"?C.red:v==="amber"?C.amber:C.ink,
});
const inpStyle = { width:"100%", padding:"9px 12px", borderRadius:8, border:`1px solid ${C.line}`, fontFamily:"'Sarabun','Outfit',sans-serif", fontSize:14, color:C.ink, outline:"none", boxSizing:"border-box", background:"#fff" };
const lblStyle = { fontSize:12, fontWeight:600, color:C.muted, letterSpacing:0.5, textTransform:"uppercase", display:"block", marginBottom:5 };
const cardStyle = { background:"#fff", borderRadius:12, border:`1px solid ${C.line}`, padding:24 };

/* ═══ Badge ══════════════════════════════════════════════════════════════════════ */
function Badge({ t, children }) {
  const m = {
    confirmed:[C.greenBg,C.green], pending:[C.amberBg,C.amber],
    cancelled:[C.soft,C.muted], overbooked:[C.pinkBg,C.pink],
    maintenance:[C.soft,C.muted], morning:["#eff6ff","#1d4ed8"],
    afternoon:["#faf5ff","#6b21a8"], active:[C.accentLight,C.accent],
  };
  const [bg,color] = m[t]||m.pending;
  return <span style={{ background:bg, color, borderRadius:99, padding:"2px 10px", fontSize:11.5, fontWeight:500 }}>{children}</span>;
}

/* ═══ Modal ══════════════════════════════════════════════════════════════════════ */
function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(10,14,18,0.5)", backdropFilter:"blur(4px)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:"#fff", borderRadius:14, width:"100%", maxWidth:wide?680:540, maxHeight:"90vh", overflowY:"auto", boxShadow:"0 32px 80px rgba(0,0,0,0.15)" }}>
        <div style={{ padding:"20px 26px", borderBottom:`1px solid ${C.line}`, display:"flex", justifyContent:"space-between", alignItems:"center", position:"sticky", top:0, background:"#fff", zIndex:1 }}>
          <h3 style={{ margin:0, fontSize:17, fontFamily:"'Cormorant Garamond',serif", fontWeight:600 }}>{title}</h3>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", color:C.muted, fontSize:18 }}>✕</button>
        </div>
        <div style={{ padding:"22px 26px 28px" }}>{children}</div>
      </div>
    </div>
  );
}

/* ═══ Toast ══════════════════════════════════════════════════════════════════════ */
function Toast({ msg, onClose }) {
  useEffect(()=>{ const t=setTimeout(onClose,4500); return ()=>clearTimeout(t); },[]);
  return (
    <div style={{ position:"fixed", bottom:28, right:28, background:msg.warn?C.amberBg:C.ink, color:msg.warn?C.amber:"#fff", border:msg.warn?`1px solid ${C.amberLine}`:"none", padding:"12px 18px 12px 14px", borderRadius:10, zIndex:300, maxWidth:380, fontSize:13.5, boxShadow:"0 8px 32px rgba(0,0,0,0.15)", display:"flex", gap:10, alignItems:"flex-start" }}>
      <span style={{ fontSize:16 }}>{msg.warn?"⚠":"✓"}</span>
      <span style={{ flex:1 }}>{msg.text}</span>
      <button onClick={onClose} style={{ background:"none", border:"none", color:msg.warn?C.amber:"rgba(255,255,255,0.4)", cursor:"pointer" }}>✕</button>
    </div>
  );
}

/* ═══ Loading overlay ════════════════════════════════════════════════════════════ */
function LoadingOverlay({ text }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(255,255,255,0.8)", backdropFilter:"blur(3px)", zIndex:400, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14 }}>
      <div style={{ width:36, height:36, borderRadius:"50%", border:`3px solid ${C.line}`, borderTopColor:C.ink, animation:"spin 0.7s linear infinite" }} />
      <p style={{ margin:0, fontSize:14, color:C.muted, fontFamily:"'Sarabun','Outfit',sans-serif" }}>{text||"กำลังโหลดข้อมูล…"}</p>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

/* ═══ CHANGE PASSWORD MODAL ══════════════════════════════════════════════════════ */
function ChangePasswordModal({ user, onSave, onClose }) {
  const [current,  setCurrent]  = useState("");
  const [next,     setNext]     = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [err,      setErr]      = useState("");
  const [saving,   setSaving]   = useState(false);

  const submit = async () => {
    setErr("");
    if (current !== user.password)       return setErr("รหัสผ่านปัจจุบันไม่ถูกต้อง");
    if (next.length < 6)                 return setErr("รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร");
    if (next !== confirm)                return setErr("รหัสผ่านใหม่ไม่ตรงกัน");
    if (next === current)                return setErr("รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม");
    setSaving(true);
    try {
      await onSave(next);
      onClose();
    } catch (e) {
      setErr(`บันทึกไม่สำเร็จ: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="เปลี่ยนรหัสผ่าน" onClose={onClose}>
      <div style={{ marginBottom:14 }}>
        <label style={lblStyle}>รหัสผ่านปัจจุบัน</label>
        <input style={inpStyle} type="password" value={current} onChange={e=>setCurrent(e.target.value)} placeholder="••••••••" />
      </div>
      <div style={{ marginBottom:14 }}>
        <label style={lblStyle}>รหัสผ่านใหม่</label>
        <input style={inpStyle} type="password" value={next} onChange={e=>setNext(e.target.value)} placeholder="อย่างน้อย 6 ตัวอักษร" />
      </div>
      <div style={{ marginBottom:20 }}>
        <label style={lblStyle}>ยืนยันรหัสผ่านใหม่</label>
        <input style={inpStyle} type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} placeholder="••••••••" />
      </div>
      {err && <p style={{ margin:"0 0 14px", color:C.red, fontSize:13 }}>{err}</p>}
      <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
        <button style={btnStyle("ghost")} onClick={onClose}>ยกเลิก</button>
        <button style={btnStyle("primary")} onClick={submit} disabled={saving}>
          {saving ? "กำลังบันทึก…" : "บันทึกรหัสผ่าน"}
        </button>
      </div>
    </Modal>
  );
}

/* ═══ LOGIN ══════════════════════════════════════════════════════════════════════ */
function LoginPage({ onLogin, students, advisors, admins, sheetsReady, loadError, onRetry, onSyncReady }) {
  const [role, setRole]       = useState("student");
  const [username, setUser]   = useState("");
  const [pass, setPass]       = useState("");
  const [err, setErr]         = useState("");
  const [waiting, setWaiting] = useState(false); // true while polling for sync to finish

  /* go() — validate credentials.
     If Sheets hasn't finished loading yet (sheetsReady=false) AND there's no
     load error, poll every 250ms until it is done — then validate against the
     live data instead of seed data. If a load error is already present, don't
     poll at all — just validate against whatever's currently in state (seed
     data, or a previously successful sync), so a permanent server-side outage
     doesn't permanently lock everyone out of the login screen. */
  const go = async () => {
    setErr("");

    if (!sheetsReady && !loadError) {
      setWaiting(true);
      await new Promise(resolve => {
        const poll = setInterval(() => {
          if (onSyncReady()) { clearInterval(poll); resolve(); }
        }, 250);
      });
      setWaiting(false);
    }

    let validUser = null;

    if (role === "student") {
      const s = students.find(x => x.username === username && x.password === pass && x.active !== false);
      if (s) validUser = { ...s, role: "student" };
    } else if (role === "admin") {
      const a = admins.find(x => x.username === username && x.password === pass);
      if (a) validUser = { ...a, role: "admin" };
    } else {
      const adv = advisors.find(x => x.username === username && x.password === pass && x.active !== false);
      if (adv) validUser = { ...adv, role: "advisor" };
    }

    if (validUser) {
      try {
        await initGoogleAuth();
        onLogin(validUser);
      } catch (e) {
        setErr("ไม่สามารถเชื่อมต่อ Google ได้ กรุณาอนุญาต Pop-up (Please allow pop-ups)");
      }
    } else {
      setErr("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
    }
  };

  // Only block the form while genuinely still loading — a load error means
  // loading has stopped (even if unsuccessfully), so don't keep it disabled.
  const isBusy = (!sheetsReady && !loadError) || waiting;

  return (
    <div style={{ fontFamily:"'Sarabun','Outfit',sans-serif", background:C.soft, minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ width:"100%", maxWidth:400 }}>
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ width:58, height:58, borderRadius:16, background:C.ink, display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:28, marginBottom:14 }}>🦷</div>
          <h1 style={{ margin:0, fontFamily:"'Cormorant Garamond',serif", fontSize:34, fontWeight:600, letterSpacing:-0.5, color:C.ink }}>CUProstho</h1>
          <p style={{ margin:"5px 0 0", color:C.muted, fontSize:14 }}>คณะทันตแพทยศาสตร์ · ระบบจองยูนิต</p>
        </div>

        {loadError && (
          <div style={{ background:C.redBg, border:"1px solid #fca5a5", borderRadius:10, padding:"12px 16px", marginBottom:16, fontSize:13, color:C.red }}>
            <div style={{ display:"flex", alignItems:"flex-start", gap:8, marginBottom:8 }}>
              <span style={{ fontSize:16, flexShrink:0 }}>⚠</span>
              <div>
                <strong>เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ</strong>
                <p style={{ margin:"3px 0 0", fontSize:12.5, opacity:0.9 }}>{loadError}</p>
              </div>
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center", justifyContent:"space-between" }}>
              <span style={{ fontSize:11.5, opacity:0.8 }}>คุณยังสามารถลองเข้าสู่ระบบด้วยข้อมูลที่มีอยู่ได้</span>
              <button onClick={onRetry} style={{ ...btnStyle("ghost"), padding:"5px 12px", fontSize:12, color:C.red, border:"1px solid #fca5a5", whiteSpace:"nowrap" }}>
                ↻ ลองใหม่
              </button>
            </div>
          </div>
        )}

        <div style={{ ...cardStyle, boxShadow:"0 4px 24px rgba(0,0,0,0.07)" }}>
          <div style={{ display:"flex", background:C.soft, borderRadius:8, padding:3, marginBottom:22 }}>
            {[["student","นิสิต"],["advisor","อาจารย์"],["admin","แอดมิน"]].map(([r,l])=>(
              <button key={r} onClick={()=>{setRole(r);setErr("");setUser("");setPass("");}}
                style={{ flex:1, padding:"8px 0", borderRadius:6, border:"none", cursor:"pointer", fontFamily:"'Sarabun','Outfit',sans-serif", fontSize:12.5, fontWeight:500, background:role===r?"#fff":"transparent", color:role===r?C.ink:C.muted, boxShadow:role===r?"0 1px 4px rgba(0,0,0,0.09)":"none", transition:"all .15s" }}>{l}
              </button>
            ))}
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={lblStyle}>ชื่อผู้ใช้</label>
            <input style={{ ...inpStyle, opacity: isBusy ? 0.5 : 1 }} disabled={isBusy} value={username} onChange={e=>setUser(e.target.value)} placeholder={role==="student"?"รหัสประจำตัวนิสิต 10 หลัก":role==="admin"?"admin":"เช่น siriporn"} />
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={lblStyle}>รหัสผ่าน</label>
            <input style={{ ...inpStyle, opacity: isBusy ? 0.5 : 1 }} disabled={isBusy} type="password" value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!isBusy&&go()} placeholder="••••••••" />
          </div>
          {isBusy && (
            <div style={{ display:"flex", alignItems:"center", gap:8, background:C.accentLight, border:"1px solid #bfdbfe", borderRadius:8, padding:"9px 13px", marginBottom:14, fontSize:13, color:C.accent }}>
              <div style={{ width:13, height:13, borderRadius:"50%", border:`2px solid ${C.accent}`, borderTopColor:"transparent", animation:"spin 0.7s linear infinite", flexShrink:0 }} />
              <span>{waiting ? "กำลังตรวจสอบข้อมูล กรุณารอสักครู่…" : "กำลังโหลดข้อมูลจากเซิร์ฟเวอร์…"}</span>
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
          )}
          {err && <p style={{ margin:"0 0 14px", color:C.red, fontSize:13 }}>{err}</p>}
          <button onClick={go} disabled={isBusy} style={{ ...btnStyle("primary"), width:"100%", padding:"11px 0", fontSize:14, opacity: isBusy ? 0.6 : 1, cursor: isBusy ? "not-allowed" : "pointer" }}>
            {waiting ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══ BOOKING MODAL ══════════════════════════════════════════════════════════════ */
function BookingModal({ unit, date, session, reservations, sessionAdvisors, advisors, user, onConfirm, onClose }) {
  const [patientName, setPatientName] = useState("");
  const [hn, setHn]                   = useState("");
  const [treatment, setTreatment]     = useState("");
  const [isGhost, setIsGhost]         = useState(false);
  const [inheritUnit, setInheritUnit] = useState(false);
  const [err, setErr]                 = useState("");
  const [dupConfirmed, setDupConfirmed] = useState(false);

  const existing   = reservations.filter(r=>r.date===date&&r.session===session&&r.unitId===unit.id&&r.status!=="cancelled");
  const alreadyMe  = reservations.find(r=>r.studentId===user.id&&r.date===date&&r.session===session&&r.unitId===unit.id&&r.status!=="cancelled");
  const overbooked = existing.length > 0;

  const key    = `${date}__${session}`;
  const advIds = sessionAdvisors[key] || ["","",""];
  const zoneAdv = advisors.find(a=>a.id===advIds[unit.zoneIdx]);

  // Step 1: if same student already has THIS unit in this session, show confirm gate first
  if (alreadyMe && !dupConfirmed) {
    return (
      <Modal title={`จองยูนิต ${unit.name}`} onClose={onClose}>
        <div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:10, padding:"18px 20px", marginBottom:20 }}>
          <p style={{ margin:"0 0 8px", fontWeight:600, fontSize:14.5, color:"#1d4ed8" }}>⚠ คุณจองยูนิตนี้ในช่วงนี้ไปแล้ว</p>
          <p style={{ margin:0, fontSize:13.5, color:C.ink }}>
            คุณมีการจอง <strong>{unit.name}</strong> ใน{session==="morning"?"ช่วงเช้า":"ช่วงบ่าย"}ของ{displayDate(date)}อยู่แล้ว
            (ผู้ป่วย: {alreadyMe.patientName} · HN: {alreadyMe.hn})
          </p>
          <p style={{ margin:"10px 0 0", fontSize:13, color:C.muted }}>
            หากคุณมีผู้ป่วย 2 คนในยูนิตเดียวกัน กรุณายืนยันเพื่อจองเพิ่ม
          </p>
        </div>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button style={btnStyle("ghost")} onClick={onClose}>ยกเลิก</button>
          <button style={btnStyle("primary")} onClick={()=>setDupConfirmed(true)}>จองเพิ่มสำหรับผู้ป่วยคนที่ 2 →</button>
        </div>
      </Modal>
    );
  }

  const submit = () => {
    if (!patientName.trim()) return setErr("กรุณากรอกชื่อผู้ป่วย");
    if (!hn.trim())          return setErr("กรุณากรอก HN");
    if (!treatment.trim())   return setErr("กรุณากรอกข้อมูลการรักษา");
    onConfirm({ patientName, hn, treatment, overbooked, isGhost, inheritUnit });
  };

  return (
    <Modal title={`จองยูนิต ${unit.name}`} onClose={onClose}>
      <div style={{ background:C.soft, borderRadius:8, padding:"12px 16px", marginBottom:18, display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px 16px" }}>
        {[["ยูนิต",unit.name],["โซน",unit.room],["อาจารย์นิเทศ",zoneAdv?zoneAdv.name:"ยังไม่ระบุ"],["วันที่",displayDate(date)],["ช่วงเวลา",session==="morning"?"เช้า 09:00–12:00":"บ่าย 13:00–16:00"]].map(([k,v])=>(
          <div key={k}><span style={{ ...lblStyle, marginBottom:2 }}>{k}</span><span style={{ fontSize:13.5, fontWeight:500 }}>{v}</span></div>
        ))}
      </div>
      {overbooked && (
        <div style={{ background:C.amberBg, border:`1px solid ${C.amberLine}`, borderRadius:8, padding:"10px 14px", marginBottom:14, fontSize:13 }}>
          <strong>⚠ แจ้งเตือน Overbook:</strong> {unit.name} มีการจองแล้วในช่วงนี้ การดำเนินการต่อจะแจ้งผู้ดูแลระบบ
        </div>
      )}
      <div style={{ display:"grid", gap:14 }}>
        <div>
          <label style={lblStyle}>ชื่อ-นามสกุลผู้ป่วย *</label>
          <input style={inpStyle} value={patientName} onChange={e=>setPatientName(e.target.value)} placeholder="เช่น สมชาย ทนารักษ์" />
        </div>
        <div>
          <label style={lblStyle}>HN (เลขประจำตัวผู้ป่วย) *</label>
          <input style={inpStyle} value={hn} onChange={e=>setHn(e.target.value)} placeholder="เช่น HN-20341" />
        </div>
        <div>
          <label style={lblStyle}>การรักษา / หัตถการ *</label>
          <input style={inpStyle} value={treatment} onChange={e=>setTreatment(e.target.value)} placeholder="เช่น Composite Filling #36" />
        </div>
        {/* ผี checkbox */}
        <div style={{ background:"#fdf4ff", border:"1px solid #e9d5ff", borderRadius:8, padding:"12px 14px", display:"flex", alignItems:"flex-start", gap:12 }}>
          <input type="checkbox" id="ghost-chk" checked={isGhost} onChange={e=>setIsGhost(e.target.checked)}
            style={{ width:17, height:17, marginTop:2, accentColor:"#7c3aed", cursor:"pointer", flexShrink:0 }} />
          <label htmlFor="ghost-chk" style={{ cursor:"pointer", fontSize:13.5 }}>
            <span style={{ fontWeight:600, color:"#7c3aed" }}>👻 ฉันเป็นผี</span>
            <span style={{ color:C.muted, marginLeft:6 }}>— ฉันไม่มีสิทธิ์จองในช่วงนี้ตามตาราง</span>
          </label>
        </div>
       {/* Inherit Unit checkbox — now shown whenever the unit is already booked */}
{overbooked && (
  <div style={{ background:"#fffbeb", border:"1px solid #fcd34d", borderRadius:8, padding:"12px 14px", display:"flex", alignItems:"flex-start", gap:12 }}>
    <input 
      type="checkbox" 
      id="inherit-chk" 
      checked={inheritUnit} 
      onChange={e=>setInheritUnit(e.target.checked)}
      style={{ width:17, height:17, marginTop:2, accentColor:"#d97706", cursor:"pointer", flexShrink:0 }} 
    />
    <label htmlFor="inherit-chk" style={{ cursor:"pointer", fontSize:13.5 }}>
      <span style={{ fontWeight:600, color:"#d97706" }}>🔗 ใช้ยูนิตต่อ</span>
      <span style={{ color:C.muted, marginLeft:6 }}>
        — ใช้ยูนิตต่อจากนิสิตคนก่อนหน้าในคาบเดียวกัน
      </span>
    </label>
  </div>
)}
      </div>
      {err && <p style={{ margin:"12px 0 0", color:C.red, fontSize:13 }}>{err}</p>}
      <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:22 }}>
        <button style={btnStyle("ghost")} onClick={onClose}>ยกเลิก</button>
        <button style={btnStyle("primary")} onClick={submit}>ยืนยันการจอง</button>
      </div>
    </Modal>
  );
}

/* ═══ EQUIPMENT BOOKING MODAL ═════════════════════════════════════════════════ */
function EquipmentBookingModal({ equipment, date, timeSlot, maxDuration = 1, onConfirm, onClose }) {
  const [purpose, setPurpose] = useState("");
  const [caseHn, setCaseHn]   = useState("");
  const [duration, setDuration] = useState(1);
  const [err, setErr]         = useState("");

  const submit = () => {
    if (!purpose.trim()) return setErr("กรุณากรอกวัตถุประสงค์การใช้งาน");
    onConfirm({ purpose, caseHn, duration });
  };

  const startHour = parseInt(timeSlot.split(":")[0], 10);
  const endHour = startHour + duration;
  const displayTime = `${String(startHour).padStart(2,"0")}:00-${String(endHour).padStart(2,"0")}:00`;

  return (
    <Modal title={`จอง ${equipment.name}`} onClose={onClose}>
      <div style={{ background:C.soft, borderRadius:8, padding:"12px 16px", marginBottom:18, display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px 16px" }}>
        {[
          ["อุปกรณ์", equipment.name],
          ["ประเภท", EQUIP_CATEGORY_LABELS[equipment.category]],
          equipment.subtype ? ["หมวดหมู่", EQUIP_SUBTYPE_LABELS[equipment.subtype] || equipment.subtype] : null,
          ["วันที่", displayDate(date)],
          ["ช่วงเวลา", displayTime],
        ].filter(Boolean).map(([k, v]) => (
          <div key={k}><span style={{ ...lblStyle, marginBottom:2 }}>{k}</span><span style={{ fontSize:13.5, fontWeight:500 }}>{v}</span></div>
        ))}
      </div>
      <div style={{ display:"grid", gap:14 }}>
        <div>
          <label style={lblStyle}>ระยะเวลา (ชั่วโมง)</label>
          <select style={{ ...inpStyle, width:"100%" }} value={duration} onChange={e => setDuration(Number(e.target.value))}>
            {Array.from({length: maxDuration}, (_, i) => i + 1).map(d => (
              <option key={d} value={d}>{d} ชั่วโมง</option>
            ))}
          </select>
        </div>
        <div>
          <label style={lblStyle}>วัตถุประสงค์การใช้งาน *</label>
          <input style={inpStyle} value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="เช่น สแกนเพื่อทำ Crown, วางแผนรากฟันเทียม" />
        </div>
        <div>
          <label style={lblStyle}>เคส / HN ผู้ป่วย (ถ้ามี)</label>
          <input style={inpStyle} value={caseHn} onChange={e => setCaseHn(e.target.value)} placeholder="เช่น HN-20341" />
        </div>
      </div>
      <div style={{ marginTop: 14, padding: "10px 14px", background: "#fff4e5", color: "#b25205", borderRadius: 6, fontSize: 13, border: "1px solid #ffe0b2", display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 16 }}>⚠️</span>
        <span style={{ fontWeight: 600 }}>แจ้งพี่หนิงเพื่อคืนหลังใช้เสร็จทุกครั้ง!</span>
      </div>
      {err && <p style={{ margin:"12px 0 0", color:C.red, fontSize:13 }}>{err}</p>}
      <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:22 }}>
        <button style={btnStyle("ghost")} onClick={onClose}>ยกเลิก</button>
        <button style={btnStyle("primary")} onClick={submit}>ยืนยันการจอง</button>
      </div>
    </Modal>
  );
}

/* ═══ EQUIPMENT BROWSE / BOOK (student + advisor) ═══════════════════════════════ */
function EquipmentBrowsePage({ equipment, equipmentReservations, user, onBook, onCancel }) {
  const [category, setCategory] = useState("ios");
  const [date, setDate]         = useState(next14Days[0]);
  const [target, setTarget]     = useState(null); // { item, slot }

  const items = equipment.filter(e => e.category === category && e.status === "active");
  const bookingFor = (equipId, slot) =>
    equipmentReservations.find(r => r.equipmentId === equipId && r.date === date && r.timeSlot === slot && r.status !== "cancelled");

  return (
    <div>
      <div style={{ marginBottom:28 }}>
        <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>จองอุปกรณ์</h2>
        <p style={{ margin:0, color:C.muted, fontSize:14 }}>เครื่องสแกนช่องปาก (IOS) และดองเกิลโปรแกรม · จองเป็นรายชั่วโมง</p>
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:18 }}>
        {Object.entries(EQUIP_CATEGORY_LABELS).map(([k, l]) => (
          <button key={k} onClick={() => setCategory(k)} style={{ ...btnStyle(category === k ? "primary" : "ghost"), fontSize:13 }}>{l}</button>
        ))}
      </div>

      <div style={{ ...cardStyle, marginBottom:18, padding:"14px 18px" }}>
        <div style={{ display:"flex", gap:8, overflowX:"auto", paddingBottom:2 }}>
          {next14Days.map(d => (
            <button key={d} onClick={() => setDate(d)} style={{ flexShrink:0, padding:"8px 12px", borderRadius:8, border:date === d ? `1.5px solid ${C.ink}` : `1px solid ${C.line}`, background:date === d ? C.ink : "#fff", color:date === d ? "#fff" : C.ink, cursor:"pointer", fontFamily:"'Sarabun','Outfit',sans-serif", fontSize:12.5, fontWeight:500, minWidth:74, textAlign:"center" }}>
              {shortDay(d)}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <div style={{ ...cardStyle, textAlign:"center", padding:"52px", color:C.muted }}>ไม่มีอุปกรณ์ในหมวดนี้</div>
      ) : items.map(item => (
        <div key={item.id} style={{ ...cardStyle, marginBottom:16 }}>
          <div style={{ marginBottom:12 }}>
            <p style={{ margin:0, fontWeight:600, fontSize:15 }}>{item.name}</p>
            <p style={{ margin:"2px 0 0", fontSize:12, color:C.muted }}>
              {item.brand}{item.subtype ? ` · ${EQUIP_SUBTYPE_LABELS[item.subtype] || item.subtype}` : ""} · S/N {item.serialNumber}
            </p>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))", gap:8 }}>
            {EQUIP_TIME_SLOTS.map(slot => {
              const bk = bookingFor(item.id, slot);
              const isMine = bk?.studentId === user.id;
              return (
                <button key={slot} disabled={!!bk && !isMine}
                  onClick={() => {
                    if (!bk) {
                      setTarget({ item, slot });
                    } else if (isMine) {
                      const currentHour = new Date().getHours();
                      const slotStartHour = parseInt(slot.split(":")[0]);
                      if (date < todayStr || (date === todayStr && currentHour >= slotStartHour)) {
                        alert("ไม่สามารถยกเลิกการจองที่ถึงเวลาหรือผ่านมาแล้วได้");
                      } else {
                        if (window.confirm(`คุณต้องการยกเลิกการจอง ${item.name} เวลา ${slot} ใช่หรือไม่?`)) {
                          onCancel(bk.id);
                        }
                      }
                    }
                  }}
                  style={{
                    padding:"9px 6px", borderRadius:8, fontSize:12, fontWeight:500,
                    border:`1px solid ${bk ? (isMine ? C.greenLine : C.line) : C.line}`,
                    background:bk ? (isMine ? C.greenBg : C.soft) : "#fff",
                    color:bk ? (isMine ? C.green : C.faint) : C.ink,
                    cursor:bk && !isMine ? "not-allowed" : "pointer",
                  }}>
                  {slot}
                  <div style={{ fontSize:10, marginTop:2 }}>{bk ? (isMine ? "ยกเลิก" : "ไม่ว่าง") : "ว่าง"}</div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {target && (() => {
        const startIndex = EQUIP_TIME_SLOTS.indexOf(target.slot);
        let maxDuration = 1;
        for (let i = 1; i < 3; i++) {
          if (startIndex + i >= EQUIP_TIME_SLOTS.length) break;
          const nextSlot = EQUIP_TIME_SLOTS[startIndex + i];
          if (bookingFor(target.item.id, nextSlot)) break;
          maxDuration++;
        }

        return (
          <EquipmentBookingModal equipment={target.item} date={date} timeSlot={target.slot} maxDuration={maxDuration}
            onClose={() => setTarget(null)}
            onConfirm={(data) => { onBook({ equipment: target.item, date, timeSlot: target.slot, duration: data.duration, ...data }); setTarget(null); }} />
        );
      })()}
    </div>
  );
}

/* ═══ ADMIN — EQUIPMENT INVENTORY ═══════════════════════════════════════════════ */
function EquipmentFormModal({ item, onSave, onClose }) {
  const [category, setCategory]     = useState(item?.category || "ios");
  const [name, setName]             = useState(item?.name || "");
  const [brand, setBrand]           = useState(item?.brand || "");
  const [subtype, setSubtype]       = useState(item?.subtype || "");
  const [serialNumber, setSN]       = useState(item?.serialNumber || "");
  const [err, setErr]               = useState("");

  const save = () => {
    if (!name.trim())  return setErr("กรุณากรอกชื่ออุปกรณ์");
    if (!brand.trim()) return setErr("กรุณากรอกยี่ห้อ");
    onSave({ id: item?.id || "", category, name, brand, subtype: category === "dongle" ? subtype : "", serialNumber, status: item?.status || "active" });
  };

  return (
    <Modal title={`${item ? "แก้ไข" : "เพิ่ม"}อุปกรณ์`} onClose={onClose}>
      <div style={{ marginBottom:14 }}>
        <label style={lblStyle}>ประเภท</label>
        <select style={inpStyle} value={category} onChange={e => setCategory(e.target.value)}>
          <option value="ios">เครื่องสแกนช่องปาก (IOS)</option>
          <option value="dongle">ดองเกิลโปรแกรม</option>
        </select>
      </div>
      <div style={{ marginBottom:14 }}>
        <label style={lblStyle}>ชื่ออุปกรณ์ / โปรแกรม</label>
        <input style={inpStyle} value={name} onChange={e => setName(e.target.value)} placeholder={category === "ios" ? "เช่น iTero Element 5D" : "เช่น Exocad DentalCAD"} />
      </div>
      <div style={{ marginBottom:14 }}>
        <label style={lblStyle}>ยี่ห้อ</label>
        <input style={inpStyle} value={brand} onChange={e => setBrand(e.target.value)} />
      </div>
      {category === "dongle" && (
        <div style={{ marginBottom:14 }}>
          <label style={lblStyle}>หมวดหมู่โปรแกรม</label>
          <select style={inpStyle} value={subtype} onChange={e => setSubtype(e.target.value)}>
            <option value="">— เลือก —</option>
            <option value="CAD">CAD</option>
            <option value="Implant Planning">วางแผนรากฟันเทียม (Implant Planning)</option>
          </select>
        </div>
      )}
      <div style={{ marginBottom:14 }}>
        <label style={lblStyle}>หมายเลขเครื่อง / Serial Number</label>
        <input style={inpStyle} value={serialNumber} onChange={e => setSN(e.target.value)} />
      </div>
      {err && <p style={{ margin:"0 0 10px", color:C.red, fontSize:13 }}>{err}</p>}
      <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
        <button style={btnStyle("ghost")} onClick={onClose}>ยกเลิก</button>
        <button style={btnStyle("primary")} onClick={save}>บันทึก</button>
      </div>
    </Modal>
  );
}

function AdminEquipmentPage({ equipment, setEquipment, notify }) {
  const [modal, setModal]           = useState(null); // { item }
  const [confirmDel, setConfirmDel] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (items) => {
    if (selectedIds.size === items.length && items.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map(i => i.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`ยืนยันการลบ ${selectedIds.size} รายการที่เลือก?`)) return;

    const ids = Array.from(selectedIds);
    const prev = [...equipment];
    setEquipment(p => p.filter(e => !ids.includes(e.id)));
    notify("กำลังลบอุปกรณ์ที่เลือก (บันทึกพื้นหลัง)");
    try {
      await SheetsDB.batchUpdateStatus("Equipment", ids, 7, "removed");
      notify(`✓ ลบอุปกรณ์ ${ids.length} รายการเสร็จสมบูรณ์`);
    } catch (error) {
      setEquipment(prev);
      notify(`⚠ ลบไม่สำเร็จ: ${error.message}`, true);
    }
    setSelectedIds(new Set());
  };

  const save = async (data) => {
    const prev = [...equipment];
    const isEdit = !!data.id;
    let target = { ...data };
    if (isEdit) setEquipment(p => p.map(e => e.id === target.id ? target : e));
    else {
      target = { ...target, id: `EQ-${Date.now()}` };
      setEquipment(p => [...p, target]);
    }
    notify(`${isEdit ? "อัปเดต" : "เพิ่ม"}อุปกรณ์ (กำลังบันทึกพื้นหลัง)`);
    setModal(null);
    try {
      if (isEdit) await SheetsDB.updateEquipment(target);
      else        await SheetsDB.appendEquipment(target);
      notify("✓ บันทึกอุปกรณ์ลงฐานข้อมูลเสร็จสมบูรณ์");
    } catch (error) {
      setEquipment(prev);
      notify(`⚠ บันทึกไม่สำเร็จ ระบบคืนค่าเดิม: ${error.message}`, true);
    }
  };

  const toggleStatus = async (item) => {
    const newStatus = item.status === "active" ? "maintenance" : "active";
    const prev = [...equipment];
    setEquipment(p => p.map(e => e.id === item.id ? { ...e, status: newStatus } : e));
    notify("อัปเดตสถานะอุปกรณ์ (กำลังบันทึกพื้นหลัง)");
    try {
      await SheetsDB.saveEquipmentStatus(item.id, newStatus);
      notify("✓ อัปเดตสถานะเสร็จสมบูรณ์");
    } catch (error) {
      setEquipment(prev);
      notify(`⚠ อัปเดตไม่สำเร็จ: ${error.message}`, true);
    }
  };

  const remove = async (id) => {
    const prev = [...equipment];
    setEquipment(p => p.filter(e => e.id !== id));
    notify("ลบอุปกรณ์ (กำลังบันทึกพื้นหลัง)");
    try {
      await SheetsDB.saveEquipmentStatus(id, "removed");
      notify("✓ ลบอุปกรณ์เสร็จสมบูรณ์");
    } catch (error) {
      setEquipment(prev);
      notify(`⚠ ลบไม่สำเร็จ: ${error.message}`, true);
    }
  };

  return (
    <div>
      <div style={{ marginBottom:28, display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
        <div>
          <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>จัดการอุปกรณ์</h2>
          <p style={{ margin:0, color:C.muted, fontSize:14 }}>เครื่องสแกนช่องปาก (IOS) และดองเกิลโปรแกรม</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {selectedIds.size > 0 && (
            <button style={{ ...btnStyle("danger") }} onClick={handleBulkDelete}>ลบที่เลือก ({selectedIds.size})</button>
          )}
          <button style={{ ...btnStyle("ghost") }} onClick={() => toggleSelectAll(equipment)}>
            {selectedIds.size === equipment.length && equipment.length > 0 ? "ยกเลิกการเลือก" : "เลือกทั้งหมด"}
          </button>
          <button style={btnStyle("primary")} onClick={() => setModal({ item: null })}>+ เพิ่มอุปกรณ์</button>
        </div>
      </div>

      {["ios", "dongle"].map(cat => (
        <div key={cat} style={{ marginBottom:26 }}>
          <h3 style={{ fontSize:14, fontWeight:600, color:C.muted, textTransform:"uppercase", marginBottom:12 }}>{EQUIP_CATEGORY_LABELS[cat]}</h3>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))", gap:12 }}>
            {equipment.filter(e => e.category === cat).map(item => (
              <div key={item.id} style={{ ...cardStyle, padding:"14px 16px", outline: selectedIds.has(item.id) ? `2px solid ${C.primary}` : "none" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} />
                    <span style={{ fontWeight:600, fontSize:14 }}>{item.name}</span>
                  </div>
                  <Badge t={item.status === "active" ? "active" : "maintenance"}>{item.status === "active" ? "ใช้งาน" : "ซ่อมบำรุง"}</Badge>
                </div>
                <p style={{ margin:0, fontSize:12, color:C.muted }}>{item.brand}{item.subtype ? ` · ${EQUIP_SUBTYPE_LABELS[item.subtype] || item.subtype}` : ""}</p>
                <p style={{ margin:"2px 0 10px", fontSize:11.5, color:C.faint }}>S/N {item.serialNumber || "—"}</p>
                <div style={{ display:"flex", gap:6 }}>
                  <button style={{ ...btnStyle("ghost"), padding:"5px 10px", fontSize:11.5 }} onClick={() => setModal({ item })}>แก้ไข</button>
                  <button style={{ ...btnStyle("amber"), padding:"5px 10px", fontSize:11.5 }} onClick={() => toggleStatus(item)}>{item.status === "active" ? "ปิดซ่อม" : "เปิดใช้"}</button>
                  <button style={{ ...btnStyle("danger"), padding:"5px 10px", fontSize:11.5 }} onClick={() => setConfirmDel(item)}>ลบ</button>
                </div>
              </div>
            ))}
            {equipment.filter(e => e.category === cat).length === 0 && (
              <p style={{ color:C.faint, fontSize:13 }}>ยังไม่มีอุปกรณ์ในหมวดนี้</p>
            )}
          </div>
        </div>
      ))}

      {modal && <EquipmentFormModal item={modal.item} onSave={save} onClose={() => setModal(null)} />}

      {confirmDel && (
        <Modal title="ยืนยันการลบ" onClose={() => setConfirmDel(null)}>
          <p style={{ margin:"0 0 20px", fontSize:14 }}>ต้องการลบ <strong>{confirmDel.name}</strong> ใช่หรือไม่?</p>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <button style={btnStyle("ghost")} onClick={() => setConfirmDel(null)}>ยกเลิก</button>
            <button style={btnStyle("danger")} onClick={() => { remove(confirmDel.id); setConfirmDel(null); }}>ยืนยันลบ</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ═══ ADMIN — EQUIPMENT RESERVATIONS ═════════════════════════════════════════════ */
function AdminEquipmentReservationsPage({ equipmentReservations, equipment, onCancel, onUpdateStatus }) {
  const [tab, setTab] = useState("upcoming");
  const filtered = equipmentReservations.filter(r => {
    if (tab === "upcoming")  return r.date >= todayStr && r.status !== "cancelled";
    if (tab === "past")      return r.date < todayStr;
    if (tab === "cancelled") return r.status === "cancelled";
    return true;
  });

  const groupedReservations = [];
  const sorted = [...filtered].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    if (a.equipmentId !== b.equipmentId) return a.equipmentId.localeCompare(b.equipmentId);
    return a.timeSlot.localeCompare(b.timeSlot);
  });

  sorted.forEach(r => {
    const last = groupedReservations[groupedReservations.length - 1];
    if (last && last.date === r.date && last.equipmentId === r.equipmentId && last.studentName === r.studentName && last.status === r.status && last.purpose === r.purpose) {
      const lastEndHour = last.timeSlot.split("-")[1];
      const currentStartHour = r.timeSlot.split("-")[0];
      if (lastEndHour === currentStartHour) {
         last.timeSlot = last.timeSlot.split("-")[0] + "-" + r.timeSlot.split("-")[1];
         last.ids.push(r.id);
         return;
      }
    }
    groupedReservations.push({ ...r, ids: [r.id] });
  });

  return (
    <div>
      <div style={{ marginBottom:28 }}>
        <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>การจองอุปกรณ์</h2>
        <p style={{ margin:0, color:C.muted, fontSize:14 }}>IOS และดองเกิลทั้งหมด · {equipmentReservations.length} รายการ</p>
      </div>
      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        {[["upcoming", "รอดำเนินการ"], ["past", "ผ่านมาแล้ว"], ["cancelled", "ยกเลิก"], ["all", "ทั้งหมด"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...btnStyle(tab === k ? "primary" : "ghost"), fontSize:13 }}>{l}</button>
        ))}
      </div>
      <div style={{ ...cardStyle, padding:0, overflow:"hidden" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
          <thead><tr style={{ background:C.soft, borderBottom:`1px solid ${C.line}` }}>
            {["วันที่", "ช่วงเวลา", "อุปกรณ์", "นิสิต", "วัตถุประสงค์", "HN/เคส", "สถานะ", ""].map(h => (
              <th key={h} style={{ textAlign:"left", padding:"10px 14px", color:C.muted, fontWeight:600, fontSize:11.5, textTransform:"uppercase" }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {groupedReservations.length === 0 ? (
              <tr><td colSpan={8} style={{ padding:"36px", textAlign:"center", color:C.muted }}>ไม่พบรายการจอง</td></tr>
            ) : groupedReservations.sort((a, b) => b.date.localeCompare(a.date)).map(r => {
              const eq = equipment.find(e => e.id === r.equipmentId);
              return (
                <tr key={r.ids.join(',')} style={{ borderBottom:`1px solid ${C.line}` }}>
                  <td style={{ padding:"9px 14px" }}>{displayDate(r.date)}</td>
                  <td style={{ padding:"9px 14px" }}>{r.timeSlot}</td>
                  <td style={{ padding:"9px 14px", fontWeight:600 }}>{eq?.name || r.equipmentId}</td>
                  <td style={{ padding:"9px 14px" }}>{r.studentName}</td>
                  <td style={{ padding:"9px 14px" }}>{r.purpose}</td>
                  <td style={{ padding:"9px 14px", color:C.muted }}>{r.caseHn || "—"}</td>
                  <td style={{ padding:"9px 14px" }}><Badge t={r.status}>{r.status === "cancelled" ? "ยกเลิก" : r.status === "returned" ? "รับคืนแล้ว" : "จอง/ใช้งาน"}</Badge></td>
                  <td style={{ padding:"9px 14px" }}>
                    <div style={{ display:"flex", gap:4 }}>
                      {r.status === "confirmed" && (
                        <button style={{ ...btnStyle("primary"), padding:"5px 10px", fontSize:12 }} onClick={() => onUpdateStatus(r.ids, "returned")}>รับคืน</button>
                      )}
                      {r.status !== "cancelled" && (
                        <button style={{ ...btnStyle("danger"), padding:"5px 10px", fontSize:12 }} onClick={() => onCancel(r.ids)}>ยกเลิก</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
/* ═══ DAY SUMMARY PANEL (student view-only) ═══════════════════════════════════════
   Shows a compact, always-visible table of all bookings for the selected date+session.
   No clicks required — replaces the "click unit to see info" pattern.               */
function DaySummaryPanel({ reservations, units, advisors, date, session, sessionAdvisors, currentUserId }) {
  const key    = `${date}__${session}`;
  const advIds = sessionAdvisors[key] || ["","",""];

  const booked = reservations.filter(r =>
    r.date === date && r.session === session && r.status !== "cancelled"
  ).sort((a,b) => a.unitId - b.unitId);

  const zoneLabel = ["A","B","C"];

  return (
    <div style={{ marginBottom:24 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
        <span style={{ fontSize:13, fontWeight:700, color:C.accent, textTransform:"uppercase", letterSpacing:0.8 }}>
          📋 สรุปการจองวันนี้
        </span>
        <div style={{ flex:1, height:1, background:C.line }} />
        <span style={{ fontSize:12, color:C.muted, background:C.soft, borderRadius:99, padding:"3px 10px", border:`1px solid ${C.line}` }}>
          {booked.length} / {units.filter(u=>u.status==="active"&&!u.overflow).length} ยูนิต
          {booked.filter(r=>{ const u=units.find(x=>x.id===r.unitId); return u?.overflow; }).length>0 &&
            <span style={{ color:C.amber, marginLeft:4 }}>
              +{booked.filter(r=>{ const u=units.find(x=>x.id===r.unitId); return u?.overflow; }).length} เสริม
            </span>
          }
        </span>
      </div>

      {booked.length === 0 ? (
        <div style={{ background:"#fff", border:`1px solid ${C.line}`, borderRadius:10, padding:"20px 16px", textAlign:"center", color:C.faint, fontSize:13 }}>
          ยังไม่มีการจองสำหรับช่วงเวลานี้
        </div>
      ) : (
        <div style={{ background:"#fff", border:`1px solid ${C.line}`, borderRadius:10, overflow:"hidden" }}>
          {/* Table header */}
          <div style={{ display:"grid", gridTemplateColumns:"90px 46px 1fr 1fr 1fr", gap:"0 10px", padding:"8px 14px", background:C.soft, borderBottom:`1px solid ${C.line}` }}>
            {["ยูนิต","โซน","นิสิต","ผู้ป่วย / HN","การรักษา"].map(h => (
              <span key={h} style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:0.4 }}>{h}</span>
            ))}
          </div>

          {/* Rows */}
          {booked.map((r, idx) => {
            const unit = units.find(u => u.id === r.unitId);
            const zIdx = unit?.zoneIdx ?? 0;
            const adv  = advisors.find(a => a.id === advIds[zIdx]);
            const isMe = r.studentId === currentUserId;
            return (
              <div key={r.id}
                style={{
                  display:"grid", gridTemplateColumns:"90px 46px 1fr 1fr 1fr",
                  gap:"0 10px", padding:"10px 14px",
                  background: isMe ? C.accentLight : idx%2===0 ? "#fff" : "#fafafa",
                  borderBottom: idx < booked.length-1 ? `1px solid ${C.line}` : "none",
                  alignItems:"center",
                }}>
                {/* Unit */}
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
  {isMe && <span style={{ fontSize:10, background:C.accent, color:"#fff", borderRadius:4, padding:"1px 5px", fontWeight:600, flexShrink:0 }}>ฉัน</span>}
  <span style={{ fontWeight:600, fontSize:13 }}>{unit?.name ?? `Unit ${r.unitId}`}</span>
  {r.isGhost && <span title="Ghost Booking">👻</span>}
  {r.inheritUnit && <span title="Inherit Unit">🔗</span>}
  {r.overbooked && !r.inheritUnit && <span style={{ fontSize:11, color:C.amber }}>⚠</span>}
</div>
                {/* Zone */}
                <span style={{ fontSize:12, color:C.muted, fontWeight:500 }}>
                  {zoneLabel[zIdx]}{adv ? <span title={adv.name} style={{ marginLeft:2, cursor:"default" }}>*</span> : ""}
                </span>
                {/* Student name */}
                <span style={{ fontSize:13, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.studentName}</span>
                {/* Patient / HN */}
                <div style={{ overflow:"hidden" }}>
                  <div style={{ fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.patientName}</div>
                  <div style={{ fontSize:11, color:C.muted }}>{r.hn}</div>
                </div>
                {/* Treatment */}
                <span style={{ fontSize:12.5, color:C.ink, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={r.treatment}>{r.treatment}</span>
              </div>
            );
          })}

          {/* Zone advisor legend */}
          <div style={{ padding:"8px 14px", background:C.soft, borderTop:`1px solid ${C.line}`, display:"flex", gap:16, flexWrap:"wrap" }}>
            {[0,1,2].map(z => {
              const adv = advisors.find(a => a.id === advIds[z]);
              return adv ? (
                <span key={z} style={{ fontSize:11.5, color:C.muted }}>
                  <strong style={{ color:C.ink }}>Zone {zoneLabel[z]}*</strong> {adv.name}
                </span>
              ) : null;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══ BROWSE PAGE ════════════════════════════════════════════════════════════════ */
function BrowsePage({ reservations, user, units, advisors, sessionAdvisors, onBook }) {
  const [date, setDate]     = useState(next14Days[0]);
  const [session, setSess]  = useState("morning");
  const [target, setTarget] = useState(null);
  const [viewUnit, setViewUnit] = useState(null);

  const canBook   = user.role === "student" || user.role === "advisor";
  const isStudent = user.role === "student";
  const isOverview = user.role === "overview";
  const sessions  = getAvailableSessions(date);
  useEffect(()=>{ if (!sessions.includes(session)) setSess(sessions[0]||"morning"); },[date]);

  const bookings    = (uid) => reservations.filter(r=>r.date===date&&r.session===session&&r.unitId===uid&&r.status!=="cancelled");
  const activeUnits = units.filter(u=>u.status==="active"&&!u.overflow);
  const totalBooked = activeUnits.filter(u=>bookings(u.id).length>0).length;

  /* For each zone, compute how many overflow units to show.
     Rule: show overflow unit N once all N-1 overflow units before it are booked
     AND all regular units in the zone are booked.
     i.e. overflow slot 1 appears when regular 8/8 full,
          overflow slot 2 appears when OV1 is booked, etc.           */
  const visibleUnitsForZone = (z) => {
    const regular  = units.filter(u=>u.zoneIdx===z&&!u.overflow);
    const overflow = units.filter(u=>u.zoneIdx===z&&u.overflow).sort((a,b)=>a.id-b.id);
    const regularBookedCount = regular.filter(u=>u.status==="active"&&bookings(u.id).length>0).length;
    const regularActiveCount = regular.filter(u=>u.status==="active").length;
    const allRegularFull = regularBookedCount >= regularActiveCount;
    if (!allRegularFull) return regular; // no overflow shown yet
    // Show overflow units progressively: show next one when previous is booked
    let visibleOverflow = [];
    for (let i=0; i<overflow.length; i++) {
      visibleOverflow.push(overflow[i]);
      // Stop after revealing one empty overflow slot
      if (bookings(overflow[i].id).length === 0) break;
    }
    return [...regular, ...visibleOverflow];
  };
  const key         = `${date}__${session}`;
  const advIds      = sessionAdvisors[key]||["","",""];
  const closed = isStudent && isBookingClosed(date, session);

  const handleUnitClick = (unit) => {
    if (unit.status === "maintenance") return;
    if (isOverview) {
      setViewUnit(unit);
      return;
    }
    if (canBook) {
      if (isStudent && closed) return;
      setTarget(unit);
    } else {
      setViewUnit(unit);
    }
  };

  const viewBks = viewUnit ? bookings(viewUnit.id) : [];

  return (
    <div>
      <div style={{ marginBottom:28 }}>
        <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>
          {canBook ? "จองยูนิต" : "ภาพรวมยูนิต"}
        </h2>
        <p style={{ margin:0, color:C.muted, fontSize:14 }}>
          {canBook
            ? "24 ยูนิต · 3 โซนอาจารย์นิเทศ (8 ยูนิต/โซน) · คลิกยูนิตเพื่อจอง · ยูนิตเสริมจะปรากฏเมื่อโซนเต็ม"
            : "24 ยูนิต · 3 โซนอาจารย์นิเทศ (8 ยูนิต/โซน) · คลิกยูนิตเพื่อดูรายละเอียด (อ่านอย่างเดียว)"}
        </p>
      </div>

      {isStudent && closed && (
        <div style={{ background:C.redBg, border:`1px solid #fca5a5`, borderRadius:8, padding:"12px 18px", marginBottom:16, fontSize:13.5, color:C.red, display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:18 }}>🔒</span>
          <div>
            <strong>หมดเวลาจอง{session==="morning"?"ช่วงเช้า":"ช่วงบ่าย"}</strong>
            <span style={{ marginLeft:8, fontWeight:400 }}>
              {session==="morning"
                ? "ปิดรับการจองช่วงเช้าเมื่อ 08:00 น."
                : "ปิดรับการจองช่วงบ่ายเมื่อ 11:00 น."}
            </span>
          </div>
        </div>
      )}

      <div style={{ ...cardStyle, marginBottom:16, padding:"14px 18px" }}>
        <div style={{ display:"flex", gap:8, overflowX:"auto", paddingBottom:2 }}>
          {next14Days.map(d=>(
            <button key={d} onClick={()=>setDate(d)} style={{ flexShrink:0, padding:"8px 12px", borderRadius:8, border:date===d?`1.5px solid ${C.ink}`:`1px solid ${C.line}`, background:date===d?C.ink:"#fff", color:date===d?"#fff":C.ink, cursor:"pointer", fontFamily:"'Sarabun','Outfit',sans-serif", fontSize:12.5, fontWeight:500, minWidth:74, textAlign:"center" }}>
              {shortDay(d)}
              {isWednesday(d)&&<div style={{ fontSize:9.5, opacity:0.6, marginTop:1 }}>เช้าเท่านั้น</div>}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display:"flex", gap:10, marginBottom:18, alignItems:"center", flexWrap:"wrap" }}>
        {["morning","afternoon"].map(s=>{
          const avail = sessions.includes(s);
          const isClosed = isStudent && isBookingClosed(date, s);
          return (
            <button key={s} disabled={!avail} onClick={()=>setSess(s)}
              style={{ padding:"8px 18px", borderRadius:8, border:session===s&&avail?`1.5px solid ${C.ink}`:`1px solid ${C.line}`, background:session===s&&avail?C.ink:"#fff", color:session===s&&avail?"#fff":!avail?C.faint:C.ink, cursor:avail?"pointer":"not-allowed", fontFamily:"'Sarabun','Outfit',sans-serif", fontSize:13.5, fontWeight:500 }}>
              {s==="morning"?"☀ ช่วงเช้า  09:00–12:00":"🌤 ช่วงบ่าย  13:00–16:00"}
              {!avail&&s==="afternoon"&&<span style={{ fontSize:11, marginLeft:6 }}>(พุธ: เฉพาะเช้า)</span>}
              {avail&&isClosed&&<span style={{ fontSize:11, marginLeft:6 }}>🔒 ปิดแล้ว</span>}
            </button>
          );
        })}
        <div style={{ marginLeft:"auto", display:"flex", gap:10 }}>
          {(() => {
            const allVisible = [0,1,2].flatMap(z=>visibleUnitsForZone(z)).filter(u=>u.status==="active");
            const bookedCount = allVisible.filter(u=>bookings(u.id).length>0).length;
            return <>
              <span style={{ fontSize:13, color:C.green, background:C.greenBg, borderRadius:8, padding:"6px 12px" }}>● {allVisible.length-bookedCount} ว่าง</span>
              <span style={{ fontSize:13, color:C.amber, background:C.amberBg, borderRadius:8, padding:"6px 12px" }}>● {bookedCount} จองแล้ว</span>
            </>;
          })()}
        </div>
      </div>

      {sessions.includes(session) ? [0,1,2].map(z=>{
        const zUnits = visibleUnitsForZone(z);
        const adv    = advisors.find(a=>a.id===advIds[z]);
        const regularCount  = units.filter(u=>u.zoneIdx===z&&!u.overflow&&u.status==="active").length;
        const overflowShown = zUnits.filter(u=>u.overflow).length;
        return (
          <div key={z} style={{ marginBottom:24 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
              <span style={{ fontSize:13, fontWeight:600, color:C.muted, textTransform:"uppercase", letterSpacing:0.5, whiteSpace:"nowrap" }}>
                Zone {["A","B","C"][z]} — {adv?adv.name:"ยังไม่ได้กำหนดอาจารย์"}
              </span>
              {overflowShown>0&&(
                <span style={{ fontSize:11, background:C.amberBg, color:C.amber, borderRadius:99, padding:"2px 9px", fontWeight:600, flexShrink:0 }}>
                  +{overflowShown} ยูนิตเสริม
                </span>
              )}
              <div style={{ flex:1, height:1, background:C.line }} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(155px,1fr))", gap:9 }}>
              {zUnits.map(unit=>{
                const bks      = bookings(unit.id);
                const isBooked = bks.length>0;
                const isOver   = bks.length>1;
                const isMaint  = unit.status==="maintenance";
                const isOv     = !!unit.overflow;
                const isMine   = bks.some(b=>b.studentId===user.id);
                const blockClick = isMaint || (isStudent && closed);
                const borderColor = isMaint?C.line:isOver?C.amberLine:isMine?C.greenLine:isOv&&!isBooked?"#fcd34d":isBooked?"#fed7aa":C.line;
                return (
                  <div key={unit.id}
                    onClick={()=>handleUnitClick(unit)}
                    style={{ background: isOv?"#fffbeb":"#fff", border:`1px solid ${borderColor}`, borderRadius:10, padding:"13px 15px", cursor:blockClick?"not-allowed":"pointer", opacity:isMaint?0.5:1, transition:"box-shadow .15s" }}
                    onMouseEnter={e=>{if(!blockClick)e.currentTarget.style.boxShadow="0 4px 14px rgba(0,0,0,0.08)";}}
                    onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
                      <div style={{ display:"flex", flexDirection:"column", gap:1 }}>
                        <span style={{ fontWeight:600, fontSize:14.5 }}>{unit.name}</span>
                        {isOv&&<span style={{ fontSize:9.5, color:C.amber, fontWeight:600, textTransform:"uppercase", letterSpacing:0.3 }}>ยูนิตเสริม</span>}
                      </div>
                      {isMaint&&<Badge t="maintenance">ซ่อมบำรุง</Badge>}
                      {!isMaint&&isMine&&<Badge t="confirmed">ของฉัน</Badge>}
                      {!isMaint&&!isMine&&isOver&&<Badge t="overbooked">Over</Badge>}
                      {!isMaint&&!isMine&&!isOver&&isBooked&&<span style={{ width:8, height:8, borderRadius:"50%", background:"#f97316", display:"block", marginTop:5, flexShrink:0 }} />}
                      {!isMaint&&!isBooked&&<span style={{ width:8, height:8, borderRadius:"50%", background: isOv?"#f59e0b":"#10b981", display:"block", marginTop:5, flexShrink:0 }} />}
                    </div>
                    {isBooked
                      ? <p style={{ margin:0, fontSize:11.5, color:C.muted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {bks[0].inheritUnit && <span style={{ marginRight:3 }}>🔗</span>}
                          {bks[0].patientName}
                        </p>
                      : <p style={{ margin:0, fontSize:11.5, color: isOv?C.amber:C.faint }}>{isOv?"พร้อมรับการจอง":"ว่าง"}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      }) : (
        <div style={{ ...cardStyle, textAlign:"center", padding:"52px", color:C.muted }}>
          <div style={{ fontSize:38, marginBottom:10 }}>🚫</div>
          <p style={{ margin:0 }}>วันพุธไม่มีช่วงบ่าย</p>
        </div>
      )}

      {isOverview && sessions.includes(session) && (
        <DaySummaryPanel
          reservations={reservations}
          units={units}
          advisors={advisors}
          date={date}
          session={session}
          sessionAdvisors={sessionAdvisors}
          currentUserId={user.id}
        />
      )}

      {target&&canBook&&(
        <BookingModal unit={target} date={date} session={session} reservations={reservations}
          sessionAdvisors={sessionAdvisors} advisors={advisors} user={user}
          onClose={()=>setTarget(null)}
          onConfirm={(data)=>{ onBook({unit:target,date,session,...data}); setTarget(null); }} />
      )}

      {viewUnit&&(
        <Modal title={`${viewUnit.name} — รายละเอียด`} onClose={()=>setViewUnit(null)}>
          <div style={{ background:C.soft, borderRadius:8, padding:"12px 16px", marginBottom:16, display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px 16px" }}>
            {[["ยูนิต",viewUnit.name],["โซน",viewUnit.room],
              ["อาจารย์นิเทศ",advisors.find(a=>a.id===advIds[viewUnit.zoneIdx])?.name||"ยังไม่ระบุ"],
              ["วันที่",displayDate(date)],
              ["ช่วงเวลา",session==="morning"?"เช้า 09:00–12:00":"บ่าย 13:00–16:00"],
              ["สถานะ",viewUnit.status==="maintenance"?"ซ่อมบำรุง":viewBks.length===0?"ว่าง":viewBks.length>1?"Overbooked":"จองแล้ว"]
            ].map(([k,v])=>(
              <div key={k}><span style={{ ...lblStyle, marginBottom:2 }}>{k}</span><span style={{ fontSize:13.5, fontWeight:500 }}>{v}</span></div>
            ))}
          </div>
          {viewBks.length===0 ? (
            <p style={{ color:C.muted, fontSize:13, textAlign:"center", padding:"12px 0" }}>ยังไม่มีการจองในช่วงนี้</p>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {viewBks.map((b,i)=>(
                <div key={b.id} style={{ background:b.overbooked?C.amberBg:C.soft, border:`1px solid ${b.overbooked?C.amberLine:C.line}`, borderRadius:8, padding:"10px 14px" }}>
                  {viewBks.length>1&&<p style={{ margin:"0 0 6px", fontSize:11, fontWeight:600, color:C.muted, textTransform:"uppercase" }}>การจองที่ {i+1}</p>}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"4px 14px" }}>
                    {[["นิสิต",b.studentName],["ผู้ป่วย",b.patientName],["HN",b.hn],["การรักษา",b.treatment]].map(([k,v])=>(
                      <div key={k}><span style={{ fontSize:11, color:C.muted, fontWeight:600 }}>{k}</span><p style={{ margin:"1px 0 0", fontSize:13 }}>{v}</p></div>
                    ))}
                  </div>
                  {b.overbooked&&<p style={{ margin:"8px 0 0", fontSize:12, color:C.amber }}>⚠ Overbooked</p>}
                </div>
              ))}
            </div>
          )}
          <div style={{ display:"flex", justifyContent:"flex-end", marginTop:20 }}>
            <button style={btnStyle("ghost")} onClick={()=>setViewUnit(null)}>ปิด</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ═══ MY RESERVATIONS ════════════════════════════════════════════════════════════ */
function MyReservationsPage({ reservations, user, units, sessionAdvisors, advisors, onCancel, onEdit }) {
  const [tab, setTab]           = useState("upcoming");
  const [detail, setDetail]     = useState(null);
  const [editing, setEditing]   = useState(null);   // reservation object being edited
  const [cancelTarget, setCancelTarget] = useState(null); // id to confirm cancel

  const mine = reservations.filter(r=>r.studentId===user.id&&new Date(r.date+"T12:00:00")>=threeMonthsAgo).sort((a,b)=>a.date>b.date?-1:1);
  const filtered = mine.filter(r=>{
    if (tab==="upcoming") return r.date>=todayStr&&r.status!=="cancelled";
    if (tab==="past")     return r.date<todayStr;
    if (tab==="cancelled") return r.status==="cancelled";
    return true;
  });

  return (
    <div>
      <div style={{ marginBottom:28 }}>
        <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>การจองของฉัน</h2>
        <p style={{ margin:0, color:C.muted, fontSize:14 }}>ประวัติ 3 เดือนย้อนหลัง · {mine.length} รายการ</p>
      </div>
      <div style={{ display:"flex", gap:8, marginBottom:20 }}>
        {[["upcoming","รอดำเนินการ"],["past","ผ่านมาแล้ว"],["cancelled","ยกเลิก"],["all","ทั้งหมด"]].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)} style={{ ...btnStyle(tab===k?"primary":"ghost"), fontSize:13 }}>{l}</button>
        ))}
      </div>
      {filtered.length===0?(
        <div style={{ ...cardStyle, textAlign:"center", padding:"52px", color:C.muted }}>
          <div style={{ fontSize:36, marginBottom:10 }}>📋</div><p style={{ margin:0 }}>ไม่พบรายการจอง</p>
        </div>
      ):(
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {filtered.map(r=>{
            const unit = units.find(u=>u.id===r.unitId);
            const k    = `${r.date}__${r.session}`;
            const ids  = sessionAdvisors[k]||["","",""];
            const adv  = advisors.find(a=>a.id===ids[unit?.zoneIdx??0]);
            const canAct = r.date>=todayStr&&r.status!=="cancelled"&&!isBookingClosed(r.date,r.session);
            return (
              <div key={r.id} style={{ ...cardStyle, display:"flex", alignItems:"center", gap:16, cursor:"pointer", padding:"16px 20px" }} onClick={()=>setDetail({r,unit,adv})}>
                <div style={{ width:44, height:44, borderRadius:10, background:r.isGhost?"#fdf4ff":C.soft, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{r.isGhost?"👻":"🦷"}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center", marginBottom:3 }}>
                    <span style={{ fontWeight:600, fontSize:14.5 }}>{unit?.name}</span>
                    <Badge t={r.session}>{r.session==="morning"?"ช่วงเช้า":"ช่วงบ่าย"}</Badge>
                    <Badge t={r.overbooked?"overbooked":r.status}>{r.overbooked?"⚠ Overbook":r.status==="confirmed"?"ยืนยันแล้ว":r.status==="cancelled"?"ยกเลิก":"รอดำเนินการ"}</Badge>
                    {r.isGhost&&<span style={{ background:"#fdf4ff", color:"#7c3aed", borderRadius:99, padding:"2px 9px", fontSize:11, fontWeight:600 }}>👻 ผี</span>}
                  </div>
                  <p style={{ margin:0, fontSize:13, color:C.muted }}>{displayDate(r.date)} · {r.patientName} · {r.hn}</p>
                  <p style={{ margin:"2px 0 0", fontSize:12.5, color:C.faint, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.treatment}</p>
                </div>
                {canAct&&(
                  <div style={{ display:"flex", gap:8, flexShrink:0 }} onClick={e=>e.stopPropagation()}>
                    <button style={{ ...btnStyle("ghost"), padding:"6px 12px", fontSize:12 }} onClick={()=>setEditing(r)}>✏ แก้ไข</button>
                    <button style={btnStyle("danger")} onClick={()=>setCancelTarget(r.id)}>ยกเลิก</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Detail modal */}
      {detail&&(
        <Modal title="รายละเอียดการจอง" onClose={()=>setDetail(null)}>
          <div style={{ display:"grid", gap:10 }}>
            {[["รหัสการจอง",detail.r.id],["ยูนิต",detail.unit?.name],["โซน",detail.unit?.room],
              ["อาจารย์นิเทศ",detail.adv?.name||"ยังไม่ระบุ"],["วันที่",displayDate(detail.r.date)],
              ["ช่วงเวลา",detail.r.session==="morning"?"เช้า 09:00–12:00":"บ่าย 13:00–16:00"],
              ["ผู้ป่วย",detail.r.patientName],["HN",detail.r.hn],["การรักษา",detail.r.treatment],
              ["สถานะ",detail.r.status==="confirmed"?"ยืนยันแล้ว":detail.r.status==="cancelled"?"ยกเลิก":"รอดำเนินการ"],
              ["Overbooked",detail.r.overbooked?"⚠ ใช่ — แจ้งผู้ดูแลแล้ว":"ไม่มี"],
              ["ผี",detail.r.isGhost?"👻 ใช่":"ไม่ใช่"],
            ].map(([k,v])=>(
              <div key={k} style={{ display:"flex", paddingBottom:10, borderBottom:`1px solid ${C.line}` }}>
                <span style={{ width:160, flexShrink:0, fontSize:12.5, color:C.muted, fontWeight:600, textTransform:"uppercase", letterSpacing:0.3 }}>{k}</span>
                <span style={{ fontSize:13.5 }}>{v}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* Edit modal */}
      {editing&&(
        <EditBookingModal
          reservation={editing}
          onSave={(fields)=>{ onEdit(editing.id, fields); setEditing(null); }}
          onClose={()=>setEditing(null)} />
      )}

      {/* Cancel confirmation modal */}
      {cancelTarget&&(
        <Modal title="ยืนยันการยกเลิก" onClose={()=>setCancelTarget(null)}>
          <p style={{ margin:"0 0 20px", fontSize:14 }}>
            คุณต้องการยกเลิกการจองนี้ใช่หรือไม่?<br/>
            <span style={{ fontSize:13, color:C.muted }}>การดำเนินการนี้ไม่สามารถย้อนกลับได้</span>
          </p>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <button style={btnStyle("ghost")} onClick={()=>setCancelTarget(null)}>ไม่ใช่</button>
            <button style={btnStyle("danger")} onClick={()=>{ onCancel(cancelTarget); setCancelTarget(null); }}>ยืนยันยกเลิก</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ═══ EDIT BOOKING MODAL ═════════════════════════════════════════════════════════ */
function EditBookingModal({ reservation, onSave, onClose }) {
  const [patientName, setPatientName] = useState(reservation.patientName);
  const [hn, setHn]                   = useState(reservation.hn);
  const [treatment, setTreatment]     = useState(reservation.treatment);
  const [err, setErr]                 = useState("");

  const save = () => {
    if (!patientName.trim()) return setErr("กรุณากรอกชื่อผู้ป่วย");
    if (!hn.trim())          return setErr("กรุณากรอก HN");
    if (!treatment.trim())   return setErr("กรุณากรอกข้อมูลการรักษา");
    onSave({ patientName, hn, treatment });
  };

  return (
    <Modal title="แก้ไขข้อมูลการจอง" onClose={onClose}>
      <div style={{ background:C.soft, borderRadius:8, padding:"10px 14px", marginBottom:16, fontSize:13, color:C.muted }}>
        แก้ไขได้เฉพาะข้อมูลผู้ป่วยและการรักษา · ยูนิต/วันที่/ช่วงเวลาไม่สามารถเปลี่ยนได้
      </div>
      <div style={{ display:"grid", gap:14 }}>
        <div>
          <label style={lblStyle}>ชื่อ-นามสกุลผู้ป่วย *</label>
          <input style={inpStyle} value={patientName} onChange={e=>setPatientName(e.target.value)} />
        </div>
        <div>
          <label style={lblStyle}>HN *</label>
          <input style={inpStyle} value={hn} onChange={e=>setHn(e.target.value)} />
        </div>
        <div>
          <label style={lblStyle}>การรักษา / หัตถการ *</label>
          <input style={inpStyle} value={treatment} onChange={e=>setTreatment(e.target.value)} />
        </div>
      </div>
      {err&&<p style={{ margin:"12px 0 0", color:C.red, fontSize:13 }}>{err}</p>}
      <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:22 }}>
        <button style={btnStyle("ghost")} onClick={onClose}>ยกเลิก</button>
        <button style={btnStyle("primary")} onClick={save}>บันทึกการแก้ไข</button>
      </div>
    </Modal>
  );
}

/* ═══ PRINT SESSION SUMMARY ══════════════════════════════════════════════════════
   Layout: each zone gets its own full-width row (stacked vertically).
   Dynamic font scaling shrinks the base font-size until all content fits
   within a single landscape A4 page (297 × 210 mm usable area ≈ 277 × 194 mm
   after margins).

   iOS-compatible: window.print() is called synchronously inside the click
   handler. The afterprint event cleans up injected nodes afterwards.
   ════════════════════════════════════════════════════════════════════════════════ */
function printSessionSummary({ dateStr, session, reservations, units, advisors, sessionAdvisors }) {
  const key    = `${dateStr}__${session}`;
  const advIds = sessionAdvisors[key] || ["","",""];
  const rows   = reservations
    .filter(r => r.date === dateStr && r.session === session && r.status !== "cancelled")
    .sort((a,b) => a.unitId - b.unitId);

  const sessionLabel = session === "morning" ? "ช่วงเช้า 09:00–12:00" : "ช่วงบ่าย 13:00–16:00";
  const printDate    = displayDate(dateStr);

  // Build one full-width zone block per zone
  const zoneSections = [0, 1, 2].map(zIdx => {
    const zoneName     = ["A","B","C"][zIdx];
    const adv          = advisors.find(a => a.id === advIds[zIdx]);
    const advName      = adv?.name || "ยังไม่ระบุอาจารย์นิเทศ";
    const zoneRows     = rows.filter(r => {
      const u = units.find(u => u.id === r.unitId);
      return (u?.zoneIdx ?? -1) === zIdx;
    }).sort((a, b) => a.unitId - b.unitId);
    const allZoneUnits = units.filter(u => u.zoneIdx === zIdx).sort((a,b) => a.id - b.id);

    const unitRows = allZoneUnits.map(unit => {
      const bks     = zoneRows.filter(r => r.unitId === unit.id);
      const isMaint = unit.status === "maintenance";
      if (isMaint || bks.length === 0) return "";
      return bks.map((b, i) => {
        const isOver      = bks.length > 1;
        const inheritMark = b.inheritUnit ? `<span class="p-inh">🔗</span>` : "—";
        const ghostMark    = b.isGhost ? `<span class="p-ghost">👻</span>` : "—";
        const uCell = i === 0
          ? `<td class="p-u${isOver?" p-ov":""}" rowspan="${bks.length}">${unit.name}${isOver?`<br><span class="p-ovl">⚠ OVER×${bks.length}</span>`:""}</td>`
          : "";
        const isLastRow = i === bks.length - 1;
        return `<tr class="${isOver?"p-over":""}${b.isGhost?" p-ghost-row":""}${isLastRow?" p-unit-end":""}">${uCell}<td class="p-d">${b.studentName}</td><td class="p-d">${b.patientName}</td><td class="p-d">${b.hn}</td><td class="p-d p-treatment">${b.treatment}</td><td class="p-c">${isOver?"⚠":"✓"}</td><td class="p-c">${ghostMark}</td><td class="p-c">${inheritMark}</td></tr>`;
      }).join("");
    }).join("");

    const booked = zoneRows.length;
    const avail  = allZoneUnits.filter(u => u.status === "active").length - booked;
    const overCt = zoneRows.filter(r => r.overbooked).length;

    return `<div class="p-zone">
      <div class="p-zh">
        <span class="p-adv">Zone ${zoneName} — ${advName}</span>
        <span class="p-ztag">ยูนิต ${zIdx*8+1}–${zIdx*8+8}</span>
        <span class="p-pill p-pb">${booked} จอง</span>
        <span class="p-pill p-pa">${avail} ว่าง</span>
        ${overCt > 0 ? `<span class="p-pill p-po">${overCt} Over</span>` : ""}
      </div>
      ${unitRows
        ? `<table class="p-tbl"><thead><tr>
            <th class="p-th" style="width:64px">ยูนิต</th>
            <th class="p-th" style="width:16%">นิสิต</th>
            <th class="p-th" style="width:16%">ผู้ป่วย</th>
            <th class="p-th" style="width:10%">HN</th>
            <th class="p-th">การรักษา / หัตถการ</th>
            <th class="p-th" style="width:44px;text-align:center">สถานะ</th>
            <th class="p-th" style="width:44px;text-align:center">ผี</th>
            <th class="p-th" style="width:52px;text-align:center">ต่อยูนิต</th>
           </tr></thead><tbody>${unitRows}</tbody></table>`
        : `<p class="p-empty">ไม่มีการจองในโซนนี้</p>`}
    </div>`;
  }).join("");

  const bodyHTML = `
    <div class="p-hdr">
      <div>
        <h1 class="p-h1">🦷 CUProstho — สรุปการจองยูนิต</h1>
        <p class="p-sub">${printDate} · ${sessionLabel}</p>
      </div>
      <div class="p-stats">
        <div class="p-sbox"><strong>${rows.length}</strong><span>จองทั้งหมด</span></div>
        <div class="p-sbox"><strong>${rows.filter(r=>r.overbooked).length}</strong><span>Overbooked</span></div>
        <div class="p-sbox"><strong>${24 - rows.length}</strong><span>ว่าง</span></div>
      </div>
    </div>
    <div class="p-zones">${zoneSections}</div>
    <div class="p-foot">
      <span>พิมพ์เมื่อ: ${new Date().toLocaleString("th-TH")}</span>
      <span>CUProstho · คณะทันตแพทยศาสตร์</span>
    </div>`;

  // ── Inject print stylesheet + root ───────────────────────────────────────
  const STYLE_ID = "__print_style__";
  const ROOT_ID  = "__print_root__";

  document.getElementById(STYLE_ID)?.remove();
  document.getElementById(ROOT_ID)?.remove();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @media print {
      @page { size: A4 landscape; margin: 8mm 10mm; }
      body > *:not(#${ROOT_ID}) { display: none !important; }
      #${ROOT_ID} { display: block !important; }
    }
    #${ROOT_ID} {
      display: none;
      font-family: 'Sarabun', Arial, sans-serif;
      /* font-size set dynamically by fitToPage() below */
      font-size: 8pt;
      color: #16191f;
      box-sizing: border-box;
      width: 277mm; /* landscape A4 printable width (297mm - 2×10mm) */
    }
    #${ROOT_ID} * { box-sizing: border-box; }

    /* ── Header ── */
    #${ROOT_ID} .p-hdr { display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #16191f; padding-bottom:0.3em; margin-bottom:0.5em; }
    #${ROOT_ID} .p-h1  { font-size:1.35em; font-weight:700; margin:0 0 0.1em; }
    #${ROOT_ID} .p-sub { font-size:0.9em; color:#6b7280; margin:0; }
    #${ROOT_ID} .p-stats { display:flex; gap:0.5em; }
    #${ROOT_ID} .p-sbox { background:#f4f5f7; border-radius:4px; padding:0.2em 0.8em; text-align:center; min-width:52px; }
    #${ROOT_ID} .p-sbox strong { display:block; font-size:1.3em; line-height:1.1; font-weight:700; }
    #${ROOT_ID} .p-sbox span   { font-size:0.78em; color:#6b7280; }

    /* ── Zones: stacked full-width rows ── */
    #${ROOT_ID} .p-zones { display:flex; flex-direction:column; gap:0.55em; }
    #${ROOT_ID} .p-zone  { break-inside:avoid; width:100%; }

    /* Zone header bar */
    #${ROOT_ID} .p-zh   { background:#16191f; color:#fff; padding:0.3em 0.7em; border-radius:4px 4px 0 0; display:flex; align-items:center; gap:0.6em; }
    #${ROOT_ID} .p-adv  { font-size:1em; font-weight:700; flex:1; }
    #${ROOT_ID} .p-ztag { font-size:0.78em; opacity:0.6; white-space:nowrap; }
    #${ROOT_ID} .p-pill { border-radius:99px; padding:0.1em 0.55em; font-size:0.78em; font-weight:600; white-space:nowrap; }
    #${ROOT_ID} .p-pb   { background:#344e78; color:#fff; }
    #${ROOT_ID} .p-pa   { background:#d1fae5; color:#065f46; }
    #${ROOT_ID} .p-po   { background:#fef3c7; color:#92400e; }

    /* Zone table — full width */
    #${ROOT_ID} .p-tbl  { width:100%; border-collapse:collapse; border:1px solid #e5e7eb; border-top:none; }
    #${ROOT_ID} .p-tbl thead tr { background:#f9fafb; }
    #${ROOT_ID} .p-th   { padding:0.22em 0.55em; text-align:left; font-weight:600; font-size:0.8em; text-transform:uppercase; letter-spacing:0.2px; border-bottom:1px solid #e5e7eb; color:#6b7280; white-space:nowrap; }
    #${ROOT_ID} .p-d    { padding:0.22em 0.55em; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
    #${ROOT_ID} .p-treatment { max-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #${ROOT_ID} .p-u    { padding:0.22em 0.55em; font-weight:600; border-bottom:1px solid #f0f0f0; vertical-align:middle; white-space:nowrap; }
    #${ROOT_ID} .p-c    { padding:0.22em 0.55em; text-align:center; border-bottom:1px solid #f0f0f0; vertical-align:middle; }
    #${ROOT_ID} .p-over { background:#fef3c7; }
    #${ROOT_ID} .p-ov   { border-top:2px solid #fcd34d; }
    #${ROOT_ID} tr.p-unit-end td { border-bottom:2px solid #16191f; }
    #${ROOT_ID} .p-ovl  { font-size:0.75em; color:#92400e; font-weight:700; }
    #${ROOT_ID} .p-inh  { color:#d97706; font-weight:600; }
    #${ROOT_ID} .p-ghost     { color:#7c3aed; font-weight:600; }
    #${ROOT_ID} tr.p-ghost-row { background:#fdf4ff; }
    #${ROOT_ID} .p-empty{ margin:0; padding:0.4em 0.7em; font-size:0.85em; color:#9ca3af; border:1px solid #e5e7eb; border-top:none; }

    /* Footer */
    #${ROOT_ID} .p-foot { margin-top:0.4em; font-size:0.78em; color:#9ca3af; display:flex; justify-content:space-between; border-top:1px solid #e5e7eb; padding-top:0.25em; }
  `;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = bodyHTML;

  document.head.appendChild(style);
  document.body.appendChild(root);

  /* ── Dynamic font scaling ─────────────────────────────────────────────────
     A4 landscape printable height with 8mm top+bottom margins = 210 - 16 = 194 mm.
     We convert to px using 96 dpi (browser standard): 194mm × (96/25.4) ≈ 733px.
     We make the root visible (off-screen), measure its scrollHeight, then
     shrink the font-size by 0.5pt steps until it fits, down to a floor of 5pt. */
  root.style.display  = "block";
  root.style.position = "absolute";
  root.style.left     = "-9999px";
  root.style.top      = "0";

  const PAGE_H_PX = 194 * (96 / 25.4); // ≈ 733 px
  let   fontSize  = 8;                  // starting pt

  while (root.scrollHeight > PAGE_H_PX && fontSize > 5) {
    fontSize -= 0.5;
    root.style.fontSize = fontSize + "pt";
  }

  root.style.position = "";
  root.style.left     = "";
  root.style.top      = "";
  root.style.display  = "none";

  // Clean up after printing
  const cleanup = () => {
    style.remove();
    root.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);

  // Synchronous call — keeps the user-gesture chain intact on iOS Safari
  window.print();
}

/* ═══ ADMIN OVERVIEW ═════════════════════════════════════════════════════════════ */
function AdminOverview({ reservations, units, advisors, sessionAdvisors }) {
  const [selDate, setSelDate] = useState(todayStr);

  const isToday        = selDate === todayStr;
  const selSessions    = getAvailableSessions(selDate);
  const selRes         = reservations.filter(r=>r.date===selDate&&r.status!=="cancelled");
  const overbookedList = reservations.filter(r=>r.overbooked&&r.status!=="cancelled"&&r.date===selDate);
  const upcoming       = reservations.filter(r=>r.date>=todayStr&&r.status!=="cancelled").length;
  const morningRes     = selRes.filter(r=>r.session==="morning");
  const afternoonRes   = selRes.filter(r=>r.session==="afternoon");
  const totalSlots     = 24;
  const [printDate, setPrintDate] = useState(next14Days[0]);
  const [printSess, setPrintSess] = useState("morning");

  return (
    <div>
      {/* ── Header + date picker ── */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:24, flexWrap:"wrap", gap:12 }}>
        <div>
          <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>ภาพรวม</h2>
          <p style={{ margin:0, color:C.muted, fontSize:14 }}>
            {isToday ? `วันนี้ — ${displayDate(todayStr)}` : displayDate(selDate)}
          </p>
        </div>
        {/* Date strip */}
        <div style={{ display:"flex", gap:6, overflowX:"auto", maxWidth:"100%", paddingBottom:2 }}>
          {/* Today shortcut */}
          <button onClick={()=>setSelDate(todayStr)}
            style={{ flexShrink:0, padding:"7px 14px", borderRadius:8,
              border:isToday?`1.5px solid ${C.ink}`:`1px solid ${C.line}`,
              background:isToday?C.ink:"#fff", color:isToday?"#fff":C.ink,
              cursor:"pointer", fontFamily:"'Sarabun','Outfit',sans-serif", fontSize:12.5, fontWeight:600 }}>
            วันนี้
          </button>
          {next14Days.filter(d=>d!==todayStr).map(d=>(
            <button key={d} onClick={()=>setSelDate(d)}
              style={{ flexShrink:0, padding:"7px 11px", borderRadius:8,
                border:selDate===d?`1.5px solid ${C.ink}`:`1px solid ${C.line}`,
                background:selDate===d?C.ink:"#fff", color:selDate===d?"#fff":C.ink,
                cursor:"pointer", fontFamily:"'Sarabun','Outfit',sans-serif", fontSize:12, fontWeight:500, textAlign:"center" }}>
              {shortDay(d)}
              {isWednesday(d)&&<div style={{ fontSize:9, opacity:0.6, marginTop:1 }}>เช้าเท่านั้น</div>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Global stat chips ── */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(165px,1fr))", gap:12, marginBottom:26 }}>
        {[
          {l: isToday?"จองวันนี้ (รวม)":"จองวันที่เลือก", v:selRes.length,          s:`จาก ${totalSlots*(selSessions.length||1)} สล็อต`, c:C.accent, bg:C.accentLight},
          {l:"รอดำเนินการ (ทั้งหมด)",                      v:upcoming,               s:"upcoming ทั้งหมด",    c:C.green,  bg:C.greenBg},
          {l:"Overbook วันที่เลือก",                       v:overbookedList.length,  s:"ต้องดำเนินการ",       c:C.amber,  bg:C.amberBg},
          {l:"ผี วันที่เลือก",                              v:reservations.filter(r=>r.isGhost&&r.status!=="cancelled"&&r.date===selDate).length, s:"ไม่มีสิทธิ์ตามตาราง", c:"#7c3aed", bg:"#fdf4ff"},
        ].map(x=>(
          <div key={x.l} style={{ background:x.bg, borderRadius:12, padding:"18px 20px", border:`1px solid ${C.line}` }}>
            <p style={{ margin:0, fontSize:30, fontWeight:700, color:x.c, fontFamily:"'Cormorant Garamond',serif", lineHeight:1 }}>{x.v}</p>
            <p style={{ margin:"6px 0 2px", fontSize:13.5, fontWeight:600, color:x.c }}>{x.l}</p>
            <p style={{ margin:0, fontSize:12, color:x.c, opacity:0.7 }}>{x.s}</p>
          </div>
        ))}
      </div>

      {/* ── Per-session breakdown ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:22 }}>
        {[
          { sess:"morning",   label:"☀ ช่วงเช้า 09:00–12:00",   res:morningRes,   bg:"#eff6ff", color:"#1d4ed8" },
          { sess:"afternoon", label:"🌤 ช่วงบ่าย 13:00–16:00",   res:afternoonRes, bg:"#faf5ff", color:"#6b21a8" },
        ].map(({ sess, label, res, bg, color }) => {
          const hasSession = selSessions.includes(sess);
          const key = `${selDate}__${sess}`;
          const advIds = sessionAdvisors[key] || ["","",""];
          return (
            <div key={sess} style={{ ...cardStyle, opacity: hasSession ? 1 : 0.45 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
                <div>
                  <span style={{ background:bg, color, borderRadius:99, padding:"3px 12px", fontSize:12, fontWeight:600 }}>{label}</span>
                  {!hasSession && <span style={{ marginLeft:8, fontSize:12, color:C.muted }}>(ไม่มีในวันนี้)</span>}
                </div>
                <div style={{ textAlign:"right" }}>
                  <span style={{ fontSize:26, fontWeight:700, fontFamily:"'Cormorant Garamond',serif", color }}>{res.length}</span>
                  <span style={{ fontSize:12, color:C.muted, marginLeft:4 }}>/ {totalSlots}</span>
                </div>
              </div>
              <div style={{ display:"flex", gap:10, marginBottom:14 }}>
                {[
                  ["ว่าง",    totalSlots - res.length,             C.greenBg,  C.green],
                  ["จอง",     res.filter(r=>!r.overbooked).length, C.accentLight, C.accent],
                  ["Overbook",res.filter(r=>r.overbooked).length,  C.amberBg,  C.amber],
                ].map(([lbl, val, sbg, sc]) => (
                  <div key={lbl} style={{ flex:1, background:sbg, borderRadius:8, padding:"8px 10px", textAlign:"center" }}>
                    <p style={{ margin:0, fontSize:17, fontWeight:700, color:sc, fontFamily:"'Cormorant Garamond',serif" }}>{val}</p>
                    <p style={{ margin:0, fontSize:10.5, color:sc }}>{lbl}</p>
                  </div>
                ))}
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 }}>
                {[0,1,2].map(z => {
                  const adv = advisors.find(a => a.id === advIds[z]);
                  return (
                    <div key={z} style={{ background:C.soft, borderRadius:8, padding:"8px 10px" }}>
                      <p style={{ margin:"0 0 2px", fontSize:10, fontWeight:600, color:C.muted, textTransform:"uppercase", letterSpacing:0.4 }}>Zone {["A","B","C"][z]}</p>
                      <p style={{ margin:0, fontSize:12, fontWeight:600 }}>{adv ? adv.name : <span style={{ color:C.red }}>ยังไม่ระบุ</span>}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Print session summary ── */}
      <div style={{ ...cardStyle, marginBottom:22, padding:"20px 24px" }}>
        <h3 style={{ margin:"0 0 14px", fontSize:15, fontWeight:600 }}>🖨 พิมพ์สรุปช่วงเวลา (Landscape A4)</h3>
        <div style={{ display:"flex", gap:12, alignItems:"flex-end", flexWrap:"wrap" }}>
          <div style={{ flex:1, minWidth:160 }}>
            <label style={lblStyle}>เลือกวัน</label>
            <select value={printDate} onChange={e=>setPrintDate(e.target.value)} style={inpStyle}>
              {next14Days.map(d=><option key={d} value={d}>{displayDate(d)}</option>)}
            </select>
          </div>
          <div style={{ flex:1, minWidth:160 }}>
            <label style={lblStyle}>ช่วงเวลา</label>
            <select value={printSess} onChange={e=>setPrintSess(e.target.value)} style={inpStyle}>
              <option value="morning">☀ ช่วงเช้า 09:00–12:00</option>
              {!isWednesday(printDate)&&<option value="afternoon">🌤 ช่วงบ่าย 13:00–16:00</option>}
            </select>
          </div>
          <button
            style={{ ...btnStyle("primary"), padding:"9px 24px", whiteSpace:"nowrap" }}
            onClick={()=>printSessionSummary({ dateStr:printDate, session:printSess, reservations, units, advisors, sessionAdvisors })}>
            พิมพ์สรุป →
          </button>
        </div>
        <p style={{ margin:"10px 0 0", fontSize:12, color:C.muted }}>
          สรุป: {reservations.filter(r=>r.date===printDate&&r.session===printSess&&r.status!=="cancelled").length} การจอง ใน {displayDate(printDate)} {printSess==="morning"?"ช่วงเช้า":"ช่วงบ่าย"}
        </p>
      </div>

      {/* ── Overbook alerts (for selected date) ── */}
      {overbookedList.length>0&&(
        <div style={{ ...cardStyle, marginBottom:22, border:`1px solid ${C.amberLine}`, background:"#fffdf5", padding:"18px 22px" }}>
          <h3 style={{ margin:"0 0 12px", fontSize:15, fontWeight:600, color:C.amber }}>⚠ Overbook — {overbookedList.length} รายการ</h3>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {overbookedList.map(r=>{
              const unit = units.find(u=>u.id===r.unitId);
              return (
                <div key={r.id} style={{ display:"flex", gap:10, flexWrap:"wrap", padding:"9px 13px", background:C.amberBg, borderRadius:8, fontSize:13 }}>
                  <span style={{ fontWeight:600 }}>{unit?.name}</span><span style={{ color:C.muted }}>·</span>
                  <span>{displayDate(r.date)}</span><span style={{ color:C.muted }}>·</span>
                  <Badge t={r.session}>{r.session==="morning"?"เช้า":"บ่าย"}</Badge><span style={{ color:C.muted }}>·</span>
                  <span>{r.studentName} → {r.patientName} ({r.hn})</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Ghost (ผี) alerts (for selected date) ── */}
      {(()=>{ const ghostList = reservations.filter(r=>r.isGhost&&r.status!=="cancelled"&&r.date===selDate); return ghostList.length>0&&(
        <div style={{ ...cardStyle, marginBottom:22, border:"1px solid #e9d5ff", background:"#fdf4ff", padding:"18px 22px" }}>
          <h3 style={{ margin:"0 0 12px", fontSize:15, fontWeight:600, color:"#7c3aed" }}>👻 ผี — {ghostList.length} รายการ (นิสิตที่ไม่มีสิทธิ์จองตามตาราง)</h3>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {ghostList.map(r=>{
              const unit = units.find(u=>u.id===r.unitId);
              return (
                <div key={r.id} style={{ display:"flex", gap:10, flexWrap:"wrap", padding:"9px 13px", background:"#f5f3ff", borderRadius:8, fontSize:13 }}>
                  <span style={{ fontWeight:600 }}>{unit?.name}</span><span style={{ color:C.muted }}>·</span>
                  <span>{displayDate(r.date)}</span><span style={{ color:C.muted }}>·</span>
                  <Badge t={r.session}>{r.session==="morning"?"เช้า":"บ่าย"}</Badge><span style={{ color:C.muted }}>·</span>
                  <span style={{ color:"#7c3aed", fontWeight:500 }}>{r.studentName}</span><span style={{ color:C.muted }}>→</span>
                  <span>{r.patientName} ({r.hn})</span>
                </div>
              );
            })}
          </div>
        </div>
      ); })()}

      {/* ── Selected date full table ── */}
      <div style={cardStyle}>
        <h3 style={{ margin:"0 0 14px", fontSize:15, fontWeight:600 }}>
          ตาราง{isToday?"วันนี้":"วันที่เลือก"} — ทุกช่วง
        </h3>
        {selRes.length===0
          ? <p style={{ color:C.muted, fontSize:13, margin:0 }}>ยังไม่มีการจองในวันที่เลือก</p>
          : (
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead><tr style={{ borderBottom:`2px solid ${C.line}` }}>
                  {["ยูนิต","ช่วง","นิสิต","ผู้ป่วย","HN","การรักษา","สถานะ","ผี","ต่อยูนิต"].map(h=>(
                    <th key={h} style={{ textAlign:"left", padding:"7px 12px", color:C.muted, fontWeight:600, fontSize:11.5, textTransform:"uppercase", letterSpacing:0.4 }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {selRes.sort((a,b)=>a.session===b.session?a.unitId-b.unitId:a.session.localeCompare(b.session)).map(r=>{
                    const unit = units.find(u=>u.id===r.unitId);
                    return (
                      <tr key={r.id} style={{ borderBottom:`1px solid ${C.line}` }}>
                        <td style={{ padding:"9px 12px", fontWeight:600 }}>{unit?.name}</td>
                        <td style={{ padding:"9px 12px" }}><Badge t={r.session}>{r.session==="morning"?"เช้า":"บ่าย"}</Badge></td>
                        <td style={{ padding:"9px 12px" }}>{r.studentName}</td>
                        <td style={{ padding:"9px 12px" }}>{r.patientName}</td>
                        <td style={{ padding:"9px 12px", color:C.muted }}>{r.hn}</td>
                        <td style={{ padding:"9px 12px", maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.treatment}</td>
                        <td style={{ padding:"9px 12px" }}><Badge t={r.overbooked?"overbooked":r.status}>{r.overbooked?"⚠ Over":r.status==="confirmed"?"ยืนยันแล้ว":r.status==="cancelled"?"ยกเลิก":"รอดำเนินการ"}</Badge></td>
                        <td style={{ padding:"9px 12px" }}>{r.isGhost?<span style={{ color:"#7c3aed", fontWeight:600 }}>👻</span>:<span style={{ color:C.faint }}>—</span>}</td>
                        <td style={{ padding:"9px 12px" }}>{r.inheritUnit?<span style={{ background:"#fffbeb", color:"#d97706", borderRadius:6, padding:"2px 8px", fontSize:11.5, fontWeight:600 }}>🔗 ต่อ</span>:<span style={{ color:C.faint }}>—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  );
}

/* ═══ ADMIN SESSION ADVISORS ═════════════════════════════════════════════════════
   Shows auto-assigned advisors per session (derived from their fixed schedule).
   Admin can override per-session (one-time) or edit an advisor's weekly schedule.
   ═══════════════════════════════════════════════════════════════════════════════ */
function AdminSessionAdvisorsPage({ advisors, setAdvisors, sessionAdvisors, setSessionAdvisors, monthlyLineups, notify }) {
  const [selDate, setSelDate]       = useState(next14Days[0]);
  const [editingKey, setEditingKey] = useState(null);
  const [draftIds, setDraftIds]     = useState(["","",""]);
  const [scheduleAdv, setSchedAdv]  = useState(null);

  const sessions = getAvailableSessions(selDate);

  const openOverride = (date, session) => {
    const key     = `${date}__${session}`;
    const current = sessionAdvisors[key]||["","",""];
    setDraftIds([...current]);
    setEditingKey(key);
  };

const saveOverride = async () => {
    const [eDate, eSess] = editingKey.split("__");
    const prevSessionAdvisors = { ...sessionAdvisors };
    const currentKey = editingKey;
    const currentDraftIds = [...draftIds];
    setSessionAdvisors(prev => ({ ...prev, [currentKey]: currentDraftIds }));
    setEditingKey(null);
    notify("บันทึกอาจารย์นิเทศ (กำลังบันทึกพื้นหลัง)");
    try {
      await SheetsDB.saveSessionOverride(eDate, eSess, currentDraftIds[0], currentDraftIds[1], currentDraftIds[2]);
       notify("✓ บันทึกอาจารย์นิเทศเสร็จสมบูรณ์");
    } catch (error) {
      setSessionAdvisors(prevSessionAdvisors);
      notify(`⚠ บันทึกไม่สำเร็จ ระบบคืนค่าเดิม: ${error.message}`, true);
    }
  };

  /* Schedule editor state */
  const [schedDraft, setSchedDraft] = useState([]);
  const openSchedule = (adv) => {
    setSchedAdv(adv);
    setSchedDraft(adv.schedule.map(s=>({...s})));
  };
  const toggleSlot = (dow, session) => {
    setSchedDraft(prev=>{
      const exists = prev.some(s=>s.dow===dow&&s.session===session);
      return exists ? prev.filter(s=>!(s.dow===dow&&s.session===session)) : [...prev,{dow,session}];
    });
  };
const saveSchedule = async () => {
    const updated = { ...scheduleAdv, schedule: schedDraft };
    const prevAdvisors = [...advisors];
    const prevSessionAdvisors = { ...sessionAdvisors };
    const newAdvisors = advisors.map(a => a.id === updated.id ? updated : a);
    setAdvisors(newAdvisors);
    setSessionAdvisors(buildSessionAdvisors(newAdvisors, monthlyLineups)); // Rebuild the auto-assign map instantly
    setSchedAdv(null);
    notify(`อัปเดตตารางของ ${updated.name} (กำลังบันทึกพื้นหลัง)`);
    try {
      await SheetsDB.saveAdvisorSchedule(updated.id, schedDraft);
       notify("✓ อัปเดตตารางอาจารย์ลงฐานข้อมูลเสร็จสมบูรณ์");
    } catch (error) {
      setAdvisors(prevAdvisors);
      setSessionAdvisors(prevSessionAdvisors);
      notify(`⚠ อัปเดตตารางไม่สำเร็จ ระบบคืนค่าเดิม: ${error.message}`, true);
    }
  };

   
  return (
    <div>
      <div style={{ marginBottom:28 }}>
        <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>อาจารย์นิเทศประจำช่วง</h2>
        <p style={{ margin:0, color:C.muted, fontSize:14 }}>ตารางอัตโนมัติจากวันประจำของแต่ละอาจารย์ · แก้ไขตาราง หรือ Override เฉพาะวัน (ลาป่วย ฯลฯ)</p>
      </div>

      {/* Advisor weekly schedule cards */}
      <div style={{ ...cardStyle, marginBottom:22 }}>
        <h3 style={{ margin:"0 0 4px", fontSize:15, fontWeight:600 }}>ตารางประจำของอาจารย์ · คลิก "แก้ไขตาราง" เพื่อปรับวัน/ช่วงเวลา</h3>
        <p style={{ margin:"0 0 14px", fontSize:12.5, color:C.muted }}>โซนจะถูกกำหนดโดยลำดับในรายการ — อาจารย์คนแรกที่ตรงตารางได้ Zone A, คนที่สองได้ Zone B, คนที่สามได้ Zone C</p>
        {/* Conflict summary */}
        {(()=>{
          const conflicts = [];
          [1,2,3,4,5].forEach(dow=>{
            ["morning","afternoon"].forEach(sess=>{
              if (dow===3&&sess==="afternoon") return;
              const matched = advisors.filter(a=>a.active&&a.schedule.some(s=>s.dow===dow&&s.session===sess));
              if (matched.length>3) conflicts.push({ dow, sess, names:matched.map(a=>a.name), extra:matched.length-3 });
            });
          });
          return conflicts.length>0&&(
            <div style={{ background:C.amberBg, border:`1px solid ${C.amberLine}`, borderRadius:8, padding:"10px 14px", marginBottom:14, fontSize:13 }}>
              <strong style={{ color:C.amber }}>⚠ ช่วงเวลาที่มีอาจารย์เกิน 3 คน</strong>
              <div style={{ marginTop:6, display:"flex", flexDirection:"column", gap:4 }}>
                {conflicts.map((c,i)=>(
                  <div key={i} style={{ color:C.amber }}>
                    {DOW_FULL[c.dow]} {c.sess==="morning"?"ช่วงเช้า":"ช่วงบ่าย"} — {c.names.length} คน ({c.extra} คนเกิน, จะไม่ได้รับมอบหมายโซน)
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:12 }}>
          {advisors.map(adv=>(
            <div key={adv.id} style={{ background:C.soft, borderRadius:10, padding:"14px 16px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                <div>
                  <p style={{ margin:0, fontWeight:600, fontSize:14 }}>{adv.name}</p>
                  <p style={{ margin:"2px 0 0", fontSize:11.5, color:C.muted }}>อ้างอิง: Zone {adv.defaultZone}</p>
                </div>
                <button style={{ ...btnStyle("ghost"), padding:"4px 10px", fontSize:11.5 }} onClick={()=>openSchedule(adv)}>แก้ไขตาราง</button>
              </div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                {[1,2,3,4,5].map(dow=>{
                  const morningSlot  = adv.schedule.some(s=>s.dow===dow&&s.session==="morning");
                  const afterSlot    = adv.schedule.some(s=>s.dow===dow&&s.session==="afternoon");
                  if (!morningSlot&&!afterSlot) return null;
                  return (
                    <div key={dow}>
                      {morningSlot&&<span style={{ background:"#eff6ff", color:"#1d4ed8", borderRadius:6, padding:"2px 8px", fontSize:11.5, marginRight:3 }}>{DOW_LABELS[dow]}☀</span>}
                      {afterSlot&&dow!==3&&<span style={{ background:"#faf5ff", color:"#6b21a8", borderRadius:6, padding:"2px 8px", fontSize:11.5 }}>{DOW_LABELS[dow]}🌤</span>}
                    </div>
                  );
                })}
                {adv.schedule.length===0&&<span style={{ fontSize:12, color:C.faint }}>ยังไม่ได้กำหนดตาราง</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Date strip */}
      <div style={{ ...cardStyle, marginBottom:20, padding:"14px 18px" }}>
        <div style={{ display:"flex", gap:8, overflowX:"auto", paddingBottom:2 }}>
          {next14Days.map(d=>(
            <button key={d} onClick={()=>setSelDate(d)} style={{ flexShrink:0, padding:"8px 12px", borderRadius:8, border:selDate===d?`1.5px solid ${C.ink}`:`1px solid ${C.line}`, background:selDate===d?C.ink:"#fff", color:selDate===d?"#fff":C.ink, cursor:"pointer", fontFamily:"'Sarabun','Outfit',sans-serif", fontSize:12.5, fontWeight:500, minWidth:74, textAlign:"center" }}>
              {shortDay(d)}
              {isWednesday(d)&&<div style={{ fontSize:9.5, opacity:0.6, marginTop:1 }}>เช้าเท่านั้น</div>}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        {sessions.length===0?(
          <div style={{ ...cardStyle, textAlign:"center", padding:"40px", color:C.muted }}>ไม่มีการเรียนการสอนวันนี้</div>
        ):sessions.map(sess=>{
          const key    = `${selDate}__${sess}`;
          const advIds = sessionAdvisors[key]||["","",""];
          return (
            <div key={sess} style={cardStyle}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                <div>
                  <Badge t={sess}>{sess==="morning"?"☀ ช่วงเช้า 09:00–12:00":"🌤 ช่วงบ่าย 13:00–16:00"}</Badge>
                  <span style={{ marginLeft:10, fontSize:13, color:C.muted }}>{displayDate(selDate)}</span>
                </div>
                <button style={{ ...btnStyle("ghost"), fontSize:12.5 }} onClick={()=>openOverride(selDate,sess)}>Override เฉพาะวัน</button>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12 }}>
                {[0,1,2].map(z=>{
                  const adv = advisors.find(a=>a.id===advIds[z]);
                  return (
                    <div key={z} style={{ background:C.soft, borderRadius:10, padding:"14px 16px" }}>
                      <p style={{ margin:"0 0 6px", fontSize:11, fontWeight:600, color:C.muted, textTransform:"uppercase", letterSpacing:0.5 }}>Zone {["A","B","C"][z]} (ยูนิต {z*8+1}–{z*8+8})</p>
                      {adv?(
                        <p style={{ margin:0, fontWeight:600, fontSize:14 }}>{adv.name}</p>
                      ):(
                        <p style={{ margin:0, color:C.red, fontSize:13 }}>ยังไม่ได้กำหนด</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* One-time override modal */}
      {editingKey&&(()=>{
        const [eDate,eSess]=editingKey.split("__");
        return (
          <Modal title={`Override อาจารย์นิเทศ — ${displayDate(eDate)}, ${eSess==="morning"?"ช่วงเช้า":"ช่วงบ่าย"}`} onClose={()=>setEditingKey(null)}>
            <p style={{ margin:"0 0 18px", fontSize:13, color:C.muted }}>เลือกอาจารย์นิเทศสำหรับวันนี้โดยเฉพาะ (ไม่กระทบตารางประจำ)</p>
            {[0,1,2].map(z=>(
              <div key={z} style={{ marginBottom:16 }}>
                <label style={lblStyle}>โซน {["A","B","C"][z]} — ยูนิต {z*8+1}–{z*8+8}</label>
                <select value={draftIds[z]} onChange={e=>{const n=[...draftIds];n[z]=e.target.value;setDraftIds(n);}} style={inpStyle}>
                  <option value="">— ยังไม่ได้กำหนด —</option>
                  {advisors.map(a=>(<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
            ))}
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:22 }}>
              <button style={btnStyle("ghost")} onClick={()=>setEditingKey(null)}>ยกเลิก</button>
              <button style={btnStyle("primary")} onClick={saveOverride}>บันทึก Override</button>
            </div>
          </Modal>
        );
      })()}

      {/* Weekly schedule editor modal */}
      {scheduleAdv&&(
        <Modal title={`แก้ไขตารางประจำ — ${scheduleAdv.name}`} onClose={()=>setSchedAdv(null)} wide>
          <p style={{ margin:"0 0 18px", fontSize:13, color:C.muted }}>คลิกช่องเพื่อเปิด/ปิดวัน+ช่วงเวลา · วันพุธมีเฉพาะช่วงเช้า</p>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13.5 }}>
            <thead>
              <tr>
                <th style={{ padding:"8px 12px", textAlign:"left", color:C.muted, fontWeight:600, fontSize:11, textTransform:"uppercase" }}>ช่วง</th>
                {[1,2,3,4,5].map(d=>(
                  <th key={d} style={{ padding:"8px 12px", textAlign:"center", color:C.muted, fontWeight:600, fontSize:11, textTransform:"uppercase" }}>{DOW_FULL[d]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {["morning","afternoon"].map(sess=>(
                <tr key={sess} style={{ borderTop:`1px solid ${C.line}` }}>
                  <td style={{ padding:"10px 12px" }}><Badge t={sess}>{sess==="morning"?"☀ เช้า":"🌤 บ่าย"}</Badge></td>
                  {[1,2,3,4,5].map(dow=>{
                    const disabled = sess==="afternoon"&&dow===3;
                    const active   = schedDraft.some(s=>s.dow===dow&&s.session===sess);
                    return (
                      <td key={dow} style={{ padding:"10px 12px", textAlign:"center" }}>
                        <button disabled={disabled} onClick={()=>!disabled&&toggleSlot(dow,sess)}
                          style={{ width:36, height:36, borderRadius:8, border:`1.5px solid ${active?C.ink:C.line}`, background:active?C.ink:"#fff", cursor:disabled?"not-allowed":"pointer", opacity:disabled?0.3:1, fontSize:16 }}>
                          {active?"✓":""}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:24 }}>
            <button style={btnStyle("ghost")} onClick={()=>setSchedAdv(null)}>ยกเลิก</button>
            <button style={btnStyle("primary")} onClick={saveSchedule}>บันทึกตาราง</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ═══ USER FORM MODAL ════════════════════════════════════════════════════════════ */
function UserFormModal({ modal, onSave, onClose }) {
  const item      = modal.item;
  const isStudent = modal.type==="student";

  const [name, setName]         = useState(item?.name      || "");
  const [username, setUname]    = useState(item?.username  || "");
  const [password, setPass]     = useState(item?.password  || "");
  const [program, setProgram]   = useState(item?.program   || "MSc");
  const [enrollYear, setEnrollYear] = useState(item?.enrollYear || new Date().getFullYear());
  const [zone, setZone]         = useState(item?.zone      || "A");
  const [defaultZone, setDefZ]  = useState(item?.defaultZone || "A");
  const [err, setErr]           = useState("");

  const save = () => {
    if (!name.trim())     return setErr("กรุณากรอกชื่อ");
    if (!username.trim()) return setErr("กรุณากรอกชื่อผู้ใช้");
    if (!password.trim()) return setErr("กรุณากรอกรหัสผ่าน");
    const base = { id:item?.id||"", name, username, password };
    onSave(isStudent ? {...base, program, enrollYear: Number(enrollYear)} : {...base, defaultZone, zone: defaultZone, schedule:item?.schedule||[]});
  };

  return (
    <Modal title={`${item?"แก้ไข":"เพิ่ม"} ${isStudent?"นิสิต":"อาจารย์"}`} onClose={onClose}>
      <div style={{ marginBottom:14 }}>
        <label style={lblStyle}>ชื่อ-นามสกุล</label>
        <input style={inpStyle} value={name} onChange={e=>setName(e.target.value)} />
      </div>
      <div style={{ marginBottom:14 }}>
        <label style={lblStyle}>ชื่อผู้ใช้</label>
        <input style={inpStyle} value={username} onChange={e=>setUname(e.target.value)} />
      </div>
      <div style={{ marginBottom:14 }}>
        <label style={lblStyle}>รหัสผ่าน</label>
        <input style={inpStyle} type="password" value={password} onChange={e=>setPass(e.target.value)} />
      </div>
      {isStudent&&(
        <div style={{ marginBottom:14 }}>
          <label style={lblStyle}>โปรแกรม</label>
          <select style={inpStyle} value={program} onChange={e=>setProgram(e.target.value)}>
            {PROGRAMS.map(p=><option key={p} value={p}>{PROGRAM_LABELS[p]}</option>)}
          </select>
        </div>
      )}
      {isStudent&&(
        <div style={{ marginBottom:14 }}>
          <label style={lblStyle}>ปีที่เข้าศึกษา (Enroll Year)</label>
          <select style={inpStyle} value={enrollYear} onChange={e=>setEnrollYear(e.target.value)}>
            {Array.from({length:10},(_,i)=>new Date().getFullYear()-i).map(y=>(
              <option key={y} value={y}>{y} — ชั้นปีที่ {getClassYear(y)||"?"}</option>
            ))}
          </select>
          <p style={{ margin:"4px 0 0", fontSize:11.5, color:C.muted }}>ชั้นปีปัจจุบัน: ปีที่ {getClassYear(enrollYear)||"—"} (นับจาก 1 ส.ค. ของแต่ละปี)</p>
        </div>
      )}
      {!isStudent&&(
        <div style={{ marginBottom:14 }}>
          <label style={lblStyle}>โซนหลัก (สำหรับ Auto-assign)</label>
          <select style={inpStyle} value={defaultZone} onChange={e=>setDefZ(e.target.value)}>
            <option value="A">Zone A</option>
            <option value="B">Zone B</option>
            <option value="C">Zone C</option>
          </select>
        </div>
      )}
      {err&&<p style={{ margin:"0 0 10px", color:C.red, fontSize:13 }}>{err}</p>}
      <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:8 }}>
        <button style={btnStyle("ghost")} onClick={onClose}>ยกเลิก</button>
        <button style={btnStyle("primary")} onClick={save}>บันทึก</button>
      </div>
    </Modal>
  );
}

/* ═══ ADMIN MANAGE USERS ══════════════════════════════════════════════════════════ */
function AdminManageUsersPage({ students, setStudents, advisors, setAdvisors, notify }) {
  const [tab, setTab]           = useState("students");
  const [modal, setModal]       = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // {type:"student"|"advisor", id, name}
  const [sortCol,  setSortCol]  = useState("id");
  const [sortAsc,  setSortAsc]  = useState(true);
  const [selectedIds, setSelectedIds] = useState(new Set());

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (items) => {
    if (selectedIds.size === items.length && items.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map(i => i.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`ยืนยันการลบ ${selectedIds.size} รายการที่เลือก?`)) return;

    const ids = Array.from(selectedIds);
    if (tab === "students") {
      const prevStudents = [...students];
      setStudents(p => p.filter(s => !ids.includes(s.id)));
      notify("กำลังลบนิสิตที่เลือก (บันทึกพื้นหลัง)");
      try {
        await SheetsDB.batchDeactivateUsers(ids, []);
        notify(`✓ ลบนิสิต ${ids.length} รายการเสร็จสมบูรณ์`);
      } catch (error) {
        setStudents(prevStudents);
        notify(`⚠ ลบไม่สำเร็จ: ${error.message}`, true);
      }
    } else {
      const prevAdvisors = [...advisors];
      setAdvisors(p => p.filter(a => !ids.includes(a.id)));
      notify("กำลังลบอาจารย์ที่เลือก (บันทึกพื้นหลัง)");
      try {
        await SheetsDB.batchDeactivateUsers([], ids);
        notify(`✓ ลบอาจารย์ ${ids.length} รายการเสร็จสมบูรณ์`);
      } catch (error) {
        setAdvisors(prevAdvisors);
        notify(`⚠ ลบไม่สำเร็จ: ${error.message}`, true);
      }
    }
    setSelectedIds(new Set());
  };

  function toggleSort(col) {
    if (sortCol === col) setSortAsc(a => !a);
    else { setSortCol(col); setSortAsc(true); }
  }

  const SortIcon = ({ col }) => (
    <span style={{ marginLeft:4, opacity: sortCol === col ? 1 : 0.25, fontSize:10 }}>
      {sortCol === col ? (sortAsc ? "▲" : "▼") : "▼"}
    </span>
  );

  const sortedStudents = [...students].sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (!va) va = "";
    if (!vb) vb = "";
    const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb));
    return sortAsc ? cmp : -cmp;
  });

  const sortedAdvisors = [...advisors].sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (!va) va = "";
    if (!vb) vb = "";
    const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb));
    return sortAsc ? cmp : -cmp;
  });

  const studentCols = [
    { k: "id", l: "ID" },
    { k: "name", l: "ชื่อ" },
    { k: "username", l: "ชื่อผู้ใช้" },
    { k: "password", l: "รหัสผ่าน" },
    { k: "program", l: "โปรแกรม" },
    { k: "enrollYear", l: "ชั้นปี" },
    { k: "", l: "" }
  ];

  const advisorCols = [
    { k: "id", l: "ID" },
    { k: "name", l: "ชื่อ" },
    { k: "username", l: "ชื่อผู้ใช้" },
    { k: "password", l: "รหัสผ่าน" },
    { k: "defaultZone", l: "โซนหลัก" },
    { k: "schedule", l: "ตารางประจำ" },
    { k: "", l: "" }
  ];

const handleSave = async (data) => {
    const prevStudents = [...students];
    const prevAdvisors = [...advisors];
    const targetType = modal.type;
    const isEdit = !!modal.item;
    
    let targetData = { ...data };
    if (targetType === "student") {
      if (isEdit) {
        setStudents(p => p.map(s => s.id === targetData.id ? targetData : s));
      } else {
        const nid = generateId("student", students);
        targetData = { ...targetData, id: nid, username: targetData.username || nid, active: true };
        setStudents(p => [...p, targetData]);
      }
      notify(`${isEdit ? "อัปเดต" : "เพิ่ม"}นิสิต (กำลังบันทึกพื้นหลัง)`);
    } else {
      if (isEdit) {
        setAdvisors(p => p.map(a => a.id === targetData.id ? targetData : a));
      } else {
        const nid = generateId("advisor", advisors);
        targetData = { ...targetData, id: nid, schedule: [], active: true };
        setAdvisors(p => [...p, targetData]);
      }
      notify(`${isEdit ? "อัปเดต" : "เพิ่ม"}อาจารย์ (กำลังบันทึกพื้นหลัง)`);
    }
    setModal(null);
try {
      if (targetType === "student") {
        if (isEdit) {
          await SheetsDB.updateStudent(targetData);
          notify("✓ อัปเดตข้อมูลนิสิตลงฐานข้อมูลสำเร็จสมบูรณ์");
        } else {
          await SheetsDB.appendStudent(targetData);
          notify("✓ เพิ่มนิสิตลงฐานข้อมูลสำเร็จสมบูรณ์");
        }
      } else {
        if (isEdit) {
          await SheetsDB.updateAdvisor(targetData);
          notify("✓ อัปเดตข้อมูลอาจารย์ลงฐานข้อมูลสำเร็จสมบูรณ์");
        } else {
          await SheetsDB.appendAdvisor(targetData);
          notify("✓ เพิ่มอาจารย์ลงฐานข้อมูลสำเร็จสมบูรณ์");
        }
      }
    } catch (error) {
      if (targetType === "student") setStudents(prevStudents);
      else setAdvisors(prevAdvisors);
      notify(`⚠ บันทึกไม่สำเร็จ ระบบคืนค่าเดิม: ${error.message}`, true);
    }
  };
   
  const removeStudent = async (id) => { 
    const student = students.find(s => s.id === id);
    if (!student) return;
    const prevStudents = [...students];
    setStudents(p => p.filter(s => s.id !== id)); 
    notify("ลบนิสิตออกจากระบบ (กำลังบันทึกพื้นหลัง)");
    try {
      await SheetsDB.updateStudent({ ...student, active: false });
        notify("✓ ลบข้อมูลนิสิตจากฐานข้อมูลเสร็จสมบูรณ์");
    } catch (error) {
      setStudents(prevStudents);
      notify(`⚠ ลบไม่สำเร็จ ระบบคืนค่าเดิม: ${error.message}`, true);
    }
  };

  const removeAdvisor = async (id) => { 
    const adv = advisors.find(a => a.id === id);
    if (!adv) return;
    const prevAdvisors = [...advisors];
    setAdvisors(p => p.filter(a => a.id !== id)); 
    notify("ลบอาจารย์ออกจากระบบ (กำลังบันทึกพื้นหลัง)");
    try {
      await SheetsDB.updateAdvisor({ ...adv, active: false });
       notify("✓ ลบข้อมูลอาจารย์จากฐานข้อมูลเสร็จสมบูรณ์");
    } catch (error) {
      setAdvisors(prevAdvisors);
      notify(`⚠ ลบไม่สำเร็จ ระบบคืนค่าเดิม: ${error.message}`, true);
    }
  };

  const fileInputRef = useRef(null);

  const handleImportExcel = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = evt.target.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(sheet);
        
        let maxIdNum = students.map(s => parseInt(s.id.replace(/\D/g, ""), 10)).filter(n => !isNaN(n));
        let nextId = maxIdNum.length ? Math.max(...maxIdNum) + 1 : 6001;
        
        const newStudents = [];
        for (const row of json) {
          if (!row["ชื่อ"] && !row["name"] && !row["Name"]) continue;
          
          let id = String(row["ID"] || row["id"] || "");
          if (!id) {
            id = `D${nextId}`;
            nextId++;
          }
          
          newStudents.push({
            id: id.trim(),
            name: row["ชื่อ"] || row["name"] || row["Name"] || "",
            username: String(row["ชื่อผู้ใช้"] || row["username"] || row["Username"] || id),
            password: String(row["รหัสผ่าน"] || row["password"] || row["Password"] || "1234"),
            program: row["โปรแกรม"] || row["program"] || row["Program"] || "MSc",
            enrollYear: Number(row["ชั้นปี"] || row["enrollYear"] || row["year"] || new Date().getFullYear()),
            active: true
          });
        }
        
        if (newStudents.length === 0) {
          notify("⚠ ไม่พบข้อมูลนิสิตในไฟล์ หรือรูปแบบไม่ถูกต้อง", true);
          return;
        }

        if (!window.confirm(`พบข้อมูลนิสิต ${newStudents.length} คน ยืนยันการนำเข้า?`)) {
          e.target.value = "";
          return;
        }

        const prevStudents = [...students];
        notify(`กำลังนำเข้านิสิต ${newStudents.length} คน (บันทึกพื้นหลัง)`);
        setStudents(p => [...p, ...newStudents]);
        
        try {
          await SheetsDB.batchAppendStudents(newStudents);
          notify(`✓ นำเข้านิสิตสำเร็จสมบูรณ์`);
        } catch(error) {
          setStudents(prevStudents);
          notify(`⚠ นำเข้าไม่สำเร็จ ระบบคืนค่าเดิม: ${error.message}`, true);
        }
        
      } catch (err) {
        notify("⚠ เกิดข้อผิดพลาดในการอ่านไฟล์", true);
      }
      e.target.value = "";
    };
    reader.readAsBinaryString(file);
  };

  return (
    <div>
      <div style={{ marginBottom:28 }}>
        <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>จัดการผู้ใช้งาน</h2>
        <p style={{ margin:0, color:C.muted, fontSize:14 }}>แก้ไขข้อมูลบัญชีนิสิตและอาจารย์ · แก้ไขตารางประจำอาจารย์ได้ที่หน้า "อาจารย์นิเทศ"</p>
      </div>
      <div style={{ display:"flex", gap:8, marginBottom:20 }}>
        {[["students",`นิสิต (${students.length} คน)`],["advisors",`อาจารย์ (${advisors.length} คน)`]].map(([k,l])=>(
          <button key={k} onClick={()=>{ setTab(k); setSelectedIds(new Set()); }} style={{ ...btnStyle(tab===k?"primary":"ghost"), fontSize:13 }}>{l}</button>
        ))}
        {selectedIds.size > 0 && (
          <button style={{ ...btnStyle("danger"), marginLeft:16, fontSize:13 }} onClick={handleBulkDelete}>
            ลบที่เลือก ({selectedIds.size})
          </button>
        )}
        <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
          {tab === "students" && (
            <>
              <input type="file" accept=".xlsx" style={{ display: "none" }} ref={fileInputRef} onChange={handleImportExcel} />
              <button style={{ ...btnStyle("ghost"), fontSize:13 }} onClick={() => fileInputRef.current?.click()}>
                นำเข้าจาก Excel
              </button>
            </>
          )}
          <button style={{ ...btnStyle("ghost"), fontSize:13 }} onClick={()=>setModal({type:tab==="students"?"student":"advisor",item:null})}>
            + เพิ่ม {tab==="students"?"นิสิต":"อาจารย์"}
          </button>
        </div>
      </div>

      {tab==="students"&&(
        <div style={{ ...cardStyle, padding:0, overflow:"hidden" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13.5 }}>
            <thead><tr style={{ background:C.soft, borderBottom:`1px solid ${C.line}` }}>
              <th style={{ padding:"10px 16px", width:30 }}>
                <input type="checkbox" checked={selectedIds.size > 0 && selectedIds.size === sortedStudents.length} onChange={() => toggleSelectAll(sortedStudents)} />
              </th>
              {studentCols.map(h=>(
                <th key={h.l} onClick={h.k ? () => toggleSort(h.k) : undefined} style={{ textAlign:"left", padding:"10px 16px", color:sortCol===h.k?C.accent:C.muted, fontWeight:600, fontSize:11.5, textTransform:"uppercase", letterSpacing:0.4, cursor: h.k ? "pointer" : "default", userSelect:"none" }}>
                  {h.l}
                  {h.k && <SortIcon col={h.k} />}
                </th>
              ))}
            </tr></thead>
            <tbody>
              {sortedStudents.map(s=>(
                <tr key={s.id} style={{ borderBottom:`1px solid ${C.line}` }}>
                  <td style={{ padding:"11px 16px" }}>
                    <input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} />
                  </td>
                  <td style={{ padding:"11px 16px", color:C.muted, fontSize:13 }}>{s.id}</td>
                  <td style={{ padding:"11px 16px", fontWeight:500 }}>{s.name}</td>
                  <td style={{ padding:"11px 16px", fontFamily:"monospace", fontSize:13 }}>{s.username}</td>
                  <td style={{ padding:"11px 16px" }}><span style={{ background:C.soft, borderRadius:6, padding:"2px 8px", fontFamily:"monospace", fontSize:12 }}>{s.password}</span></td>
                  <td style={{ padding:"11px 16px" }}><Badge t="active">{PROGRAM_LABELS[s.program]||s.program}</Badge></td>
         <td style={{ padding:"11px 16px", fontSize:13 }}>
  {s.enrollYear ? (
    <div>
      <span title={`รุ่น ${s.enrollYear}`} style={{ fontWeight:500 }}>
        ปีที่ {getClassYear(s.enrollYear)}
      </span>
      <div style={{ marginTop:3, display:"flex", alignItems:"center", gap:4 }}>
        <span style={{ fontSize:10, color:C.muted }}>→ ปีที่ {getClassYear(s.enrollYear)+1} ใน</span>
        <span style={{
          fontSize:10.5, fontWeight:600,
          background: COUNTDOWN_TO_ADV === "วันนี้!" ? C.greenBg : C.amberBg,
          color:       COUNTDOWN_TO_ADV === "วันนี้!" ? C.green   : C.amber,
          borderRadius:99, padding:"1px 7px",
        }}>
          {COUNTDOWN_TO_ADV === "วันนี้!" ? "🎉 วันนี้!" : `⏳ ${COUNTDOWN_TO_ADV}`}
        </span>
      </div>
    </div>
  ) : <span style={{ color:C.faint }}>—</span>}
</td>
                  <td style={{ padding:"11px 16px" }}>
                    <div style={{ display:"flex", gap:8 }}>
                      <button style={{ ...btnStyle("ghost"), padding:"5px 12px", fontSize:12 }} onClick={()=>setModal({type:"student",item:s})}>แก้ไข</button>
                      <button style={{ ...btnStyle("danger"), padding:"5px 12px", fontSize:12 }} onClick={()=>setConfirmDelete({type:"student",id:s.id,name:s.name})}>ลบ</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab==="advisors"&&(
        <div style={{ ...cardStyle, padding:0, overflow:"hidden" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13.5 }}>
            <thead><tr style={{ background:C.soft, borderBottom:`1px solid ${C.line}` }}>
              <th style={{ padding:"10px 16px", width:30 }}>
                <input type="checkbox" checked={selectedIds.size > 0 && selectedIds.size === sortedAdvisors.length} onChange={() => toggleSelectAll(sortedAdvisors)} />
              </th>
              {advisorCols.map(h=>(
                <th key={h.l} onClick={h.k ? () => toggleSort(h.k) : undefined} style={{ textAlign:"left", padding:"10px 16px", color:sortCol===h.k?C.accent:C.muted, fontWeight:600, fontSize:11.5, textTransform:"uppercase", letterSpacing:0.4, cursor: h.k ? "pointer" : "default", userSelect:"none" }}>
                  {h.l}
                  {h.k && <SortIcon col={h.k} />}
                </th>
              ))}
            </tr></thead>
            <tbody>
              {sortedAdvisors.map(a=>(
                <tr key={a.id} style={{ borderBottom:`1px solid ${C.line}` }}>
                  <td style={{ padding:"11px 16px" }}>
                    <input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggleSelect(a.id)} />
                  </td>
                  <td style={{ padding:"11px 16px", color:C.muted, fontSize:13 }}>{a.id}</td>
                  <td style={{ padding:"11px 16px", fontWeight:500 }}>{a.name}</td>
                  <td style={{ padding:"11px 16px", fontFamily:"monospace", fontSize:13 }}>{a.username}</td>
                  <td style={{ padding:"11px 16px" }}><span style={{ background:C.soft, borderRadius:6, padding:"2px 8px", fontFamily:"monospace", fontSize:12 }}>{a.password}</span></td>
                  <td style={{ padding:"11px 16px" }}>Zone {a.defaultZone}</td>
                  <td style={{ padding:"11px 16px" }}>
                    <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                      {a.schedule.length===0?<span style={{ fontSize:12, color:C.faint }}>—</span>:
                        a.schedule.map((s,i)=>(
                          <span key={i} style={{ background:s.session==="morning"?"#eff6ff":"#faf5ff", color:s.session==="morning"?"#1d4ed8":"#6b21a8", borderRadius:6, padding:"2px 7px", fontSize:11 }}>
                            {DOW_LABELS[s.dow]}{s.session==="morning"?"☀":"🌤"}
                          </span>
                        ))
                      }
                    </div>
                  </td>
                  <td style={{ padding:"11px 16px" }}>
                    <div style={{ display:"flex", gap:8 }}>
                      <button style={{ ...btnStyle("ghost"), padding:"5px 12px", fontSize:12 }} onClick={()=>setModal({type:"advisor",item:a})}>แก้ไข</button>
                      <button style={{ ...btnStyle("danger"), padding:"5px 12px", fontSize:12 }} onClick={()=>setConfirmDelete({type:"advisor",id:a.id,name:a.name})}>ลบ</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal&&<UserFormModal modal={modal} onSave={handleSave} onClose={()=>setModal(null)} />}

      {confirmDelete&&(
        <Modal title="ยืนยันการลบ" onClose={()=>setConfirmDelete(null)}>
          <p style={{ margin:"0 0 20px", fontSize:14, color:C.ink }}>
            คุณต้องการลบ <strong>{confirmDelete.name}</strong> ออกจากระบบใช่หรือไม่?<br/>
            <span style={{ fontSize:13, color:C.muted }}>การดำเนินการนี้ไม่สามารถย้อนกลับได้</span>
          </p>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <button style={btnStyle("ghost")} onClick={()=>setConfirmDelete(null)}>ยกเลิก</button>
            <button style={btnStyle("danger")} onClick={()=>{
              if (confirmDelete.type==="student") removeStudent(confirmDelete.id);
              else removeAdvisor(confirmDelete.id);
              setConfirmDelete(null);
            }}>ยืนยันการลบ</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ═══ ADMIN UNITS — with maintenance warning ══════════════════════════════════════ */
function AdminUnitsPage({ units, setUnits, advisors, sessionAdvisors, reservations, notify }) {
  const [pendingMaint, setPendingMaint] = useState(null);
  const [editing, setEditing]           = useState(null);

  const openEdit = (unit) => {
    if (unit.status==="active") {
      // Check for upcoming bookings on this unit
      const upcoming = reservations.filter(r=>r.unitId===unit.id&&r.date>=todayStr&&r.status!=="cancelled");
      if (upcoming.length>0) {
        setPendingMaint({ unit, upcoming });
        return;
      }
    }
    setEditing({...unit});
  };

  const confirmMaintenance = () => {
    setEditing({...pendingMaint.unit, status:"maintenance"});
    setPendingMaint(null);
  };

const saveEdit = async () => {
    const prevUnits = [...units];
    const targetUnit = { ...editing };
    setUnits(p => p.map(u => u.id === targetUnit.id ? targetUnit : u));
    setEditing(null);
    notify("อัปเดตยูนิต (กำลังบันทึกพื้นหลัง)");
    try {
      await SheetsDB.saveUnitStatus(targetUnit.id, targetUnit.status);
       notify("✓ อัปเดตยูนิตลงฐานข้อมูลเสร็จสมบูรณ์");
    } catch (error) {
      setUnits(prevUnits);
      notify(`⚠ อัปเดตยูนิตไม่สำเร็จ ระบบคืนค่าเดิม: ${error.message}`, true);
    }
  };

  return (
    <div>
      <div style={{ marginBottom:28 }}>
        <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>จัดการยูนิต</h2>
        <p style={{ margin:0, color:C.muted, fontSize:14 }}>24 ยูนิต แบ่ง 3 โซน · คลิกยูนิตเพื่อเปลี่ยนสถานะ</p>
      </div>

      {[0,1,2].map(z=>{
        const zUnits   = units.filter(u=>u.zoneIdx===z);
        const todayKey = `${todayStr}__morning`;
        const advIds   = sessionAdvisors[todayKey]||["","",""];
        const adv      = advisors.find(a=>a.id===advIds[z]);
        return (
          <div key={z} style={{ marginBottom:28 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12 }}>
              <span style={{ fontSize:13, fontWeight:600, color:C.muted, textTransform:"uppercase", letterSpacing:0.5 }}>
                Zone {["A","B","C"][z]} — {adv?adv.name:"ยังไม่มีอาจารย์นิเทศวันนี้"}
              </span>
              <div style={{ flex:1, height:1, background:C.line }} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))", gap:10 }}>
              {zUnits.map(unit=>{
                const isMaint = unit.status==="maintenance";
                const upcoming = reservations.filter(r=>r.unitId===unit.id&&r.date>=todayStr&&r.status!=="cancelled");
                return (
                  <div key={unit.id} onClick={()=>openEdit(unit)} style={{ background:"#fff", border:`1px solid ${isMaint?C.amberLine:C.line}`, borderRadius:10, padding:"14px 16px", cursor:"pointer", transition:"box-shadow .15s" }}
                    onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 14px rgba(0,0,0,0.08)"}
                    onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
                      <span style={{ fontWeight:600, fontSize:14.5 }}>{unit.name}</span>
                      <Badge t={isMaint?"maintenance":"active"}>{isMaint?"ซ่อมบำรุง":"ใช้งาน"}</Badge>
                    </div>
                    <p style={{ margin:"5px 0 0", fontSize:12, color:C.muted }}>{unit.room}</p>
                    {upcoming.length>0&&!isMaint&&(
                      <p style={{ margin:"5px 0 0", fontSize:11.5, color:C.amber }}>⚠ {upcoming.length} การจองที่จะมาถึง</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Maintenance warning modal */}
      {pendingMaint&&(
        <Modal title="⚠ แจ้งเตือน — มีการจองอยู่แล้ว" onClose={()=>setPendingMaint(null)}>
          <div style={{ background:C.amberBg, border:`1px solid ${C.amberLine}`, borderRadius:8, padding:"14px 16px", marginBottom:18 }}>
            <p style={{ margin:0, fontWeight:600, color:C.amber, fontSize:14 }}>
              {pendingMaint.unit.name} มีการจองที่ยังไม่ถึงกำหนด {pendingMaint.upcoming.length} รายการ
            </p>
            <p style={{ margin:"6px 0 0", fontSize:13, color:C.amber }}>
              หากปิดซ่อมบำรุง การจองเหล่านี้จะยังคงอยู่ในระบบ แต่นิสิตจะไม่สามารถจองยูนิตนี้เพิ่มเติมได้
            </p>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:18 }}>
            {pendingMaint.upcoming.slice(0,5).map(r=>(
              <div key={r.id} style={{ display:"flex", gap:10, alignItems:"center", padding:"8px 12px", background:C.soft, borderRadius:8, fontSize:13 }}>
                <span style={{ fontWeight:600 }}>{displayDate(r.date)}</span>
                <Badge t={r.session}>{r.session==="morning"?"เช้า":"บ่าย"}</Badge>
                <span style={{ color:C.muted }}>{r.studentName} · {r.patientName}</span>
              </div>
            ))}
            {pendingMaint.upcoming.length>5&&<p style={{ margin:0, fontSize:12, color:C.muted, textAlign:"center" }}>...และอีก {pendingMaint.upcoming.length-5} รายการ</p>}
          </div>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <button style={btnStyle("ghost")} onClick={()=>setPendingMaint(null)}>ยกเลิก</button>
            <button style={{ ...btnStyle("amber") }} onClick={confirmMaintenance}>ดำเนินการต่อ — ปิดซ่อมบำรุง</button>
          </div>
        </Modal>
      )}

      {/* Edit status modal */}
      {editing&&(
        <Modal title={`แก้ไข ${editing.name}`} onClose={()=>setEditing(null)}>
          <div style={{ marginBottom:16 }}>
            <label style={lblStyle}>สถานะ</label>
            <select value={editing.status} onChange={e=>setEditing({...editing,status:e.target.value})} style={inpStyle}>
              <option value="active">ใช้งาน</option>
              <option value="maintenance">ซ่อมบำรุง</option>
            </select>
          </div>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <button style={btnStyle("ghost")} onClick={()=>setEditing(null)}>ยกเลิก</button>
            <button style={btnStyle("primary")} onClick={saveEdit}>บันทึก</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ═══ ADMIN RESERVATIONS ═════════════════════════════════════════════════════════ */
/* ═══ ADMIN STUDENT SUMMARY (Reservation Report) ════════════════════════════════
   Shows per-student reservation counts (total, ghost, normal) for a date range.
   Supports quick presets (this year, last year, this month, last month, custom).
   Includes a print-friendly full-page report.
   ══════════════════════════════════════════════════════════════════════════════ */
function printStudentSummaryReport({ rows, fromDate, toDate, periodLabel }) {
  const now = new Date().toLocaleString("th-TH", { dateStyle:"short", timeStyle:"short" });
  const tableRows = rows.map((r, i) => `
    <tr class="${i % 2 === 0 ? "even" : "odd"}">
      <td class="center">${i + 1}</td>
      <td>${r.name}</td>
      <td class="center">${r.id}</td>
      <td class="center">${r.program || "—"}</td>
      <td class="num">${r.total}</td>
      <td class="num ghost">${r.ghost}</td>
      <td class="num">${r.normal}</td>
      <td class="num admin">${r.adminAdded}</td>
    </tr>`).join("");

  const win = window.open("", "_blank", "width=900,height=700");
  win.document.write(`<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"/>
  <title>รายงานสรุปการจอง — ${periodLabel}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Sarabun','Tahoma',sans-serif;font-size:13px;color:#16191f;padding:16mm 14mm;background:#fff}
    h1{font-size:22px;font-weight:700;margin-bottom:4px;letter-spacing:-.3px}
    .sub{color:#6b7280;font-size:12px;margin-bottom:18px}
    .period{display:inline-block;background:#e8eef7;color:#1e3a5f;border-radius:6px;padding:4px 14px;font-size:12px;font-weight:600;margin-bottom:18px}
    table{width:100%;border-collapse:collapse;font-size:12.5px}
    thead tr{background:#16191f;color:#fff}
    th{padding:9px 11px;text-align:left;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
    th.center,td.center{text-align:center}
    th.num,td.num{text-align:right;padding-right:18px}
    td{padding:8px 11px;border-bottom:1px solid #e5e7eb}
    tr.even td{background:#f9fafb}
    td.ghost{color:#7c3aed;font-weight:600}
    td.admin{color:#92400e;font-weight:600}
    .footer{margin-top:14px;font-size:11px;color:#9ca3af;display:flex;justify-content:space-between}
    .total-row td{font-weight:700;background:#f4f5f7!important;border-top:2px solid #e5e7eb}
    @media print{body{padding:10mm 10mm}}
  </style></head><body>
  <h1>🦷 CUProstho — รายงานสรุปการจองรายนิสิต</h1>
  <div class="sub">คณะทันตแพทยศาสตร์ จุฬาลงกรณ์มหาวิทยาลัย</div>
  <div class="period">📅 ${periodLabel} (${fromDate} ถึง ${toDate})</div>
  <table>
    <thead><tr>
      <th class="center" style="width:44px">#</th>
      <th>ชื่อนิสิต</th>
      <th class="center">รหัส</th>
      <th class="center">หลักสูตร</th>
      <th class="num">จองทั้งหมด</th>
      <th class="num">ผี 👻</th>
      <th class="num">ปกติ</th>
      <th class="num">แอดมินเพิ่ม 🔑</th>
    </tr></thead>
    <tbody>
      ${tableRows}
      <tr class="total-row">
        <td colspan="4" style="padding-left:11px">รวมทั้งหมด</td>
        <td class="num">${rows.reduce((s,r)=>s+r.total,0)}</td>
        <td class="num ghost">${rows.reduce((s,r)=>s+r.ghost,0)}</td>
        <td class="num">${rows.reduce((s,r)=>s+r.normal,0)}</td>
        <td class="num admin">${rows.reduce((s,r)=>s+r.adminAdded,0)}</td>
      </tr>
    </tbody>
  </table>
  <div class="footer">
    <span>จำนวนนิสิต: ${rows.length} คน</span>
    <span>พิมพ์เมื่อ: ${now}</span>
  </div>
  </body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 500);
}

function AdminStudentSummaryPage({ reservations, students }) {
  const currentYear  = today.getFullYear();
  const currentMonth = today.getMonth(); // 0-indexed

  // Preset helpers
  const presets = [
    { k:"this-year",  l:`ปีนี้ (${currentYear})` },
    { k:"last-year",  l:`ปีที่แล้ว (${currentYear - 1})` },
    { k:"this-month", l:"เดือนนี้" },
    { k:"last-month", l:"เดือนที่แล้ว" },
    { k:"custom",     l:"กำหนดเอง" },
  ];

  function rangeForPreset(k) {
    const pad = (n) => String(n).padStart(2,"0");
    if (k === "this-year")  return { from:`${currentYear}-01-01`, to:`${currentYear}-12-31` };
    if (k === "last-year")  return { from:`${currentYear-1}-01-01`, to:`${currentYear-1}-12-31` };
    if (k === "this-month") {
      const lastDay = new Date(currentYear, currentMonth + 1, 0).getDate();
      return { from:`${currentYear}-${pad(currentMonth+1)}-01`, to:`${currentYear}-${pad(currentMonth+1)}-${lastDay}` };
    }
    if (k === "last-month") {
      const lm = new Date(currentYear, currentMonth, 0);
      const y  = lm.getFullYear(), m = lm.getMonth() + 1;
      const lastDay = new Date(y, m, 0).getDate();
      return { from:`${y}-${pad(m)}-01`, to:`${y}-${pad(m)}-${lastDay}` };
    }
    return null; // custom
  }

  const [preset, setPreset]     = useState("this-year");
  const [fromDate, setFrom]     = useState(rangeForPreset("this-year").from);
  const [toDate,   setTo]       = useState(rangeForPreset("this-year").to);
  const [sortCol,  setSortCol]  = useState("total");
  const [sortAsc,  setSortAsc]  = useState(false);
  const [search,   setSearch]   = useState("");

  function applyPreset(k) {
    setPreset(k);
    const r = rangeForPreset(k);
    if (r) { setFrom(r.from); setTo(r.to); }
  }

  function toggleSort(col) {
    if (sortCol === col) setSortAsc(a => !a);
    else { setSortCol(col); setSortAsc(false); }
  }

  // Build per-student summary
  const inRange = reservations.filter(r => r.date >= fromDate && r.date <= toDate && r.status !== "cancelled");

  const byStudent = {};
  inRange.forEach(r => {
    if (!r.studentId) return;
    if (!byStudent[r.studentId]) {
      const stu = students.find(s => s.id === r.studentId);
      byStudent[r.studentId] = {
        id:          r.studentId,
        name:        r.studentName || stu?.name || r.studentId,
        program:     stu?.program || "—",
        total:       0,
        ghost:       0,
        normal:      0,
        adminAdded:  0,
      };
    }
    byStudent[r.studentId].total++;
    if (r.isGhost)       byStudent[r.studentId].ghost++;
    else                 byStudent[r.studentId].normal++;
    if (r.addedByAdmin)  byStudent[r.studentId].adminAdded++;
  });

  let rows = Object.values(byStudent);

  // Include students with 0 reservations? Only show active students who had bookings is fine — but we show all with ≥1 booking
  // (students with 0 will naturally not appear)

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  }

  rows.sort((a, b) => {
    const va = a[sortCol], vb = b[sortCol];
    const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb));
    return sortAsc ? cmp : -cmp;
  });

  const totalRes      = rows.reduce((s, r) => s + r.total,      0);
  const totalGhost    = rows.reduce((s, r) => s + r.ghost,      0);
  const totalNorm     = rows.reduce((s, r) => s + r.normal,     0);
  const totalAdmin    = rows.reduce((s, r) => s + r.adminAdded, 0);

  const presetLabel = presets.find(p => p.k === preset)?.l || "กำหนดเอง";

  const SortIcon = ({ col }) => (
    <span style={{ marginLeft:4, opacity: sortCol === col ? 1 : 0.25, fontSize:10 }}>
      {sortCol === col ? (sortAsc ? "▲" : "▼") : "▼"}
    </span>
  );

  const thStyle = (col) => ({
    textAlign: col === "name" || col === "program" ? "left" : "right",
    padding:"10px 14px",
    color: sortCol === col ? C.accent : C.muted,
    fontWeight:600, fontSize:11.5, textTransform:"uppercase", letterSpacing:.4,
    cursor:"pointer", whiteSpace:"nowrap", userSelect:"none",
    background: sortCol === col ? C.accentLight : C.soft,
    borderBottom:`1px solid ${C.line}`,
  });

  const numCell = (v, highlight, overrideColor, overrideBg) => (
    <td style={{ padding:"10px 14px", textAlign:"right", fontWeight: (highlight || overrideColor) ? 700 : 500,
      color: overrideColor ? overrideColor : highlight ? "#7c3aed" : C.ink,
      background: overrideBg && v > 0 ? overrideBg : highlight && v > 0 ? "#fdf4ff" : undefined }}>
      {v}
    </td>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom:24 }}>
        <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>สรุปการจองรายนิสิต</h2>
        <p style={{ margin:0, color:C.muted, fontSize:14 }}>จำนวนครั้งที่นิสิตแต่ละคนจองยูนิต รวมถึงการจองแบบผี</p>
      </div>

      {/* Controls */}
      <div style={{ ...cardStyle, marginBottom:20, padding:"18px 20px" }}>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8, alignItems:"center", marginBottom:16 }}>
          <span style={{ fontSize:12.5, fontWeight:600, color:C.muted, textTransform:"uppercase", letterSpacing:.4, marginRight:4 }}>ช่วงเวลา</span>
          {presets.map(p => (
            <button key={p.k} onClick={() => applyPreset(p.k)}
              style={{ ...btnStyle(preset === p.k ? "primary" : "ghost"), fontSize:12.5, padding:"6px 14px" }}>
              {p.l}
            </button>
          ))}
        </div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:12, alignItems:"center" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <label style={{ ...lblStyle, marginBottom:0 }}>ตั้งแต่</label>
            <input type="date" style={{ ...inpStyle, width:160 }} value={fromDate}
              onChange={e => { setFrom(e.target.value); setPreset("custom"); }} />
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <label style={{ ...lblStyle, marginBottom:0 }}>ถึง</label>
            <input type="date" style={{ ...inpStyle, width:160 }} value={toDate}
              onChange={e => { setTo(e.target.value); setPreset("custom"); }} />
          </div>
          <input style={{ ...inpStyle, maxWidth:220, marginLeft:"auto" }}
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="ค้นหาชื่อ หรือรหัสนิสิต…" />
        </div>
      </div>

      {/* Stats strip */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14, marginBottom:20 }}>
        {[
          { label:"นิสิตที่มีการจอง", value:rows.length,  color:C.accent,    bg:C.accentLight },
          { label:"จองทั้งหมด",       value:totalRes,     color:C.ink,       bg:C.soft },
          { label:"ผี 👻 ทั้งหมด",    value:totalGhost,   color:"#7c3aed",   bg:"#fdf4ff" },
          { label:"แอดมินเพิ่ม 🔑",   value:totalAdmin,   color:"#92400e",   bg:"#fef3c7" },
        ].map(s => (
          <div key={s.label} style={{ ...cardStyle, padding:"16px 20px", textAlign:"center" }}>
            <div style={{ fontSize:26, fontWeight:700, color:s.color, fontFamily:"'Cormorant Garamond',serif" }}>{s.value}</div>
            <div style={{ fontSize:12, color:C.muted, marginTop:3 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div style={{ ...cardStyle, padding:0, overflow:"hidden" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 18px", borderBottom:`1px solid ${C.line}` }}>
          <span style={{ fontSize:13.5, fontWeight:600 }}>
            {rows.length} นิสิต · {presetLabel}
          </span>
          <button
            style={{ ...btnStyle("primary"), padding:"7px 16px", fontSize:12.5 }}
            onClick={() => printStudentSummaryReport({ rows, fromDate, toDate, periodLabel:presetLabel })}>
            🖨 พิมพ์รายงาน
          </button>
        </div>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle("name"), textAlign:"left", width:40, paddingLeft:18 }}>#</th>
                <th style={{ ...thStyle("name"), textAlign:"left" }} onClick={() => toggleSort("name")}>
                  ชื่อนิสิต <SortIcon col="name" />
                </th>
                <th style={{ ...thStyle("id"), textAlign:"left" }} onClick={() => toggleSort("id")}>
                  รหัส <SortIcon col="id" />
                </th>
                <th style={{ ...thStyle("program"), textAlign:"left" }} onClick={() => toggleSort("program")}>
                  หลักสูตร <SortIcon col="program" />
                </th>
                <th style={thStyle("total")} onClick={() => toggleSort("total")}>
                  จองทั้งหมด <SortIcon col="total" />
                </th>
                <th style={{ ...thStyle("ghost"), color: sortCol === "ghost" ? "#7c3aed" : C.muted }} onClick={() => toggleSort("ghost")}>
                  ผี 👻 <SortIcon col="ghost" />
                </th>
                <th style={thStyle("normal")} onClick={() => toggleSort("normal")}>
                  ปกติ <SortIcon col="normal" />
                </th>
                <th style={{ ...thStyle("adminAdded"), color: sortCol === "adminAdded" ? "#92400e" : C.muted }} onClick={() => toggleSort("adminAdded")}>
                  แอดมินเพิ่ม 🔑 <SortIcon col="adminAdded" />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={8} style={{ padding:"40px", textAlign:"center", color:C.muted }}>
                  ไม่พบข้อมูลการจองในช่วงเวลาที่เลือก
                </td></tr>
              ) : rows.map((r, i) => (
                <tr key={r.id} style={{ borderBottom:`1px solid ${C.line}` }}
                  onMouseEnter={e => e.currentTarget.style.background = C.soft}
                  onMouseLeave={e => e.currentTarget.style.background = ""}>
                  <td style={{ padding:"10px 14px 10px 18px", color:C.faint, fontSize:12 }}>{i + 1}</td>
                  <td style={{ padding:"10px 14px", fontWeight:500 }}>{r.name}</td>
                  <td style={{ padding:"10px 14px", color:C.muted, fontFamily:"monospace", fontSize:12.5 }}>{r.id}</td>
                  <td style={{ padding:"10px 14px" }}>
                    {r.program !== "—" ? <Badge t="active">{r.program}</Badge> : <span style={{ color:C.faint }}>—</span>}
                  </td>
                  {numCell(r.total, false)}
                  {numCell(r.ghost, true)}
                  {numCell(r.normal, false)}
                  {numCell(r.adminAdded, false, "#92400e", "#fef3c7")}
                </tr>
              ))}
              {rows.length > 0 && (
                <tr style={{ borderTop:`2px solid ${C.line}`, background:C.soft }}>
                  <td colSpan={4} style={{ padding:"10px 14px 10px 18px", fontWeight:700, fontSize:12.5, color:C.muted, textTransform:"uppercase", letterSpacing:.4 }}>รวม</td>
                  <td style={{ padding:"10px 14px", textAlign:"right", fontWeight:700 }}>{totalRes}</td>
                  <td style={{ padding:"10px 14px", textAlign:"right", fontWeight:700, color:"#7c3aed" }}>{totalGhost}</td>
                  <td style={{ padding:"10px 14px", textAlign:"right", fontWeight:700 }}>{totalNorm}</td>
                  <td style={{ padding:"10px 14px", textAlign:"right", fontWeight:700, color:"#92400e" }}>{totalAdmin}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ═══ ADMIN ADD RESERVATION MODAL ════════════════════════════════════════════════
   Allows admin to manually create a reservation on behalf of any student.
   Bypasses all time restrictions (booking cutoff, weekends, Wednesday afternoons).
   The reservation is flagged with addedByAdmin: true.
   ══════════════════════════════════════════════════════════════════════════════ */
function AdminAddReservationModal({ units, students, reservations, onConfirm, onClose }) {
  const allDates = Array.from({length:60}, (_,i) => {
    const d = new Date(today); d.setDate(d.getDate() + i - 7); return getLocalISO(d);
  }).filter(d => !isWeekend(d));

  const [date,        setDate]        = useState(next14Days[0]);
  const [session,     setSession]     = useState("morning");
  const [unitId,      setUnitId]      = useState("");
  const [studentId,   setStudentId]   = useState("");
  const [patientName, setPatientName] = useState("");
  const [hn,          setHn]          = useState("");
  const [treatment,   setTreatment]   = useState("");
  const [err,         setErr]         = useState("");

  const activeUnits = units.filter(u => u.status === "active");
  const availSess   = ["morning", ...(isWednesday(date) ? [] : ["afternoon"])];

  const existingBks = unitId
    ? reservations.filter(r => r.date === date && r.session === session && r.unitId === Number(unitId) && r.status !== "cancelled")
    : [];
  const overbooked = existingBks.length > 0;

  const submit = () => {
    setErr("");
    if (!unitId)             return setErr("กรุณาเลือกยูนิต");
    if (!studentId)          return setErr("กรุณาเลือกนิสิต");
    if (!patientName.trim()) return setErr("กรุณากรอกชื่อผู้ป่วย");
    if (!hn.trim())          return setErr("กรุณากรอก HN");
    if (!treatment.trim())   return setErr("กรุณากรอกการรักษา");
    const unit    = units.find(u => u.id === Number(unitId));
    const student = students.find(s => s.id === studentId);
    onConfirm({ unit, student, date, session, patientName, hn, treatment, overbooked });
  };

  return (
    <Modal title="➕ เพิ่มการจองโดยแอดมิน" onClose={onClose} wide>
      <div style={{ background:"#fffbeb", border:"1px solid #fcd34d", borderRadius:8, padding:"10px 14px", marginBottom:18, fontSize:13, color:"#92400e" }}>
        <strong>🔑 สิทธิ์แอดมิน:</strong> การจองนี้จะถูกบันทึกว่า <strong>"เพิ่มโดยแอดมิน"</strong> และไม่มีข้อจำกัดด้านเวลา
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
        <div>
          <label style={lblStyle}>วันที่ *</label>
          <select value={date} onChange={e => { setDate(e.target.value); setSession("morning"); }} style={inpStyle}>
            {allDates.map(d => <option key={d} value={d}>{displayDate(d)}{d === todayStr ? " (วันนี้)" : ""}</option>)}
          </select>
        </div>
        <div>
          <label style={lblStyle}>ช่วงเวลา *</label>
          <select value={session} onChange={e => setSession(e.target.value)} style={inpStyle}>
            {availSess.map(s => <option key={s} value={s}>{s === "morning" ? "☀ ช่วงเช้า 09:00–12:00" : "🌤 ช่วงบ่าย 13:00–16:00"}</option>)}
          </select>
        </div>
        <div>
          <label style={lblStyle}>ยูนิต *</label>
          <select value={unitId} onChange={e => setUnitId(e.target.value)} style={inpStyle}>
            <option value="">— เลือกยูนิต —</option>
            {activeUnits.sort((a,b) => a.id - b.id).map(u => {
              const bks = reservations.filter(r => r.date === date && r.session === session && r.unitId === u.id && r.status !== "cancelled").length;
              return <option key={u.id} value={u.id}>{u.name} (Zone {u.zone}){bks > 0 ? ` ⚠ จองแล้ว ${bks}` : ""}</option>;
            })}
          </select>
        </div>
        <div>
          <label style={lblStyle}>นิสิต *</label>
          <select value={studentId} onChange={e => setStudentId(e.target.value)} style={inpStyle}>
            <option value="">— เลือกนิสิต —</option>
            {students.filter(s => s.active !== false).map(s => (
              <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
            ))}
          </select>
        </div>
      </div>
      {overbooked && (
        <div style={{ background:C.amberBg, border:`1px solid ${C.amberLine}`, borderRadius:8, padding:"9px 13px", marginBottom:14, fontSize:13 }}>
          ⚠ ยูนิตนี้มีการจองอยู่แล้ว {existingBks.length} รายการ การเพิ่มจะเป็น Overbook
        </div>
      )}
      <div style={{ display:"grid", gap:13 }}>
        <div>
          <label style={lblStyle}>ชื่อ-นามสกุลผู้ป่วย *</label>
          <input style={inpStyle} value={patientName} onChange={e => setPatientName(e.target.value)} placeholder="เช่น สมชาย ทนารักษ์" />
        </div>
        <div>
          <label style={lblStyle}>HN *</label>
          <input style={inpStyle} value={hn} onChange={e => setHn(e.target.value)} placeholder="เช่น HN-20341" />
        </div>
        <div>
          <label style={lblStyle}>การรักษา / หัตถการ *</label>
          <input style={inpStyle} value={treatment} onChange={e => setTreatment(e.target.value)} placeholder="เช่น Composite Filling #36" />
        </div>
      </div>
      {err && <p style={{ margin:"12px 0 0", color:C.red, fontSize:13 }}>{err}</p>}
      <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:22 }}>
        <button style={btnStyle("ghost")} onClick={onClose}>ยกเลิก</button>
        <button style={{ ...btnStyle("primary"), background:"#92400e" }} onClick={submit}>➕ เพิ่มการจองโดยแอดมิน</button>
      </div>
    </Modal>
  );
}

function AdminReservationsPage({ reservations, units, students, onUpdateStatus, onAdminBook }) {
  const [tab, setTab]             = useState("upcoming");
  const [searchInput, setSearch]  = useState("");
  const [search, setDebouncedSearch] = useState("");
  const [detail, setDetail]       = useState(null);
  const [showAdd, setShowAdd]     = useState(false);

  useEffect(()=>{ const t=setTimeout(()=>setDebouncedSearch(searchInput),200); return ()=>clearTimeout(t); },[searchInput]);

  const all = reservations.filter(r=>new Date(r.date+"T12:00:00")>=threeMonthsAgo);
  const filtered = all.filter(r=>{
    if (tab==="upcoming")   return r.date>=todayStr&&r.status!=="cancelled";
    if (tab==="today")      return r.date===todayStr;
    if (tab==="overbooked") return r.overbooked&&r.status!=="cancelled";
    if (tab==="past")       return r.date<todayStr;
    return true;
  }).filter(r=>!search||[r.patientName,r.hn,r.studentName,r.id].some(v=>v?.toLowerCase().includes(search.toLowerCase())));

  return (
    <div>
      <div style={{ marginBottom:28, display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:12 }}>
        <div>
          <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>การจองทั้งหมด</h2>
          <p style={{ margin:0, color:C.muted, fontSize:14 }}>ประวัติ 3 เดือนย้อนหลัง · {all.length} รายการทั้งหมด</p>
        </div>
        <button style={{ ...btnStyle("primary"), background:"#92400e", padding:"9px 20px", fontSize:13, whiteSpace:"nowrap" }}
          onClick={() => setShowAdd(true)}>
          ➕ เพิ่มการจองโดยแอดมิน
        </button>
      </div>
      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
        {[["upcoming","รอดำเนินการ"],["today","วันนี้"],["overbooked","⚠ Overbook"],["past","ผ่านมาแล้ว"],["all","ทั้งหมด"]].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)} style={{ ...btnStyle(tab===k?"primary":"ghost"), fontSize:12.5 }}>{l}</button>
        ))}
        <input style={{ ...inpStyle, maxWidth:240, marginLeft:"auto" }} value={searchInput} onChange={e=>setSearch(e.target.value)} placeholder="ค้นหาผู้ป่วย, HN, นิสิต…" />
      </div>
      <div style={{ ...cardStyle, padding:0, overflow:"hidden" }}>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead><tr style={{ background:C.soft, borderBottom:`1px solid ${C.line}` }}>
              {["วันที่","ช่วง","ยูนิต","นิสิต","ผู้ป่วย","HN","การรักษา","สถานะ","ผี","ต่อยูนิต","แอดมิน",""].map(h=>(
                <th key={h} style={{ textAlign:"left", padding:"10px 14px", color:C.muted, fontWeight:600, fontSize:11.5, textTransform:"uppercase", letterSpacing:0.4, whiteSpace:"nowrap" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {filtered.length===0?(
                <tr><td colSpan={12} style={{ padding:"36px", textAlign:"center", color:C.muted }}>ไม่พบรายการจอง</td></tr>
              ):filtered.sort((a,b)=>b.date.localeCompare(a.date)).map(r=>{
                const unit = units.find(u=>u.id===r.unitId);
                return (
                  <tr key={r.id} style={{ borderBottom:`1px solid ${C.line}`, cursor:"pointer" }} onClick={()=>setDetail(r)}
                    onMouseEnter={e=>e.currentTarget.style.background=C.soft} onMouseLeave={e=>e.currentTarget.style.background=""}>
                    <td style={{ padding:"9px 14px", whiteSpace:"nowrap" }}>{displayDate(r.date)}</td>
                    <td style={{ padding:"9px 14px" }}><Badge t={r.session}>{r.session==="morning"?"เช้า":"บ่าย"}</Badge></td>
                    <td style={{ padding:"9px 14px", fontWeight:600 }}>{unit?.name}</td>
                    <td style={{ padding:"9px 14px" }}>{r.studentName}</td>
                    <td style={{ padding:"9px 14px" }}>{r.patientName}</td>
                    <td style={{ padding:"9px 14px", color:C.muted }}>{r.hn}</td>
                    <td style={{ padding:"9px 14px", maxWidth:150, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.treatment}</td>
                    <td style={{ padding:"9px 14px" }}><Badge t={r.overbooked?"overbooked":r.status}>{r.overbooked?"⚠ Over":r.status==="confirmed"?"ยืนยันแล้ว":r.status==="cancelled"?"ยกเลิก":"รอดำเนินการ"}</Badge></td>
                    <td style={{ padding:"9px 14px" }}>{r.isGhost?<span style={{ color:"#7c3aed", fontWeight:600 }}>👻</span>:<span style={{ color:C.faint }}>—</span>}</td>
                    <td style={{ padding:"9px 14px" }}>{r.inheritUnit?<span style={{ background:"#fffbeb", color:"#d97706", borderRadius:6, padding:"2px 8px", fontSize:11.5, fontWeight:600 }}>🔗 ต่อ</span>:<span style={{ color:C.faint }}>—</span>}</td>
                    <td style={{ padding:"9px 14px" }}>{r.addedByAdmin?<span style={{ background:"#fef3c7", color:"#92400e", borderRadius:6, padding:"2px 8px", fontSize:11, fontWeight:700 }}>🔑 แอดมิน</span>:<span style={{ color:C.faint }}>—</span>}</td>
                    <td style={{ padding:"9px 14px" }} onClick={e=>e.stopPropagation()}>
                      {r.status==="pending"&&<button style={{ ...btnStyle("primary"), padding:"5px 10px", fontSize:12 }} onClick={()=>onUpdateStatus(r.id,"confirmed")}>ยืนยัน</button>}
                      {r.status==="confirmed"&&r.date>=todayStr&&<button style={{ ...btnStyle("danger"), padding:"5px 10px", fontSize:12 }} onClick={()=>onUpdateStatus(r.id,"cancelled")}>ยกเลิก</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {detail&&(
        <Modal title="รายละเอียดการจอง" onClose={()=>setDetail(null)}>
          <div style={{ display:"grid", gap:10 }}>
            {[["รหัสการจอง",detail.id],["ยูนิต",units.find(u=>u.id===detail.unitId)?.name],["วันที่",displayDate(detail.date)],
              ["ช่วงเวลา",detail.session==="morning"?"เช้า 09:00–12:00":"บ่าย 13:00–16:00"],
              ["นิสิต",detail.studentName],["ผู้ป่วย",detail.patientName],["HN",detail.hn],
              ["การรักษา",detail.treatment],
              ["สถานะ",detail.status==="confirmed"?"ยืนยันแล้ว":detail.status==="cancelled"?"ยกเลิก":"รอดำเนินการ"],
              ["Overbooked",detail.overbooked?"⚠ ใช่":"ไม่มี"],
              ["ผี",detail.isGhost?"👻 ใช่":"ไม่ใช่"],
              ["ต่อยูนิต",detail.inheritUnit?"🔗 ใช่ — ใช้ยูนิตต่อจากนิสิตคนก่อน":"ไม่ใช่"],
              ["เพิ่มโดยแอดมิน",detail.addedByAdmin?"🔑 ใช่ — เพิ่มโดยผู้ดูแลระบบ":"ไม่ใช่"],
            ].map(([k,v])=>(
              <div key={k} style={{ display:"flex", paddingBottom:10, borderBottom:`1px solid ${C.line}` }}>
                <span style={{ width:150, flexShrink:0, fontSize:12.5, color:C.muted, fontWeight:600, textTransform:"uppercase", letterSpacing:0.3 }}>{k}</span>
                <span style={{ fontSize:13.5 }}>{v}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {showAdd && (
        <AdminAddReservationModal
          units={units}
          students={students}
          reservations={reservations}
          onConfirm={({ unit, student, date, session, patientName, hn, treatment, overbooked }) => {
            onAdminBook({ unit, student, date, session, patientName, hn, treatment, overbooked });
            setShowAdd(false);
          }}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}

/* ═══ ADMIN MONTHLY LINEUP ═══════════════════════════════════════════════════════
   Admins set per-session zone assignments per day-of-week, per month, up to 3 months ahead.
   Shape: monthlyLineups["YYYY-MM"][dow]["morning"|"afternoon"] = [zoneA, zoneB, zoneC]
   Priority: per-day override > monthly lineup (dow) > auto-assign from schedule.
   ══════════════════════════════════════════════════════════════════════════════ */
function AdminMonthlyLineupPage({ advisors, monthlyLineups, setMonthlyLineups, setSessAdvs, notify }) {
  const baseYear  = today.getFullYear();
  const baseMonth = today.getMonth();
  const [curOffset, setCurOffset] = useState(0);
  // selectedDow: 1=Mon…5=Fri (null = show weekly overview)
  const [selectedDow, setSelectedDow] = useState(1);

  const curDate   = new Date(baseYear, baseMonth + curOffset, 1);
  const curYear   = curDate.getFullYear();
  const curMonth  = curDate.getMonth();

  const MONTH_TH  = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
                     "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  const monthKey  = `${curYear}-${String(curMonth + 1).padStart(2, "0")}`;
  const monthLabel= `${MONTH_TH[curMonth]} ${curYear + 543}`;
  const offsetLabel = ["(เดือนนี้)","(เดือนหน้า)","(อีก 2 เดือน)","(อีก 3 เดือน — ไกลสุด)"][curOffset];

  // DOW meta — dow 3 (พ) has no afternoon
  const DAYS = [
    { dow:1, label:"จันทร์",    short:"จ",  sessions:["morning","afternoon"] },
    { dow:2, label:"อังคาร",   short:"อ",  sessions:["morning","afternoon"] },
    { dow:3, label:"พุธ",      short:"พ",  sessions:["morning"] },
    { dow:4, label:"พฤหัสบดี", short:"พฤ", sessions:["morning","afternoon"] },
    { dow:5, label:"ศุกร์",    short:"ศ",  sessions:["morning","afternoon"] },
  ];
  const SESS_META = {
    morning:   { label:"เช้า 09:00–12:00",  icon:"☀", bg:"#eff6ff", color:"#1d4ed8" },
    afternoon: { label:"บ่าย 13:00–16:00",  icon:"🌤", bg:"#faf5ff", color:"#6b21a8" },
  };

  // Helper: get slot from state
  const getSlot = (dow, sess) =>
    monthlyLineups[monthKey]?.[dow]?.[sess] || ["","",""];

  // Draft state — keyed by "dow__sess"
  const buildInitDraft = () => {
    const d = {};
    DAYS.forEach(({ dow, sessions }) => {
      sessions.forEach(sess => {
        d[`${dow}__${sess}`] = [...getSlot(dow, sess)];
      });
    });
    return d;
  };
  const [draft, setDraft] = useState(buildInitDraft);

  // Reset draft when month changes
  useEffect(() => {
    setDraft(buildInitDraft());
  }, [curOffset, monthKey, monthlyLineups]);

  const updateDraft = (dow, sess, zoneIdx, advId) => {
    const k = `${dow}__${sess}`;
    setDraft(prev => {
      const slot = [...(prev[k] || ["","",""])];
      slot[zoneIdx] = advId;
      return { ...prev, [k]: slot };
    });
  };

  const saveSlot = async (dow, sess) => {
    const k    = `${dow}__${sess}`;
    const ids  = draft[k] || ["","",""];
    const prevLineups = { ...monthlyLineups };
    const prevMonth   = monthlyLineups[monthKey] || {};
    const prevDow     = prevMonth[dow] || { morning:["","",""], afternoon:["","",""] };
    const newDowData  = { ...prevDow, [sess]: [...ids] };
    const newLineups  = {
      ...monthlyLineups,
      [monthKey]: { ...prevMonth, [dow]: newDowData },
    };
    setMonthlyLineups(newLineups);
    setSessAdvs(() => buildSessionAdvisors(advisors, newLineups));
    const dayLabel = DAYS.find(d=>d.dow===dow)?.label || "";
    const sessLabel = sess === "morning" ? "เช้า" : "บ่าย";
    notify(`บันทึก ${dayLabel} ${sessLabel} — ${monthLabel} (กำลังบันทึกพื้นหลัง)`);
    try {
      const fullDow = newLineups[monthKey][dow];
      await SheetsDB.saveMonthlyLineup(monthKey, dow, fullDow.morning || ["","",""], fullDow.afternoon || ["","",""]);
      notify(`✓ บันทึก ${dayLabel} ${sessLabel} — ${monthLabel} เรียบร้อยแล้ว`);
    } catch (e) {
      setMonthlyLineups(prevLineups);
      notify(`⚠ บันทึกไม่สำเร็จ: ${e.message}`, true);
    }
  };

  const clearSlot = async (dow, sess) => {
    const k = `${dow}__${sess}`;
    setDraft(prev => ({ ...prev, [k]: ["","",""] }));
    const prevLineups = { ...monthlyLineups };
    const prevMonth   = monthlyLineups[monthKey] || {};
    const prevDow     = prevMonth[dow] || { morning:["","",""], afternoon:["","",""] };
    const newDowData  = { ...prevDow, [sess]: ["","",""] };
    const newLineups  = {
      ...monthlyLineups,
      [monthKey]: { ...prevMonth, [dow]: newDowData },
    };
    setMonthlyLineups(newLineups);
    setSessAdvs(() => buildSessionAdvisors(advisors, newLineups));
    try {
      const fullDow = newLineups[monthKey][dow];
      await SheetsDB.saveMonthlyLineup(monthKey, dow, fullDow.morning || ["","",""], fullDow.afternoon || ["","",""]);
    } catch (e) {
      setMonthlyLineups(prevLineups);
      notify(`⚠ บันทึกไม่สำเร็จ: ${e.message}`, true);
    }
  };

  // Calendar preview helpers
  const daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
  const firstDow    = new Date(curYear, curMonth, 1).getDay();
  const getDowOfDay = (d) => new Date(curYear, curMonth, d).getDay();

  const selDay = DAYS.find(d => d.dow === selectedDow);

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom:20 }}>
        <h2 style={{ margin:"0 0 4px", fontFamily:"'Cormorant Garamond',serif", fontSize:27, fontWeight:600 }}>ตารางเวรอาจารย์ประจำเดือน</h2>
        <p style={{ margin:0, color:C.muted, fontSize:14 }}>กำหนด Zone assignment รายวัน-ในสัปดาห์ ล่วงหน้าได้ 3 เดือน · Per-day override มีความสำคัญสูงกว่าเสมอ</p>
      </div>

      {/* Priority legend */}
      <div style={{ ...cardStyle, marginBottom:20, padding:"10px 18px", background:C.soft }}>
        <div style={{ display:"flex", gap:16, flexWrap:"wrap", alignItems:"center" }}>
          <span style={{ fontSize:12, fontWeight:600, color:C.muted }}>ลำดับความสำคัญ (สูง → ต่ำ):</span>
          {[["🔧 Per-day override",C.amberBg,C.amber],["📅 Monthly lineup (หน้านี้)",C.accentLight,C.accent],["⚙ Auto-assign จากตาราง",C.soft,C.muted]].map(([l,bg,c])=>(
            <span key={l} style={{ background:bg, color:c, borderRadius:99, padding:"2px 10px", fontSize:11.5, fontWeight:500 }}>{l}</span>
          ))}
        </div>
      </div>

      {/* Month navigation */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
        <button disabled={curOffset<=0} onClick={()=>setCurOffset(o=>o-1)}
          style={{ ...btnStyle("ghost"), padding:"7px 12px", opacity:curOffset<=0?0.3:1 }}>←</button>
        <div>
          <span style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, fontWeight:600 }}>{monthLabel}</span>
          <span style={{ marginLeft:10, fontSize:13, color:C.muted }}>{offsetLabel}</span>
        </div>
        <button disabled={curOffset>=3} onClick={()=>setCurOffset(o=>o+1)}
          style={{ ...btnStyle("ghost"), padding:"7px 12px", opacity:curOffset>=3?0.3:1 }}>→</button>
      </div>

      {/* Day-of-week tabs + detail panel side-by-side */}
      <div style={{ display:"grid", gridTemplateColumns:"200px 1fr", gap:16, alignItems:"start" }}>

        {/* Left: DOW tab list */}
        <div style={{ ...cardStyle, padding:0, overflow:"hidden" }}>
          <div style={{ padding:"12px 16px", background:C.soft, borderBottom:`1px solid ${C.line}` }}>
            <span style={{ fontSize:12, fontWeight:600, color:C.muted, textTransform:"uppercase", letterSpacing:0.5 }}>วันในสัปดาห์</span>
          </div>
          {DAYS.map(({ dow, label, short, sessions:dowSessions }) => {
            const isActive = selectedDow === dow;
            // Count how many slots are set for this dow
            const setCount = dowSessions.reduce((n, sess) => {
              const k = `${dow}__${sess}`;
              return n + (draft[k]?.some(x=>x) ? 1 : 0);
            }, 0);
            const totalSlots = dowSessions.length;
            return (
              <button key={dow} onClick={() => setSelectedDow(dow)}
                style={{ display:"flex", alignItems:"center", justifyContent:"space-between", width:"100%", padding:"13px 16px",
                  border:"none", borderBottom:`1px solid ${C.line}`, cursor:"pointer", textAlign:"left",
                  background: isActive ? C.accentLight : "#fff",
                  borderLeft: isActive ? `3px solid ${C.accent}` : "3px solid transparent",
                  transition:"all .12s" }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:isActive?600:400, color:isActive?C.accent:C.ink }}>{label}</div>
                  {dow===3 && <div style={{ fontSize:11, color:C.faint }}>เช้าอย่างเดียว</div>}
                </div>
                <span style={{ fontSize:11, fontWeight:500,
                  color: setCount===totalSlots ? C.green : setCount>0 ? C.amber : C.faint,
                  background: setCount===totalSlots ? C.greenBg : setCount>0 ? C.amberBg : "transparent",
                  borderRadius:99, padding: setCount>0 ? "2px 7px" : "0" }}>
                  {setCount>0 ? `${setCount}/${totalSlots}` : "—"}
                </span>
              </button>
            );
          })}
        </div>

        {/* Right: Session detail for selected DOW */}
        <div>
          {selDay && (
            <div>
              {/* DOW header */}
              <div style={{ ...cardStyle, marginBottom:12, padding:"14px 20px", display:"flex", alignItems:"center", gap:12, background:C.accentLight }}>
                <span style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, fontWeight:600, color:C.accent }}>วัน{selDay.label}</span>
                {selDay.dow===3 && (
                  <span style={{ fontSize:12, color:C.amber, background:C.amberBg, borderRadius:99, padding:"2px 10px" }}>วันพุธ — เช้าเท่านั้น</span>
                )}
              </div>

              {/* Session blocks */}
              {selDay.sessions.map(sess => {
                const k    = `${selDay.dow}__${sess}`;
                const sm   = SESS_META[sess];
                const isSet = draft[k]?.some(x=>x);
                return (
                  <div key={sess} style={{ ...cardStyle, marginBottom:12, padding:0, overflow:"hidden" }}>
                    {/* Session header */}
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"11px 18px", background:C.soft, borderBottom:`1px solid ${C.line}` }}>
                      <span style={{ background:sm.bg, color:sm.color, borderRadius:99, padding:"3px 12px", fontSize:12.5, fontWeight:600 }}>
                        {sm.icon} {sm.label}
                      </span>
                      <span style={{ background:isSet?C.greenBg:C.soft, color:isSet?C.green:C.faint, borderRadius:99, padding:"2px 10px", fontSize:12, fontWeight:500 }}>
                        {isSet ? "✓ ตั้งค่าแล้ว" : "fallback → auto-assign"}
                      </span>
                    </div>

                    {/* Zone selectors */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", borderBottom:`1px solid ${C.line}` }}>
                      {[0,1,2].map(z => {
                        const advId = draft[k]?.[z] || "";
                        return (
                          <div key={z} style={{ padding:"14px 18px", borderRight:z<2?`1px solid ${C.line}`:"none" }}>
                            <label style={{ ...lblStyle, marginBottom:6 }}>
                              Zone {["A","B","C"][z]}
                              <span style={{ fontWeight:400, marginLeft:5, color:C.faint, fontSize:11 }}>ยูนิต {z*8+1}–{z*8+8}</span>
                            </label>
                            <select style={inpStyle} value={advId}
                              onChange={e => updateDraft(selDay.dow, sess, z, e.target.value)}>
                              <option value="">— fallback —</option>
                              {advisors.map(a => (
                                <option key={a.id} value={a.id}>{a.name}</option>
                              ))}
                            </select>
                            {advId ? (
                              <p style={{ margin:"5px 0 0", fontSize:12, fontWeight:500, color:C.accent }}>
                                ✓ {advisors.find(a=>a.id===advId)?.name}
                              </p>
                            ) : (
                              <p style={{ margin:"5px 0 0", fontSize:11.5, color:C.faint, fontStyle:"italic" }}>auto-assign</p>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Actions */}
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 18px" }}>
                      <p style={{ margin:0, fontSize:12, color:C.muted }}>
                        ใช้กับทุกวัน{selDay.label}ใน{monthLabel}
                      </p>
                      <div style={{ display:"flex", gap:8 }}>
                        <button style={{ ...btnStyle("ghost"), fontSize:12 }} onClick={() => clearSlot(selDay.dow, sess)}>ล้าง</button>
                        <button style={{ ...btnStyle("primary"), fontSize:12 }} onClick={() => saveSlot(selDay.dow, sess)}>
                          บันทึก{sess==="morning"?"เช้า":"บ่าย"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Calendar preview */}
      <div style={{ ...cardStyle, marginTop:20 }}>
        <h3 style={{ margin:"0 0 14px", fontSize:14, fontWeight:600 }}>ตัวอย่างปฏิทิน — {monthLabel}</h3>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:3, marginBottom:10 }}>
          {["อา","จ","อ","พ","พฤ","ศ","ส"].map(d=>(
            <div key={d} style={{ textAlign:"center", fontSize:11, fontWeight:600, color:C.muted, padding:"3px 0" }}>{d}</div>
          ))}
          {Array.from({length:firstDow},(_,i)=><div key={`e-${i}`}/>)}
          {Array.from({length:daysInMonth},(_,i)=>{
            const d   = i+1;
            const dow = getDowOfDay(d);
            const isWE = dow===0||dow===6;
            const isW  = dow===3;
            const mSlot = draft[`${dow}__morning`];
            const aSlot = draft[`${dow}__afternoon`];
            const mSet  = !isWE && mSlot?.some(x=>x);
            const aSet  = !isWE && !isW && aSlot?.some(x=>x);
            const isSelDow = dow===selectedDow;
            return (
              <div key={d} style={{ background:isWE?C.soft:isSelDow?"#f0f4ff":"#fff",
                border:`1px solid ${isSelDow&&!isWE?C.accent:C.line}`,
                borderRadius:7, padding:"4px 5px", minHeight:48, opacity:isWE?0.4:1 }}>
                <div style={{ fontSize:10.5, fontWeight:600, color:isSelDow&&!isWE?C.accent:C.muted, textAlign:"right", marginBottom:2 }}>{d}</div>
                {!isWE&&(
                  <div style={{ display:"flex", flexDirection:"column", gap:1.5 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:2 }}>
                      <span style={{ width:5, height:5, borderRadius:"50%", background:mSet?"#378ADD":C.faint, display:"block", flexShrink:0 }}/>
                      <span style={{ fontSize:9, color:mSet?"#1d4ed8":C.faint }}>M{isW?"*":""}</span>
                    </div>
                    {!isW&&(
                      <div style={{ display:"flex", alignItems:"center", gap:2 }}>
                        <span style={{ width:5, height:5, borderRadius:"50%", background:aSet?"#7c3aed":C.faint, display:"block", flexShrink:0 }}/>
                        <span style={{ fontSize:9, color:aSet?"#6b21a8":C.faint }}>A</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display:"flex", gap:14, flexWrap:"wrap", fontSize:11.5, color:C.muted, paddingTop:8, borderTop:`1px solid ${C.line}` }}>
          <span><span style={{ width:7,height:7,borderRadius:"50%",background:"#378ADD",display:"inline-block",marginRight:3 }}/>เช้า ตั้งค่าแล้ว</span>
          <span><span style={{ width:7,height:7,borderRadius:"50%",background:"#7c3aed",display:"inline-block",marginRight:3 }}/>บ่าย ตั้งค่าแล้ว</span>
          <span><span style={{ width:7,height:7,borderRadius:"50%",background:C.faint,display:"inline-block",marginRight:3 }}/>fallback</span>
          <span style={{ background:C.accentLight, color:C.accent, borderRadius:4, padding:"1px 7px" }}>วันที่ไฮไลท์ = วัน{selDay?.label}ที่เลือก</span>
          <span style={{ marginLeft:"auto" }}>* = วันพุธ (เฉพาะเช้า)</span>
        </div>
      </div>
    </div>
  );
}

/* ═══ SIDEBAR ════════════════════════════════════════════════════════════════════ */
function Sidebar({ user, page, setPage, onLogout, onRefresh, onChangePassword }) {
  const [showPwModal, setShowPwModal] = useState(false);

  const nav = user.role === "student"
    ? [
        { k: "browse", i: "⊞", l: "จองยูนิต" },
        { k: "overview", i: "◎", l: "ภาพรวมยูนิต" },
        { k: "equip-browse", i: "🔬", l: "จองอุปกรณ์" },
        { k: "my-res", i: "📋", l: "การจองของฉัน" }
      ]
    : user.role === "advisor"
    ? [
        { k: "browse", i: "⊞", l: "จองยูนิต" },
        { k: "equip-browse", i: "🔬", l: "จองอุปกรณ์" },
        { k: "my-res", i: "📋", l: "การจอง" }
      ]
    : [
        { k: "admin-overview", i: "◎", l: "ภาพรวม" },
        { k: "admin-summary", i: "📊", l: "สรุปรายนิสิต" },
        { isHeader: true, l: "ยูนิต (Units)" },
        { k: "admin-units", i: "⊞", l: "จัดการยูนิต" },
        { k: "admin-res", i: "📋", l: "การจองยูนิต" },
        { isHeader: true, l: "อุปกรณ์ (Equipment)" },
        { k: "admin-equipment", i: "🔬", l: "จัดการอุปกรณ์" },
        { k: "admin-equip-res", i: "📋", l: "การจองอุปกรณ์" },
        { isHeader: true, l: "ระบบและบุคลากร" },
        { k: "admin-session-advisors", i: "👨‍⚕️", l: "อาจารย์นิเทศ" },
        { k: "admin-monthly-lineup", i: "📅", l: "ตารางเวร" },
        { k: "admin-users", i: "👥", l: "จัดการผู้ใช้" }
      ];

  return (
    <aside
      style={{
        width: 235,
        background: C.ink,
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0
      }}
    >
      <div
        style={{
          padding: "24px 20px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.07)"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🦷</span>
          <span
            style={{
              fontFamily: "'Cormorant Garamond',serif",
              color: "#fff",
              fontSize: 22,
              fontWeight: 600
            }}
          >
            CUProstho
          </span>
        </div>

        <p
          style={{
            margin: "5px 0 0",
            fontSize: 10.5,
            color: "rgba(255,255,255,0.25)",
            letterSpacing: 0.7,
            textTransform: "uppercase"
          }}
        >
          คณะทันตแพทยศาสตร์
        </p>
      </div>

      <nav style={{ padding: "14px 10px", flex: 1, overflowY: "auto" }}>
        {nav.map((x, idx) => 
          x.isHeader ? (
            <div key={`header-${idx}`} style={{ padding: "18px 12px 6px", fontSize: 11, color: "rgba(255,255,255,0.25)", letterSpacing: 0.5, textTransform: "uppercase", fontWeight: 500 }}>
              {x.l}
            </div>
          ) : (
            <button
              key={x.k}
              onClick={() => setPage(x.k)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "9px 12px",
                borderRadius: 8,
                border: "none",
                cursor: "pointer",
                fontFamily: "'Sarabun','Outfit',sans-serif",
                fontSize: 13.5,
                fontWeight: page === x.k ? 500 : 400,
                background:
                  page === x.k
                    ? "rgba(255,255,255,0.1)"
                    : "transparent",
                color:
                  page === x.k
                    ? "#fff"
                    : "rgba(255,255,255,0.4)",
                transition: "all .15s",
                marginBottom: 2,
                textAlign: "left"
              }}
            >
              <span style={{ fontSize: 14 }}>{x.i}</span>
              {x.l}
            </button>
          )
        )}
      </nav>

      <div
        style={{
          padding: "14px 20px 20px",
          borderTop: "1px solid rgba(255,255,255,0.07)"
        }}
      >
        <p
          style={{
            margin: "0 0 1px",
            fontSize: 13.5,
            fontWeight: 500,
            color: "#fff"
          }}
        >
          {user.name}
        </p>

        <p
          style={{
            margin: "0 0 12px",
            fontSize: 12,
            color: "rgba(255,255,255,0.3)"
          }}
        >
          {user.role === "admin"
            ? "ผู้ดูแลระบบ"
            : user.role === "advisor"
            ? "อาจารย์นิเทศ"
            : PROGRAM_LABELS[user.program] || user.program}

          {user.role === "student" && user.enrollYear && (
            <span style={{ display: "block", marginTop: 2 }}>
              ชั้นปีที่ {getClassYear(user.enrollYear)} · รุ่น {user.enrollYear}
            </span>
          )}
        </p>

        <button
          onClick={onRefresh}
          style={{
            ...btnStyle("ghost"),
            width: "100%",
            color: "rgba(255,255,255,0.9)",
            border: "1px solid rgba(255,255,255,0.2)",
            fontSize: 12.5,
            marginBottom: 8
          }}
        >
          ↻ รีเฟรชข้อมูล
        </button>

        {(user.role === "student" || user.role === "advisor") && (
          <button
            onClick={() => setShowPwModal(true)}
            style={{
              ...btnStyle("ghost"),
              width: "100%",
              color: "rgba(255,255,255,0.7)",
              border: "1px solid rgba(255,255,255,0.15)",
              fontSize: 12.5,
              marginBottom: 8
            }}
          >
            🔑 เปลี่ยนรหัสผ่าน
          </button>
        )}

        <button
          onClick={onLogout}
          style={{
            ...btnStyle("ghost"),
            width: "100%",
            color: "rgba(255,255,255,0.35)",
            border: "1px solid rgba(255,255,255,0.1)",
            fontSize: 12.5
          }}
        >
          ออกจากระบบ
        </button>
      </div>

      {showPwModal && (
        <ChangePasswordModal
          user={user}
          onSave={onChangePassword}
          onClose={() => setShowPwModal(false)}
        />
      )}
    </aside>
  );
}

/* ═══ APP ROOT ══════════════════════════════════════════════════════════════════ */

export default function App() {
  const [user, setUser]                   = useState(()=>loadSession());
  const [page, setPage]                   = useState(()=>{ const u=loadSession(); return u?(u.role==="admin"?"admin-overview":"browse"):"browse"; });
  const [loading, setLoading]             = useState(false);
  const [sheetsReady, setSheetsReady]     = useState(false); // true once first syncAll completes
  const [loadError, setLoadError]         = useState(null);
  const [advisors, setAdvisors]           = useState(SEED_ADVISORS);
  const [students, setStudents]           = useState(SEED_STUDENTS);
  const [admins, setAdmins]               = useState(SEED_ADMINS);
  const [units, setUnits]                 = useState(INIT_UNITS);
  const [reservations, setReservations]   = useState([]);
  const [sessionAdvisors, setSessAdvs]    = useState(()=>buildSessionAdvisors(SEED_ADVISORS, {}));
  const [monthlyLineups, setMonthlyLineups] = useState({});
  const [equipment, setEquipment]                     = useState(SEED_EQUIPMENT);
  const [equipmentReservations, setEquipmentReservations] = useState([]);
  const [toast, setToast]                 = useState(null);
  // Prevents duplicate concurrent syncAll calls (which cause GAS LockService to block for 30s)
  const syncInFlight = useRef(false);

  const notify = (text, warn=false) => setToast({text,warn});

  /* Load all data from Google Sheets.
     All derived state (sessionAdvisors) is computed BEFORE any setState call,
     then every setter fires in the same synchronous block so React batches
     them into a single re-render — eliminating the stale-advisor flash. */
  const loadFromSheets = async () => {
    // Drop duplicate calls — prevents second request from hitting GAS LockService (30s block)
    if (syncInFlight.current) return;
    syncInFlight.current = true;
  setLoading(true);
  setLoadError(null);
  try {
    const data = await SheetsDB.syncAll();
    // Priority: per-day override > monthly lineup > auto-assign
    // autoMap already encodes monthly lineup as the base (via buildSessionAdvisors).
    // data.sessionAdvisors contains ONLY explicit per-day overrides from Session_Advisors sheet,
    // so we spread it on top — but only for keys that are genuine overrides (non-empty advisor slot).
    const autoMap = buildSessionAdvisors(data.advisors, data.monthlyLineups || {});
    const freshSessAdvs = { ...autoMap };
    // Apply per-day overrides only where at least one advisor ID is explicitly set
    Object.entries(data.sessionAdvisors || {}).forEach(([key, ids]) => {
      if (ids.some(id => id)) freshSessAdvs[key] = ids;
    });
    
    setSheetsReady(true);
    setAdvisors(data.advisors);
    setStudents(data.students);
    setAdmins(data.admins);
    setMonthlyLineups(data.monthlyLineups || {});
    setSessAdvs(freshSessAdvs);

    // FIX: Merge sheet units with default overflow units
    const sheetUnits = data.units.map(u => ({
      ...u,
      overflow: u.overflow === true || u.overflow === "TRUE" || u.overflow === "true",
    }));

    // Check if the sheet is missing the overflow units (IDs 25-48)
    const finalUnits = [...sheetUnits];
    INIT_UNITS.filter(iu => iu.overflow).forEach(ovUnit => {
      if (!finalUnits.find(u => u.id === ovUnit.id)) {
        finalUnits.push(ovUnit); // Inject them back in if Sheets didn't have them
      }
    });

    setUnits(finalUnits);
setEquipment(data.equipment && data.equipment.length ? data.equipment : SEED_EQUIPMENT);
    setEquipmentReservations(data.equipmentReservations || []);
    // ... rest of the function (auto-archive, etc.)

      // ── Auto-archive reservations older than 18 months ────────────────────
      const toArchive = data.reservations.filter(
        r => r.date < eighteenMonthsAgoStr && r.status !== "cancelled"
      );
      const activeReservations = data.reservations.filter(
        r => r.date >= eighteenMonthsAgoStr
      );
      setReservations(activeReservations);
      // Fire-and-forget: mark each old reservation cancelled in Sheets.
      // Staggered by 500ms each to avoid simultaneous GAS requests competing
      // for LockService (which would cause each subsequent one to block for 30s).
      toArchive.forEach((r, i) => {
        setTimeout(() => {
          SheetsDB.updateReservationStatus(r.id, "cancelled").catch(err =>
            console.warn(`Archive ${r.id} failed:`, err)
          );
        }, i * 500);
      });
    } catch (error) {
      console.error("Sheets sync error:", error);
      setLoadError(error.message);
    } finally {
      setLoading(false);
      syncInFlight.current = false; // Always release so future calls can proceed
    }
  };

/* Initial load from Sheets on startup (Runs exactly ONCE) */
  useEffect(() => {
    loadFromSheets();
  }, []);
  useEffect(() => {
    const interval = setInterval(() => {
      const actualToday = getLocalISO(new Date());
      if (actualToday !== todayStr) {
        window.location.reload();
      }
    }, 300000); 
    
    return () => clearInterval(interval);
  }, []);
  const navigateTo = (p) => setPage(p);

  const login = (u) => {
    saveSession(u);
    setUser(u);
    setPage(u.role==="admin"?"admin-overview":"browse");
    // NOTE: loadFromSheets() is NOT called here.
    // The mount useEffect already runs it once on app start (before login),
    // so calling it again here would fire two simultaneous GAS requests,
    // causing the second one to wait 30s on LockService — the main cause of slow load.
  };

const bookingInFlight = useRef(false);

const book = async ({ unit, date, session, patientName, hn, treatment, overbooked, isGhost, inheritUnit }) => {
  if (bookingInFlight.current) {
    notify("⏳ การจองกำลังดำเนินการ กรุณารอสักครู่", true);
    return;
  }
  bookingInFlight.current = true;
  try {
    const newRes = {
      id: generateId("reservation", reservations), studentId:user.id, studentName:user.name,
      unitId:unit.id, date, session, patientName, hn, treatment,
      status:"confirmed", createdAt:todayStr, overbooked, isGhost: !!isGhost, inheritUnit: !!inheritUnit
    };
    setReservations(p=>[...p, newRes]);
    if (isGhost) notify(`👻 จองในฐานะ "ผี" — ยูนิต ${unit.name} — แจ้งผู้ดูแลระบบแล้ว`, true);
    else if (overbooked) notify(`⚠ Overbook: ยูนิต ${unit.name} — กำลังบันทึกพื้นหลัง`, true);
    else notify(`จองยูนิต ${unit.name} สำเร็จ — ${displayDate(date)} ${session==="morning"?"ช่วงเช้า":"ช่วงบ่าย"}`);
    try {
      await SheetsDB.writeReservation(newRes);
      notify(`✓ บันทึกการจองยูนิต ${unit.name} ลงฐานข้อมูลเสร็จสมบูรณ์`);
    } catch (error) {
      setReservations(p=>p.filter(r=>r.id!==newRes.id));
      notify(`⚠ การเชื่อมต่อขัดข้อง! ยกเลิกการจองยูนิต ${unit.name} แล้ว: ${error.message}`, true);
    }
  } finally {
    bookingInFlight.current = false;
  }
};

  const adminBook = async ({ unit, student, date, session, patientName, hn, treatment, overbooked }) => {
    const newRes = {
      id: generateId("reservation", reservations),
      studentId: student.id, studentName: student.name,
      unitId: unit.id, date, session, patientName, hn, treatment,
      status: "confirmed", createdAt: todayStr,
      overbooked: !!overbooked, isGhost: false, inheritUnit: false,
      addedByAdmin: true,
    };
    setReservations(p => [...p, newRes]);
    notify(`🔑 แอดมินเพิ่มการจอง ${unit.name} ให้ ${student.name} — กำลังบันทึก`);
    try {
      await SheetsDB.writeReservation(newRes);
      notify(`✓ บันทึกการจองโดยแอดมิน ยูนิต ${unit.name} เสร็จสมบูรณ์`);
    } catch (error) {
      setReservations(p => p.filter(r => r.id !== newRes.id));
      notify(`⚠ บันทึกไม่สำเร็จ: ${error.message}`, true);
    }
  };

  const editReservation = async (id, fields) => {
    const prev = [...reservations];
    setReservations(p=>p.map(r=>r.id===id?{...r,...fields}:r));
    notify("อัปเดตข้อมูลการจอง (กำลังบันทึกพื้นหลัง)");
    try {
      await SheetsDB.updateReservationFields(id, fields);
      notify("✓ อัปเดตข้อมูลการจองเรียบร้อยแล้ว");
    } catch (error) {
      setReservations(prev);
      notify(`⚠ อัปเดตไม่สำเร็จ ระบบคืนค่าเดิม: ${error.message}`, true);
    }
  };

  const cancel = async (id) => {
    const previousState = [...reservations];
    setReservations(p=>p.map(r=>r.id===id?{...r,status:"cancelled"}:r)); 
    notify("ยกเลิกการจองเรียบร้อยแล้ว");
    try {
      await SheetsDB.updateReservationStatus(id, "cancelled");
    } catch (error) {
      setReservations(previousState);
      notify(`⚠ ยกเลิกไม่สำเร็จ ระบบคืนค่าเดิม: ${error.message}`, true);
    }
  };
const bookEquipment = async ({ equipment: eq, date, timeSlot, duration = 1, purpose, caseHn }) => {
    const startIndex = EQUIP_TIME_SLOTS.indexOf(timeSlot);
    const slotsToBook = [];
    for(let i = 0; i < duration; i++) {
        slotsToBook.push(EQUIP_TIME_SLOTS[startIndex + i]);
    }

    let currentRes = [...equipmentReservations];
    const newReservations = [];
    for(const slot of slotsToBook) {
        const id = generateId("equipmentReservation", currentRes);
        const res = {
          id,
          studentId: user.id, studentName: user.name,
          equipmentId: eq.id, date, timeSlot: slot, purpose, caseHn: caseHn || "",
          status: "confirmed", createdAt: todayStr,
        };
        newReservations.push(res);
        currentRes.push(res);
    }

    setEquipmentReservations(currentRes);
    notify(`จอง ${eq.name} สำเร็จ ${duration} ชั่วโมง — ${displayDate(date)}`);
    
    try {
      for(const res of newReservations) {
        await SheetsDB.writeEquipmentReservation(res);
      }
      notify(`✓ บันทึกการจอง ${eq.name} ลงฐานข้อมูลเสร็จสมบูรณ์`);
    } catch (error) {
      setEquipmentReservations(p => p.filter(r => !newReservations.find(nr => nr.id === r.id)));
      notify(`⚠ การเชื่อมต่อขัดข้อง! ยกเลิกการจอง ${eq.name} แล้ว: ${error.message}`, true);
    }
  };

  const cancelEquipmentBooking = async (idOrIds) => {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    const prev = [...equipmentReservations];
    setEquipmentReservations(p => p.map(r => ids.includes(r.id) ? { ...r, status: "cancelled" } : r));
    notify("ยกเลิกการจองอุปกรณ์เรียบร้อยแล้ว");
    try {
      await Promise.all(ids.map(id => SheetsDB.updateEquipmentReservationStatus(id, "cancelled")));
    } catch (error) {
      setEquipmentReservations(prev);
      notify(`⚠ ยกเลิกไม่สำเร็จ: ${error.message}`, true);
    }
  };

  const updateEquipmentResStatus = async (idOrIds, status) => {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    const prev = [...equipmentReservations];
    setEquipmentReservations(p => p.map(r => ids.includes(r.id) ? { ...r, status } : r));
    const label = status === "returned" ? "รับคืนอุปกรณ์" : "อัปเดตสถานะ";
    notify(`${label}เรียบร้อยแล้ว`);
    try {
      await Promise.all(ids.map(id => SheetsDB.updateEquipmentReservationStatus(id, status)));
    } catch (error) {
      setEquipmentReservations(prev);
      notify(`⚠ ทำรายการไม่สำเร็จ: ${error.message}`, true);
    }
  };
  const updateStatus = async (id, status) => { 
    const previousState = [...reservations];
    setReservations(p=>p.map(r=>r.id===id?{...r,status}:r)); 
    notify(`การจองถูก${status==="confirmed"?"ยืนยัน":"ยกเลิก"}เรียบร้อยแล้ว`);
    try {
      await SheetsDB.updateReservationStatus(id, status);
    } catch (error) {
      setReservations(previousState);
      notify(`⚠ อัปเดตสถานะไม่สำเร็จ: ${error.message}`, true);
    }
  };
   
  const changePassword = async (newPassword) => {
    const updated = { ...user, password: newPassword };
    if (user.role === "student") {
      await SheetsDB.updateStudent(updated);
      setStudents(p => p.map(s => s.id === user.id ? { ...s, password: newPassword } : s));
    } else {
      await SheetsDB.updateAdvisor(updated);
      setAdvisors(p => p.map(a => a.id === user.id ? { ...a, password: newPassword } : a));
    }
    saveSession(updated);
    setUser(updated);
    notify("✓ เปลี่ยนรหัสผ่านเรียบร้อยแล้ว");
  };

  if (!user) return (
    <LoginPage
      onLogin={login}
      students={students}
      advisors={advisors}
      admins={admins}
      sheetsReady={sheetsReady}
      loadError={loadError}
      onRetry={loadFromSheets}
      onSyncReady={() => sheetsReady || !!loadError}
    />
  );

  return (
    <div style={{ fontFamily:"'Sarabun','Outfit',sans-serif", background:C.soft, minHeight:"100vh", display:"flex", color:C.ink }}>
      <Sidebar user={user} page={page} setPage={navigateTo} onLogout={()=>{ clearSession(); setUser(null); }} onRefresh={loadFromSheets} onChangePassword={changePassword} />
      <main style={{ flex:1, padding:"36px 40px", overflowY:"auto", position:"relative" }}>
        {loadError&&(
          <div style={{ background:C.redBg, border:`1px solid #fca5a5`, borderRadius:8, padding:"10px 16px", marginBottom:20, fontSize:13, color:C.red, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span>⚠ โหลดข้อมูลจาก Google Sheets ไม่สำเร็จ: {loadError}</span>
            <button onClick={loadFromSheets} style={{ ...btnStyle("ghost"), fontSize:12, padding:"4px 10px", color:C.red, border:`1px solid #fca5a5` }}>ลองใหม่</button>
          </div>
        )}
        {page==="browse"            && <BrowsePage reservations={reservations} user={user} units={units} advisors={advisors} sessionAdvisors={sessionAdvisors} onBook={book} />}
        {page==="overview"          && <BrowsePage reservations={reservations} user={{...user, role:"overview"}} units={units} advisors={advisors} sessionAdvisors={sessionAdvisors} onBook={book} />}
        {page==="my-res"            && <MyReservationsPage reservations={reservations} user={user} units={units} sessionAdvisors={sessionAdvisors} advisors={advisors} onCancel={cancel} onEdit={editReservation} />}
        {page==="admin-overview"    && <AdminOverview reservations={reservations} units={units} advisors={advisors} sessionAdvisors={sessionAdvisors} />}
        {page==="equip-browse"     && <EquipmentBrowsePage equipment={equipment} equipmentReservations={equipmentReservations} user={user} onBook={bookEquipment} onCancel={cancelEquipmentBooking} />}
        {page==="admin-equipment"  && <AdminEquipmentPage equipment={equipment} setEquipment={setEquipment} notify={notify} />}
        {page==="admin-equip-res"  && <AdminEquipmentReservationsPage equipmentReservations={equipmentReservations} equipment={equipment} onCancel={cancelEquipmentBooking} onUpdateStatus={updateEquipmentResStatus} />}
        {page==="admin-session-advisors" && <AdminSessionAdvisorsPage advisors={advisors} setAdvisors={setAdvisors} sessionAdvisors={sessionAdvisors} setSessionAdvisors={setSessAdvs} monthlyLineups={monthlyLineups} notify={notify} />}
        {page==="admin-monthly-lineup"   &&
          <AdminMonthlyLineupPage
            advisors={advisors}
            monthlyLineups={monthlyLineups}
            setMonthlyLineups={setMonthlyLineups}
            sessionAdvisors={sessionAdvisors}
            setSessAdvs={setSessAdvs}
            notify={notify}
          />
        }
        {page==="admin-users"       && <AdminManageUsersPage students={students} setStudents={setStudents} advisors={advisors} setAdvisors={setAdvisors} notify={notify} />}
        {page==="admin-units"       && <AdminUnitsPage units={units} setUnits={setUnits} advisors={advisors} sessionAdvisors={sessionAdvisors} reservations={reservations} notify={notify} />}
        {page==="admin-res"         && <AdminReservationsPage reservations={reservations} units={units} students={students} onUpdateStatus={updateStatus} onAdminBook={adminBook} />}
        {page==="admin-summary"     && <AdminStudentSummaryPage reservations={reservations} students={students} />}
      </main>
      {loading && <LoadingOverlay text="กำลังโหลดข้อมูลจาก Google Sheets…" />}
      {toast   && <Toast msg={toast} onClose={()=>setToast(null)} />}
    </div>
  );
}
