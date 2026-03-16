import "dotenv/config";
import { Application } from "./app";
import { TenantAuthMiddleware } from "./http/middleware/TenantAuthMiddleware";
import { AuthRoute } from "./routes/auth/AuthRoute";
import { UserRoute } from "./routes/user/UserRoute";
import { MessageRoute } from "./routes/message/MessageRoute";
import { ChatRoute } from "./routes/message/ChatRoute";
import { ChannelRoute } from "./routes/channels/ChannelRoute";
import { ServerRoute } from "./routes/servers/ServerRoute";
import { MediaRoute } from "./routes/media/MediaRoute";
import { TelegramClientService } from "./telegram/TelegramClientService";
import { TelegramSessionWatchdog } from "./telegram/TelegramSessionWatchdog";
import { TelegramMediaService } from "./telegram/TelegramMediaService";
import { QueueJobWatchdog } from "./queue/QueueJobWatchdog";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function bootstrap(): Promise<void> {
	await TelegramClientService.restoreFromDatabase();

	// Start the telegram session watchdog
	const sessionWatchdog = new TelegramSessionWatchdog();
	sessionWatchdog.start();

	// Start the queue job watchdog
	const queueWatchdog = new QueueJobWatchdog();
	queueWatchdog.start();

	// Start the media cleanup watchdog
	const mediaService = new TelegramMediaService();
	mediaService.start();

	const app = new Application();
	app
		.registerPublicRoutes([new ServerRoute(), new MediaRoute()])
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
