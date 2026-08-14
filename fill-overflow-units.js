const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://qznrajnkzgqfsgxxdwit.supabase.co';
const supabaseKey = 'sb_publishable_pJvv2oNfWpz8U3x-HcyBFA_tdzbQmy7';
const supabase = createClient(supabaseUrl, supabaseKey);

async function fillOverflowUnits() {
  console.log("Fetching existing units...");
  const { data: existingUnits, error: fetchError } = await supabase.from('units').select('id');
  if (fetchError) throw fetchError;
  
  const existingIds = new Set(existingUnits.map(u => u.id));
  const newUnits = [];

  // User specified up to 48 units
  for (let id = 1; id <= 48; id++) {
    if (!existingIds.has(id)) {
      newUnits.push({
        id: id,
        name: `Overflow Unit ${id}`,
        zone: 'Overflow',
        room: 'Overflow Zone',
        zone_idx: 3,
        status: 'active'
      });
    }
  }

  if (newUnits.length > 0) {
    console.log(`Creating ${newUnits.length} missing overflow units up to 48...`);
    const { error } = await supabase.from('units').upsert(newUnits, { onConflict: 'id' });
    if (error) throw error;
    console.log("Overflow units successfully created!");
  } else {
    console.log("All 48 units already exist. No action needed.");
  }
}

fillOverflowUnits().catch(console.error);
