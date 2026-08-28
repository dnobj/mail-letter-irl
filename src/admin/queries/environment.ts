import { AdminDatabaseIdentitySchema } from "../config.js";
import type { AdminSqlClient } from "../database.js";

interface AdminDatabaseIdentityRow {
  databaseName: string;
  roleName: string;
  marker: "development" | "production" | null;
}

export async function readAdminDatabaseIdentity(client: AdminSqlClient) {
  const result = await client.query<AdminDatabaseIdentityRow>(`
    SELECT
      current_database() AS "databaseName",
      current_user AS "roleName",
      (
        SELECT marker.environment
        FROM admin_environment_marker AS marker
        LIMIT 1
      ) AS marker
  `);

  return AdminDatabaseIdentitySchema.parse(result.rows[0]);
}
