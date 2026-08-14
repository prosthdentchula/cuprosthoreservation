const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = 'https://qznrajnkzgqfsgxxdwit.supabase.co';
const supabaseKey = 'sb_publishable_pJvv2oNfWpz8U3x-HcyBFA_tdzbQmy7';
const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  console.log("Fetching...");
  const res = await supabase.from('reservations').select('*');
  console.log("Reservations count:", res.data ? res.data.length : 0);
  if (res.error) console.error("Error:", res.error);
  
  const stud = await supabase.from('students').select('*');
  console.log("Students count:", stud.data ? stud.data.length : 0);
}
test();
