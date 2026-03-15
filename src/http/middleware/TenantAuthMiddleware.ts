import { FastifyReply, FastifyRequest } from "fastify";
import { ErrorResponse } from "../ApiResponse";
import { TenantService } from "../../services/TenantService";

export abstract class BaseMiddleware {
	abstract handle(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export class TenantAuthMiddleware extends BaseMiddleware {
	handle = async (
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> => {
		const secretId = request.headers["secret-id"] as string | undefined;
		const secretCode = request.headers["secret-code"] as string | undefined;
		const acceptHeader = request.headers["accept"];

		if (!secretId || !secretCode) {
			return new ErrorResponse(
				"Secret id and code are required in the request headers.",
				401,
			).send(reply);
		}

		if (acceptHeader !== "application/json") {
			return new ErrorResponse(
				"Accept header must be application/json",
				400,
			).send(reply);
		}

		try {
			const tenant = await TenantService.getTenant(secretId, secretCode);
			if (!tenant) {
				return new ErrorResponse("Unauthorized", 401).send(reply);
			}
		} catch (error) {
			return new ErrorResponse("Failed to resolve tenant.", 500).send(reply);
		}
	};
}
