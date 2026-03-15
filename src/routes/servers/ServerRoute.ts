import { randomBytes } from "crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { DatabaseClient } from "../../database/DatabaseClient";
import { TelegramClientService } from "../../telegram/TelegramClientService";
import { SessionStatus } from "../../database/constants/SessionStatus";
import { ServerAuthMiddleware } from "../../http/middleware/ServerAuthMiddleware";

interface TelegramSessionRecord {
	session_id: string;
}

export class ServerRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Returns HTTP 200 with a simple OK payload.
		 * Intentionally kept outside the protected scope — no api-key required
		 * so that load balancer health probes never need credentials.
		 */
		fastify.get(
			"/health",
			async (_request: FastifyRequest, reply: FastifyReply) => {
				new SuccessResponse({ status: "ok" }, "Server is healthy").send(reply);
			},
		);

		/**
		 * Protected scope — all routes registered inside here require a valid
		 * `api-key` header matching the APPLICATION_API_KEY environment variable.
		 */
		fastify.register(async (protected_: FastifyInstance) => {
			protected_.addHook("onRequest", new ServerAuthMiddleware().handle);

			/**
			 * Creates a new tenant for this server and returns the generated credentials.
			 */
			protected_.post(
				"/server/CreateTenant",
				async (request: FastifyRequest, reply: FastifyReply) => {
					const { callbackUrl } = request.body as { callbackUrl?: string };

					if (!callbackUrl) {
						return new ErrorResponse("callbackUrl is required", 400).send(
							reply,
						);
					}

					const serverName = process.env.SERVER_NAME ?? "";
					if (!serverName) {
						return new ErrorResponse(
							"SERVER_NAME is not configured on this server",
							500,
						).send(reply);
					}

					try {
						// 20-char hex secret_id, 50-char hex secret_code
						const secretId = randomBytes(10).toString("hex"); // 20 chars
						const secretCode = randomBytes(25).toString("hex"); // 50 chars

						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const tenant = await DatabaseClient.getInstance().execute<any>(
							(prisma) =>
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								(prisma as any).tenant.create({
									data: {
										secret_id: secretId,
										secret_code: secretCode,
										server_name: serverName,
										callback_url: callbackUrl,
									},
									select: {
										id: true,
										secret_id: true,
										secret_code: true,
										server_name: true,
										callback_url: true,
										created_at: true,
									},
								}),
						);

						new SuccessResponse(
							tenant,
							"Tenant created successfully",
							201,
						).send(reply);
					} catch (error: unknown) {
						ErrorResponse.fromError(error, 500).send(reply);
					}
				},
			);

			/**
			 * Returns all tenants registered on this server.
			 * secret_code is masked: first 2 + **** + last 2 characters.
			 */
			protected_.get(
				"/server/GetTenants",
				async (_request: FastifyRequest, reply: FastifyReply) => {
					const serverName = process.env.SERVER_NAME ?? "";
					if (!serverName) {
						return new ErrorResponse(
							"SERVER_NAME is not configured on this server",
							500,
						).send(reply);
					}

					try {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const tenants = await DatabaseClient.getInstance().execute<any[]>(
							(prisma) =>
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								(prisma as any).tenant.findMany({
									where: { server_name: serverName },
									select: {
										id: true,
										secret_id: true,
										secret_code: true,
										callback_url: true,
										created_at: true,
									},
									orderBy: { created_at: "asc" },
								}),
						);

						const masked = tenants.map((t) => ({
							...t,
							secret_code: `${t.secret_code.slice(0, 2)}********${t.secret_code.slice(-2)}`,
						}));

						new SuccessResponse(masked, "Tenants retrieved successfully").send(
							reply,
						);
					} catch (error: unknown) {
						ErrorResponse.fromError(error, 500).send(reply);
					}
				},
			);

			/**
			 * Returns server-wide runtime statistics.
			 */
			protected_.get(
				"/server/GetStatistics",
				async (_request: FastifyRequest, reply: FastifyReply) => {
					const serverName = process.env.SERVER_NAME ?? "";
					if (!serverName) {
						return new ErrorResponse(
							"SERVER_NAME is not configured on this server",
							500,
						).send(reply);
					}

					try {
						const db = DatabaseClient.getInstance();

						const [activeSessions] = await Promise.all([
							db.execute<number>((prisma) =>
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								(prisma as any).telegramSession.count({
									where: {
										status: SessionStatus.ACTIVE,
										tenant: { server_name: serverName },
									},
								}),
							),
						]);

						new SuccessResponse(
							{
								poolSize: TelegramClientService.getPooledSessionIds().length,
								activeSessions,
							},
							"Statistics retrieved successfully",
						).send(reply);
					} catch (error: unknown) {
						ErrorResponse.fromError(error, 500).send(reply);
					}
				},
			);
			/**
			 * Deletes a tenant and all its Telegram sessions from this server.
			 */
			protected_.post(
				"/server/DeleteTenant",
				async (request: FastifyRequest, reply: FastifyReply) => {
					const { id } = request.body as { id?: number };

					if (!id) {
						return new ErrorResponse("tenant id is required", 400).send(reply);
					}

					const serverName = process.env.SERVER_NAME ?? "";
					if (!serverName) {
						return new ErrorResponse(
							"SERVER_NAME is not configured on this server",
							500,
						).send(reply);
					}

					try {
						const db = DatabaseClient.getInstance();

						// Confirm the tenant belongs to this server before touching anything
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const tenant = await db.execute<any>((prisma) =>
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							(prisma as any).tenant.findFirst({
								where: { id, server_name: serverName },
							}),
						);

						if (!tenant) {
							return new ErrorResponse(
								"Tenant not found on this server",
								404,
							).send(reply);
						}

						// Load every session belonging to this tenant
						const sessions = await db.execute<TelegramSessionRecord[]>(
							(prisma) =>
								prisma.telegramSession.findMany({
									where: { tenant_id: id },
									select: { session_id: true },
								}),
						);

						// Invalidate sessions one by one.
						// Sequential processing avoids burst traffic to Telegram and
						// allows FLOOD_WAIT errors to be handled with a per-session retry.
						for (const session of sessions) {
							await this.withFloodWaitRetry(() =>
								TelegramClientService.invalidate(session.session_id),
							);
						}

						// All sessions cleared — safe to delete the tenant record
						await db.execute((prisma) =>
							(prisma as any).tenant.delete({ where: { id } }),
						);

						new SuccessResponse(
							{ id, totalSessions: sessions.length },
							"Tenant deleted successfully",
						).send(reply);
					} catch (error: unknown) {
						ErrorResponse.fromError(error, 500).send(reply);
					}
				},
			);
		}); // end protected scope
	}

	/**
	 * Executes `fn` and retries it after the flood-wait delay if Telegram
	 * responds with a FLOOD_WAIT error. Any other error is re-thrown immediately.
	 *
	 * GramJS surfaces flood-waits as errors whose message contains "FLOOD_WAIT_"
	 * and that carry a `seconds` property indicating how long to wait.
	 */
	private async withFloodWaitRetry<T>(fn: () => Promise<T>): Promise<T> {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			try {
				return await fn();
			} catch (error: unknown) {
				const seconds =
					error instanceof Error &&
					"seconds" in error &&
					typeof (error as Error & { seconds: unknown }).seconds === "number"
						? (error as Error & { seconds: number }).seconds
						: null;

				if (seconds !== null) {
					// Add a 1-second buffer on top of the required wait
					console.warn(
						`[DeleteTenant] Telegram flood wait — retrying in ${seconds + 1}s`,
					);
					await new Promise((resolve) =>
						setTimeout(resolve, (seconds + 1) * 1000),
					);
				} else {
					throw error;
				}
			}
		}
	}
}
