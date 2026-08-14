import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://qznrajnkzgqfsgxxdwit.supabase.co';
const supabaseKey = 'sb_publishable_pJvv2oNfWpz8U3x-HcyBFA_tdzbQmy7';

export const supabase = createClient(supabaseUrl, supabaseKey);
