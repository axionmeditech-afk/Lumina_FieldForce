const { createPool } = require('mysql2/promise');
require('dotenv').config();

async function checkColumns() {
  const pool = createPool({
    host: process.env.MYSQL_HOST || '151.106.124.154',
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  try {
    const [hCols] = await pool.query("SHOW COLUMNS FROM nmy5_holiday");
    console.log("nmy5_holiday columns:");
    console.table(hCols);

    const [lCols] = await pool.query("SHOW COLUMNS FROM nmy5_holiday_logs");
    console.log("\nnmy5_holiday_logs columns:");
    console.table(lCols);
  } catch (e) {
    console.error("DB Error:", e);
  } finally {
    pool.end();
  }
}

checkColumns();
