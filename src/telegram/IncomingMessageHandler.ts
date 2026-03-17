import { TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import * as fs from "fs";
import * as path from "path";

interface MessageLogEntry {
	timestamp: string;
	messageId: number;
	chatId: string;
	senderId: string;
	isPrivate: boolean;
	isGroup: boolean;
	isChannel: boolean;
	text: string;
	date: number;
	replyToMessageId?: number;
	forwardFromId?: string;
}

/**
 * Listens for incoming Telegram messages and appends each event as a JSON
 * line to storage/<telegramUserId>.log.
 */
export class IncomingMessageHandler {
	private static readonly STORAGE_DIR = path.resolve(process.cwd(), "storage");
	private static readonly INIT_DELAY_MS = 5000;

	private readonly client: TelegramClient;
	private readonly telegramUserId: string;
	private handler: ((event: NewMessageEvent) => Promise<void>) | null = null;

	constructor(client: TelegramClient, telegramUserId: string) {
		this.client = client;
		this.telegramUserId = telegramUserId;
		if (!fs.existsSync(IncomingMessageHandler.STORAGE_DIR)) {
			fs.mkdirSync(IncomingMessageHandler.STORAGE_DIR, { recursive: true });
		}
	}

	private handleIncomingMessage(event: NewMessageEvent): void {
		const msg = event.message;
		const chatId = msg.chatId?.toString() ?? "";

		this.writeLogEntry({
			timestamp: new Date().toISOString(),
			messageId: msg.id,
			chatId,
			senderId: msg.senderId?.toString() ?? "",
			isPrivate: event.isPrivate ?? false,
			isGroup: event.isGroup ?? false,
			isChannel: event.isChannel ?? false,
			text: msg.text ?? "",
			date: msg.date,
			replyToMessageId: msg.replyTo?.replyToMsgId,
			forwardFromId: msg.fwdFrom?.fromId?.toString(),
		});
	}

	// ── Log ──────────────────────────────────────────────────────────────

	private writeLogEntry(entry: MessageLogEntry): void {
		const logPath = path.join(
			IncomingMessageHandler.STORAGE_DIR,
			`${this.telegramUserId}.log`,
		);
		fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	async start(): Promise<void> {
		this.handler = async (event: NewMessageEvent) => {
			try {
				this.handleIncomingMessage(event);
			} catch (error) {
				console.error(
					`[MessageHandler] Error for user ${this.telegramUserId}:`,
					error,
				);
			}
		};

		this.client.addEventHandler(
			this.handler,
			new NewMessage({ incoming: true }),
		);

		await this.delay(IncomingMessageHandler.INIT_DELAY_MS);

		try {
			await this.client.getDialogs({ limit: 100 });
		} catch {
			// Non-fatal — events still work if the session already has update state
		}

		console.log(`[MessageHandler] Started for user ${this.telegramUserId}`);
	}

	stop(): void {
		if (this.handler) {
			this.client.removeEventHandler(
				this.handler,
				new NewMessage({ incoming: true }),
			);
			this.handler = null;
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
