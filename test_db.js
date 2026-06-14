const { createPool } = require('mysql2/promise');
async function check() {
  const pool = createPool({
    host: 'sg2plzcpnl466812.prod.sin2.secureserver.net',
    user: 'i9942982_oc9i1',
    password: 'Axion@pd123',
    database: 'i9942982_oc9i1'
  });
  try {
    const [cols] = await pool.query('SHOW COLUMNS FROM nmy5_const');
    console.log(cols);
    await pool.execute("INSERT INTO nmy5_const (name, entity, value, type, visible, note) VALUES ('APP_WEEKEND_DAYS', 1, '[0]', 'chaine', 1, 'Weekend configuration') ON DUPLICATE KEY UPDATE value = '[0]'");
    console.log('Insert success');
  } catch(e) {
    console.error('DB Error:', e.message);
  }
  pool.end();
}
check();
