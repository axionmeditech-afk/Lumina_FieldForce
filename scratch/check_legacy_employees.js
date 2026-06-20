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
  
  const [r] = await c.query("SELECT value_text FROM lff_app_state WHERE key_name = '@trackforce_employees'");
  console.log(r[0] ? r[0].value_text.slice(0, 1500) : 'none');
  
  // also check if there is a duplicate in DB users by running a full query on nmy5_user
  const [uRows] = await c.query("SELECT rowid, login, email, firstname, lastname FROM nmy5_user WHERE lastname = 'SuperAdmin' OR firstname = 'SuperAdmin'");
  console.log('nmy5_user SuperAdmins:', uRows);
  
  c.end();
}

run().catch(console.error);
