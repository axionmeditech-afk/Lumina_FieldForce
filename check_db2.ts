import mysql from 'mysql2/promise';

async function run() {
  const conn = await mysql.createConnection({
    host: 'sg2plzcpnl466812.prod.sin2.secureserver.net',
    port: 3306,
    user: 'i9942982_oc9i1',
    password: 'Axion@pd123',
    database: 'i9942982_oc9i1',
  });

  const [rows] = await conn.query('SELECT login, email, job FROM nmy5_user LIMIT 10');
  console.log("Users and their jobs:");
  console.log(rows);

  await conn.end();
}

run().catch(console.error);
