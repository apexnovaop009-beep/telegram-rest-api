import * as fs from "fs";
import * as path from "path";
import { DatabaseClient } from "../database/DatabaseClient";
import { MessageWithAttachments } from "./interface/MessageWithAttachments";

const FORWARDING_INTERVAL_MS = parseInt(
	process.env.FORWARDING_INTERVAL_MS ?? "1000",
	10,
);
const STORAGE_DIR = path.resolve(process.cwd(), "storage");

export class TenantForwardingScheduler {
	private timer: NodeJS.Timeout | null = null;
	private processing = false;

	start(): void {
		if (this.timer) return;

		if (!fs.existsSync(STORAGE_DIR)) {
			fs.mkdirSync(STORAGE_DIR, { recursive: true });
		}

		this.timer = setInterval(
			() => this.tick(),
			FORWARDING_INTERVAL_MS,
		);
		console.log(
			`[ForwardingScheduler] Started (interval: ${FORWARDING_INTERVAL_MS}ms)`,
		);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async tick(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			const db = DatabaseClient.getInstance();
			const tenants = await db.execute((prisma) =>
				prisma.tenant.findMany({ select: { id: true } }),
			);

			await Promise.all(
				tenants.map((t) => this.processTenant(t.id)),
			);
		} catch (error) {
			console.error("[ForwardingScheduler] Tick error:", error);
		} finally {
			this.processing = false;
		}
	}

	private async processTenant(tenantId: number): Promise<void> {
		try {
			const db = DatabaseClient.getInstance();

			const state = await db.execute((prisma) =>
				prisma.tenantMessageState.upsert({
					where: { tenant_id: tenantId },
					update: {},
					create: {
						tenant_id: tenantId,
						last_forwarded_id: BigInt(0),
					},
				}),
			);

			let forwarded = true;
			while (forwarded) {
				forwarded = await this.forwardNext(tenantId, state.last_forwarded_id);
				if (forwarded) {
					state.last_forwarded_id++;
				}
			}
		} catch (error) {
			console.error(
				`[ForwardingScheduler] Error for tenant ${tenantId}:`,
				error,
			);
		}
	}

	private async forwardNext(
		tenantId: number,
		lastForwardedId: bigint,
	): Promise<boolean> {
		const db = DatabaseClient.getInstance();

		return db.execute(async (prisma) => {
			const nextMsg = await prisma.message.findFirst({
				where: {
					tenant_id: tenantId,
					id: { gt: lastForwardedId },
				},
				orderBy: { id: "asc" },
				include: { attachments: true },
			});

			if (!nextMsg) return false;
			if (nextMsg.status !== "downloaded") return false;

			this.writeFinalLog(nextMsg);

			await prisma.$transaction([
				prisma.message.update({
					where: { id: nextMsg.id },
					data: { status: "forwarded" },
				}),
				prisma.tenantMessageState.update({
					where: { tenant_id: tenantId },
					data: { last_forwarded_id: nextMsg.id },
				}),
			]);

			console.log(
				`[ForwardingScheduler] Forwarded message ${nextMsg.id} for tenant ${tenantId}`,
			);
			return true;
		});
	}

	private writeFinalLog(msg: MessageWithAttachments): void {
		const payload = {
			id: msg.id.toString(),
			tenant_id: msg.tenant_id,
			chat_id: msg.telegram_chat_id,
			message_id: msg.telegram_message_id,
			from_account: msg.from_account,
			text: msg.message,
			received_at: msg.created_at.toISOString(),
			attachments: msg.attachments.map((a) => ({
				file_unique_id: a.file_unique_id,
				file_type: a.file_type,
				file_path: a.file_url,
			})),
		};

		const logPath = path.join(STORAGE_DIR, `${msg.id}.log`);
		fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf-8");
	}
}
