require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('supabaseUrl is required.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;

console.log('SUPABASE_URL =', supabaseUrl ? '[SET]' : '[NOT SET]');
console.log('SUPABASE_KEY =', supabaseKey ? '[SET]' : '[NOT SET]');
