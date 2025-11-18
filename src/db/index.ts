/**
 * Database connection and query utilities
 */

import pg from 'pg';

const { Pool } = pg;

// Create connection pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return error if connection takes > 2 seconds
});

// Log connection events
pool.on('connect', () => {
  console.log('📊 Database client connected');
});

pool.on('error', (err) => {
  console.error('📊 Unexpected database error:', err);
});

// Test connection
export async function testConnection(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT NOW() as now, version() as version');
    console.log('📊 Database connected successfully');
    console.log(`   Time: ${result.rows[0].now}`);
    console.log(`   Version: ${result.rows[0].version.split(' ').slice(0, 2).join(' ')}`);
    return true;
  } catch (error) {
    console.error('📊 Database connection failed:', error);
    return false;
  }
}

// Graceful shutdown
export async function closePool(): Promise<void> {
  await pool.end();
  console.log('📊 Database connection pool closed');
}

// Query helper with logging
export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    if (duration > 100) {
      console.log(`📊 Slow query (${duration}ms):`, text.substring(0, 100));
    }
    return result;
  } catch (error) {
    console.error('📊 Query error:', error);
    console.error('   SQL:', text);
    console.error('   Params:', params);
    throw error;
  }
}

// Transaction helper
export async function transaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
