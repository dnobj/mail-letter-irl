import type { QueryResult, QueryResultRow } from "pg";

export interface AdminSqlClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface AdminTransactionRunner {
  transaction<T>(callback: (client: AdminSqlClient) => Promise<T>): Promise<T>;
}
