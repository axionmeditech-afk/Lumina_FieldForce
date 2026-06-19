import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';

// Load .env variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const emailToSearch = 'godanishubham30@gmail.com';

async function main() {
  console.log('Connecting to database...');
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    ssl: process.env.MYSQL_SSL === 'true' ? {} : undefined,
  });

  const conn = await pool.getConnection();
  try {
    console.log(`Searching for email: "${emailToSearch}" in database: "${process.env.MYSQL_DATABASE}"`);

    // 1. Get all tables
    const [tablesRaw] = await conn.query<any[]>('SHOW TABLES');
    const dbName = process.env.MYSQL_DATABASE || '';
    const tables = tablesRaw.map(row => Object.values(row)[0] as string);
    console.log(`Found ${tables.length} tables to scan.`);

    for (const table of tables) {
      // 2. Get all columns of the table
      const [columnsRaw] = await conn.query<any[]>(
        `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.columns 
         WHERE table_schema = ? AND table_name = ?`,
        [dbName, table]
      );

      const columns = columnsRaw
        .filter(col => {
          const type = String(col.DATA_TYPE).toLowerCase();
          return type.includes('char') || type.includes('text');
        })
        .map(col => col.COLUMN_NAME as string);

      if (columns.length === 0) continue;

      for (const col of columns) {
        try {
          // Check if there are any rows with this email
          const query = `SELECT COUNT(*) AS count FROM \`${table}\` WHERE LOWER(\`${col}\`) = ?`;
          const [result]: any = await conn.query(query, [emailToSearch.toLowerCase()]);
          const count = result[0]?.count || 0;

          if (count > 0) {
            console.log(`[MATCH] Table: "${table}", Column: "${col}" has ${count} matching row(s).`);
            
            // Delete the matching rows
            const deleteQuery = `DELETE FROM \`${table}\` WHERE LOWER(\`${col}\`) = ?`;
            const [delResult]: any = await conn.query(deleteQuery, [emailToSearch.toLowerCase()]);
            console.log(`  -> Deleted ${delResult.affectedRows} row(s) from "${table}"`);
          }
        } catch (err: any) {
          // Some tables/columns might fail due to permissions, schemas etc., we log and continue
          console.warn(`[SKIP] Could not scan Table: "${table}", Column: "${col}": ${err.message}`);
        }
      }
    }

    console.log('Search and cleanup finished successfully.');
  } catch (error) {
    console.error('Error occurred:', error);
  } finally {
    conn.release();
    await pool.end();
  }
}

main();
