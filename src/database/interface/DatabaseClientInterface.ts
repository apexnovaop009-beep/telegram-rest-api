import { NodePgDatabase } from "drizzle-orm/node-postgres";

export interface DatabaseClientInterface {
	execute<T>(operation: (db: NodePgDatabase) => Promise<T>): Promise<T>;
}
