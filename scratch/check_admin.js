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
  
  const [uRows] = await c.query("SELECT rowid, login, email, firstname, lastname FROM nmy5_user WHERE login LIKE '%admin%' OR email LIKE '%admin%' OR admin = 1");
  console.log('USERS:', uRows);
  
  const [rRows] = await c.query("SELECT id, email, name FROM lff_access_requests WHERE email LIKE '%admin%' OR name LIKE '%admin%'");
  console.log('REQUESTS:', rRows);
  
  c.end();
}

run().catch(console.error);
