const { createPool } = require('mysql2/promise');
require('dotenv').config();

async function cleanUp() {
  const pool = createPool({
    host: process.env.MYSQL_HOST || '151.106.124.154',
    user: process.env.MYSQL_USER || 'u6942982_oc9t1',
    password: process.env.MYSQL_PASSWORD || 'E7Xh5iT#f7_z',
    database: process.env.MYSQL_DATABASE || 'u6942982_oc9t1',
  });

  try {
    await pool.execute("DROP TABLE IF EXISTS `lff_leave_requests`");
    console.log("Successfully dropped lff_leave_requests");
  } catch (e) {
    console.error("Failed to drop table", e);
  } finally {
    pool.end();
  }
}

cleanUp();
