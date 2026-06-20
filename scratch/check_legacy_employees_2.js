require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });
  
  const [r] = await c.query("SELECT json_value FROM lff_app_state WHERE state_key = '@trackforce_employees'");
  if (r[0] && r[0].json_value) {
    const arr = JSON.parse(r[0].json_value);
    console.log("Legacy employees count:", arr.length);
    const superAdmins = arr.filter(e => JSON.stringify(e).toLowerCase().includes('superadmin'));
    console.log("Legacy SuperAdmins:", JSON.stringify(superAdmins, null, 2));
  } else {
    console.log("No legacy @trackforce_employees found.");
  }
  
  c.end();
}

run().catch(console.error);
