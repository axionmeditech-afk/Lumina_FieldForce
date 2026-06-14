const { createPool } = require('mysql2/promise');
require('dotenv').config();

async function checkColumns() {
  const pool = createPool({
    host: 'sg2plzcpnl466812.prod.sin2.secureserver.net',
    user: 'i9942982_oc9i1',
    password: 'Axion@pd123',
    database: 'i9942982_oc9i1',
  });

  try {
    const [hCols] = await pool.query("SHOW COLUMNS FROM nmy5_holiday");
    console.log("nmy5_holiday columns:");
    console.table(hCols);
  } catch (e) {
    console.error("DB Error:", e);
  } finally {
    pool.end();
  }
}

checkColumns();
