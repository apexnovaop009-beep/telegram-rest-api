import { createHash, randomBytes } from "crypto";
import { RedisClient } from "../redis/RedisClient";
import { DatabaseClient } from "../database/DatabaseClient";
import { Tenant } from "./interface/ITenant";

export type { Tenant };

export class TenantService {
	private static readonly TTL_SECONDS = 3600; // 1 hour
	private static readonly CACHE_PREFIX = "tenant:";

	private static buildCacheKey(secretId: string, secretCode: string): string {
		return (
			TenantService.CACHE_PREFIX +
			createHash("md5")
				.update(secretId + secretCode)
				.digest("hex")
		);
	}

	/**
	 * Returns the tenant matching the given credentials.
	 * Checks Redis first; falls back to the database on a cache miss or Redis outage.
	 * Returns null if no matching tenant exists.
	 */
	static async getTenant(
		secretId: string,
		secretCode: string,
	): Promise<Tenant | null> {
		try {
			const redis = RedisClient.getInstance();
			const raw = await redis.get(
				TenantService.buildCacheKey(secretId, secretCode),
			);
			if (raw) return JSON.parse(raw) as Tenant;
		} catch {
			// Redis unavailable — fall through to DB
		}

		const tenant = await DatabaseClient.getInstance().execute(
			(prisma) =>
				(prisma as any).tenant.findFirst({
					where: {
						secret_id: secretId,
						secret_code: secretCode,
						server_name: process.env.SERVER_NAME ?? "",
					},
				}) as Promise<Tenant | null>,
		);

		if (tenant) {
			await TenantService.setTenant(secretId, secretCode, tenant);
		}

		return tenant;
	}

	/**
	 * Writes tenant data to the Redis cache with a 1-hour TTL.
	 * Fails silently if Redis is unavailable.
	 */
	static async setTenant(
		secretId: string,
		secretCode: string,
		tenant: Tenant,
	): Promise<void> {
		const redis = RedisClient.getInstance();
		await redis.set(
			TenantService.buildCacheKey(secretId, secretCode),
			JSON.stringify(tenant),
			TenantService.TTL_SECONDS,
		);
	}

	/**
	 * Generates a fresh pair of tenant credentials.
	 */
	static generateCredentials(): { secretId: string; secretCode: string } {
		return {
			secretId: randomBytes(10).toString("hex"),
			secretCode: randomBytes(25).toString("hex"),
		};
	}

	/**
	 * Removes the tenant from the Redis cache (e.g. after credential rotation).
	 */
	static async invalidate(secretId: string, secretCode: string): Promise<void> {
		const redis = RedisClient.getInstance();
		await redis.del(TenantService.buildCacheKey(secretId, secretCode));
	}
}
