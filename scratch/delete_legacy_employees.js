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
  
  await c.query("DELETE FROM lff_app_state WHERE state_key = '@trackforce_employees'");
  console.log('Deleted legacy employees from app state');
  
  c.end();
}

run().catch(console.error);

