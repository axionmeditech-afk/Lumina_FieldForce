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
  
  // Update name to 'Axion Meditech and Life Science Pvt Ltd' if needed, though they just said 'axion meditech and life science krke hoga'
  // I will just delete the others.
  await c.query(`DELETE FROM lff_companies WHERE id != 'cmp_axion_meditech_and_life_science_pvt_ltd_195b321e'`);
  
  const [cRows] = await c.query('SELECT id, name FROM lff_companies');
  console.log('Remaining COMPANIES:', cRows);
  
  c.end();
}

fix().catch(console.error);
