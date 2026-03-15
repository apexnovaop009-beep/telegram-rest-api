import "dotenv/config";
import { Application } from "./app";
import { TenantAuthMiddleware } from "./http/middleware/TenantAuthMiddleware";
import { AuthRoute } from "./routes/auth/AuthRoute";
import { UserRoute } from "./routes/user/UserRoute";
import { MessageRoute } from "./routes/message/MessageRoute";
import { ChatRoute } from "./routes/message/ChatRoute";
import { ChannelRoute } from "./routes/channels/ChannelRoute";
import { ServerRoute } from "./routes/servers/ServerRoute";
import { TelegramClientService } from "./telegram/TelegramClientService";
import { TelegramSessionWatchdog } from "./telegram/TelegramSessionWatchdog";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function bootstrap(): Promise<void> {
	await TelegramClientService.restoreFromDatabase();

	const watchdog = new TelegramSessionWatchdog();
	watchdog.start();

	const app = new Application();
	app
		.registerPublicRoutes([
			new ServerRoute(), // /health, /server/CreateTenant, /server/GetStatistics
		])
		.registerMiddleware(new TenantAuthMiddleware())
		.registerRoutes([
			new AuthRoute(),
			new UserRoute(),
			new MessageRoute(),
			new ChatRoute(),
			new ChannelRoute(),
		]);

	await app.start(PORT);
}

bootstrap().catch((err: unknown) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
