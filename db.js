// db.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Verificación de seguridad básica
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("⚠️ Error: Faltan las variables de entorno de Supabase.");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = supabase;