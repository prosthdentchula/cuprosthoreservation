import { SheetsDB } from './supabase-sync.js';

async function test() {
  console.log("Fetching syncAll()...");
  try {
    const data = await SheetsDB.syncAll();
    console.log("Advisors:", data.advisors.length);
    console.log("Students:", data.students.length);
    console.log("Units:", data.units.length);
    console.log("Reservations:", data.reservations.length);
    console.log("First Reservation:", data.reservations[0]);
  } catch (err) {
    console.error("Error during syncAll:", err);
  }
}

test();
