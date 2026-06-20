require('dotenv').config();
const mysql = require('mysql2/promise');

async function fix() {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });
  
  // Fix Axion Meditech ID
  await c.query(`UPDATE lff_companies SET id = 'cmp_axion_meditech_and_life_science_pvt_ltd_195b321e' WHERE name = 'Axion Meditech'`);
  
  // Insert missing Lumina Meditech company
  try {
    await c.query(`
      INSERT INTO lff_companies (
        id, name, legal_name, industry, headquarters, primary_branch, support_email, support_phone,
        attendance_zone_label, created_at, updated_at
      ) VALUES (
        'cmp_lumina_meditech_7f3e019e', 'Lumina Meditech', 'Lumina Meditech', 'Medical', 'Ahmedabad', 'Main Branch', 'support@luminameditech.com', '9999999999',
        'Office', NOW(), NOW()
      )
    `);
    console.log("Inserted Lumina Meditech");
  } catch(e) {
    console.log("Lumina already exists or error: ", e.message);
  }
  
  const [cRows] = await c.query('SELECT id, name FROM lff_companies');
  console.log('Fixed COMPANIES:', cRows);
  
  c.end();
}

fix().catch(console.error);
