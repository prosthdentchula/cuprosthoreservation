const { SheetsDB } = require('./supabase-sync.js');

// A quick hack since supabase-sync.js is an ES module and we want to test it locally.
// Actually, let's just write a test script that uses dynamic import.
