import mysql from 'mysql2/promise';

async function run() {
  const conn = await mysql.createConnection({
    host: 'sg2plzcpnl466812.prod.sin2.secureserver.net',
    port: 3306,
    user: 'i9942982_oc9i1',
    password: 'Axion@pd123',
    database: 'i9942982_oc9i1',
  });

  const [cols] = await conn.query('SHOW COLUMNS FROM nmy5_user');
  console.log("nmy5_user columns:");
  console.log((cols as any[]).map(c => c.Field).join(", "));

  try {
    const [extraCols] = await conn.query('SHOW COLUMNS FROM nmy5_user_extrafields');
    console.log("\nnmy5_user_extrafields columns:");
    console.log((extraCols as any[]).map(c => c.Field).join(", "));
  } catch (e) {
    console.log("No nmy5_user_extrafields table found or error:", e.message);
  }

  await conn.end();
}

run().catch(console.error);
