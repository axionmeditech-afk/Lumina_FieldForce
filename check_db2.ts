import mysql from 'mysql2/promise';

async function run() {
  const conn = await mysql.createConnection({
    host: 'sg2plzcpnl466812.prod.sin2.secureserver.net',
    port: 3306,
    user: 'i9942982_oc9i1',
    password: 'Axion@pd123',
    database: 'i9942982_oc9i1',
  });

  const [reqRows] = await conn.query('SELECT name, email, status, assigned_company_ids_json FROM lff_access_requests WHERE status = "approved"');
  console.log("Approved Access Requests:");
  console.log(reqRows);

  const [userRows] = await conn.query('SELECT u.login, u.email, ep.employee_category FROM nmy5_user u LEFT JOIN nmy5_hrm_employee_profile ep ON u.rowid = ep.fk_user');
  console.log("Users and Categories:");
  console.log(userRows);

  await conn.end();
}

run().catch(console.error);
