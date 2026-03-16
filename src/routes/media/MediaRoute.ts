import * as fs from "fs";
import * as path from "path";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { ServerAuthMiddleware } from "../../http/middleware/ServerAuthMiddleware";
import {
	TelegramMediaService,
	MediaType,
} from "../../telegram/TelegramMediaService";

interface DownloadBody {
	sessionId: string;
	id: string;
	accessHash: string;
	fileReference: string;
	type: MediaType;
}

/**
 * HTTP layer for Telegram media download and static file serving.
 *
 * Routes:
 *   POST /media/download              — protected by api-key (server-to-server)
 *   GET  /media/files/:date/:filename — public
 */
export class MediaRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		fastify.register(async (protected_: FastifyInstance) => {
			protected_.addHook("onRequest", new ServerAuthMiddleware().handle);

			protected_.post(
				"/media/download",
				async (
					request: FastifyRequest<{ Body: DownloadBody }>,
					reply: FastifyReply,
				) => {
					const { sessionId, id, accessHash, fileReference, type } =
						request.body;

					if (!sessionId || !id || !accessHash || !fileReference || !type) {
						return new ErrorResponse(
							"sessionId, id, accessHash, fileReference, and type are required",
							400,
						).send(reply);
					}

					const todayDir = TelegramMediaService.getTodayDir();
					const today = path.basename(todayDir);
					const baseUrl = `${request.protocol}://${request.headers.host}`;

					const cached = TelegramMediaService.findCachedFile(todayDir, id);
					if (cached) {
						return new SuccessResponse(
							{
								fileUrl: `${baseUrl}/media/files/${today}/${path.basename(cached)}`,
								fileExpiration: TelegramMediaService.getExpirationDate(),
							},
							"Retrieve media file successfully",
						).send(reply);
					}

					try {
						const result = await this.withTelegramSession(
							sessionId,
							async (clientService) =>
								TelegramMediaService.downloadFile(clientService.getClient(), {
									id,
									accessHash,
									fileReference,
									type,
								}),
						);

						new SuccessResponse(
							{
								fileUrl: `${baseUrl}/media/files/${result.date}/${result.fileName}`,
								fileExpiration: TelegramMediaService.getExpirationDate(),
							},
							"Media downloaded successfully",
						).send(reply);
					} catch (error: unknown) {
						ErrorResponse.fromError(error, 500).send(reply);
					}
				},
			);
		}); // end protected scope

		fastify.get(
			"/media/files/:date/:filename",
			async (
				request: FastifyRequest<{
					Params: { date: string; filename: string };
				}>,
				reply: FastifyReply,
			) => {
				const { date, filename } = request.params;

				const filePath = TelegramMediaService.resolveFile(date, filename);
				if (!filePath) {
					return new ErrorResponse("File not found", 404).send(reply);
				}

				const { contentType, size } =
					await TelegramMediaService.getFileInfo(filePath);

				return reply
					.header("Content-Type", contentType)
					.header("Content-Length", size)
					.header("Content-Disposition", `inline; filename="${filename}"`)
					.header("Cache-Control", "public, max-age=86400")
					.send(fs.createReadStream(filePath));
			},
		);
	}
}
