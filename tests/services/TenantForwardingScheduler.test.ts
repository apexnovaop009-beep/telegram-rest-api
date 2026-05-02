import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must run before the module is imported (vi.mock is hoisted, vi.stubEnv is not).
vi.hoisted(() => {
	process.env.CALLBACK_RETRY_BASE_DELAY_SECONDS = "5";
	process.env.CALLBACK_MAX_RETRIES = "3";
	process.env.SERVER_NAME = "test-server";
});

// ── Mock DatabaseClient ─────────────────────────────────────────────
// The scheduler calls `DatabaseClient.getInstance().execute(cb)`.
// Our mock captures the callback and runs it against a fake PrismaClient.

const mockPrisma = {
	message: {
		findFirst: vi.fn(),
		update: vi.fn().mockReturnValue(Promise.resolve({})),
		delete: vi.fn().mockReturnValue(Promise.resolve({})),
	},
	tenantMessageState: {
		update: vi.fn().mockReturnValue(Promise.resolve({})),
	},
	$transaction: vi.fn((args: unknown[]) => Promise.resolve(args)),
};

vi.mock("../../src/database/DatabaseClient", () => ({
	DatabaseClient: {
		getInstance: () => ({
			execute: (cb: (prisma: typeof mockPrisma) => Promise<unknown>) =>
				cb(mockPrisma),
		}),
	},
}));

// Import after mocks are wired.
import { TenantForwardingScheduler } from "../../src/services/TenantForwardingScheduler";

// ── Helpers ──────────────────────────────────────────────────────────

const SESSION_ID = BigInt(1);
const CALLBACK_URL = "https://example.com/callback";

function makeScheduler(): TenantForwardingScheduler {
	return new TenantForwardingScheduler();
}

function callForwardNext(
	scheduler: TenantForwardingScheduler,
	sessionId = SESSION_ID,
	lastForwardedId = BigInt(0),
	callbackUrl = CALLBACK_URL,
): Promise<bigint | null> {
	return (scheduler as any)["forwardNext"](
		sessionId,
		lastForwardedId,
		callbackUrl,
	);
}

function mockFetchOk(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" }),
	);
}

function mockFetchFail(status = 500, statusText = "Internal Server Error"): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: false, status, statusText }),
	);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("TenantForwardingScheduler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// ── 1. Successful delivery ───────────────────────────────────────
	it("deletes the message and advances cursor on successful delivery", async () => {
		const scheduler = makeScheduler();

		mockPrisma.message.findFirst.mockResolvedValue({
			id: BigInt(10),
			raw_payload: '{"text":"hello"}',
			status: "downloaded",
			delivery_retry_count: 0,
			next_delivery_attempt_at: null,
		});

		mockFetchOk();

		const result = await callForwardNext(scheduler);

		expect(result).toBe(BigInt(10));
		expect(mockPrisma.$transaction).toHaveBeenCalledWith([
			expect.anything(), // tenantMessageState.update
			expect.anything(), // message.delete
		]);
		expect(mockPrisma.tenantMessageState.update).toHaveBeenCalledWith({
			where: { session_id: SESSION_ID },
			data: { last_forwarded_id: BigInt(10) },
		});
		expect(mockPrisma.message.delete).toHaveBeenCalledWith({
			where: { id: BigInt(10) },
		});
	});

	// ── 2. First failure schedules retry ─────────────────────────────
	it("increments retry count and sets next_delivery_attempt_at on first failure", async () => {
		const scheduler = makeScheduler();

		mockPrisma.message.findFirst.mockResolvedValue({
			id: BigInt(20),
			raw_payload: '{"text":"hello"}',
			status: "downloaded",
			delivery_retry_count: 0,
			next_delivery_attempt_at: null,
		});

		mockFetchFail();

		const before = Date.now();
		const result = await callForwardNext(scheduler);
		const after = Date.now();

		expect(result).toBeNull();
		expect(mockPrisma.message.update).toHaveBeenCalledOnce();

		const updateCall = mockPrisma.message.update.mock.calls[0][0];
		expect(updateCall.where.id).toBe(BigInt(20));
		expect(updateCall.data.delivery_retry_count).toBe(1);
		expect(updateCall.data.last_delivery_error).toBe(
			"HTTP 500 Internal Server Error",
		);

		// 1 * 5s = 5000ms from now
		const nextAttempt = (updateCall.data.next_delivery_attempt_at as Date).getTime();
		expect(nextAttempt).toBeGreaterThanOrEqual(before + 5000);
		expect(nextAttempt).toBeLessThanOrEqual(after + 5000 + 50);
	});

	// ── 3. Linear back-off delay ─────────────────────────────────────
	it("computes delay as attempt * base (linear back-off)", async () => {
		const scheduler = makeScheduler();

		mockPrisma.message.findFirst.mockResolvedValue({
			id: BigInt(30),
			raw_payload: '{"text":"hello"}',
			status: "downloaded",
			delivery_retry_count: 2, // already failed twice
			next_delivery_attempt_at: null,
		});

		mockFetchFail();

		// retry count 2 -> 3 which equals CALLBACK_MAX_RETRIES, so this
		// should be permanent failure. Use retry count 1 instead for back-off test.
		mockPrisma.message.findFirst.mockResolvedValue({
			id: BigInt(30),
			raw_payload: '{"text":"hello"}',
			status: "downloaded",
			delivery_retry_count: 1, // failed once before
			next_delivery_attempt_at: null,
		});

		const before = Date.now();
		const result = await callForwardNext(scheduler);
		const after = Date.now();

		expect(result).toBeNull();
		const updateCall = mockPrisma.message.update.mock.calls[0][0];
		expect(updateCall.data.delivery_retry_count).toBe(2);

		// 2 * 5s = 10000ms
		const nextAttempt = (updateCall.data.next_delivery_attempt_at as Date).getTime();
		expect(nextAttempt).toBeGreaterThanOrEqual(before + 10000);
		expect(nextAttempt).toBeLessThanOrEqual(after + 10000 + 50);
	});

	// ── 4. Retry delay not elapsed ───────────────────────────────────
	it("returns null without calling fetch when retry delay has not elapsed", async () => {
		const scheduler = makeScheduler();

		const futureDate = new Date(Date.now() + 60_000);
		mockPrisma.message.findFirst.mockResolvedValue({
			id: BigInt(40),
			raw_payload: '{"text":"hello"}',
			status: "downloaded",
			delivery_retry_count: 1,
			next_delivery_attempt_at: futureDate,
		});

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await callForwardNext(scheduler);

		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// ── 5. Permanent failure after max retries ───────────────────────
	it("marks message as delivery_failed when retries are exhausted", async () => {
		const scheduler = makeScheduler();

		// CALLBACK_MAX_RETRIES = 3, so delivery_retry_count 2 -> 3 triggers permanent failure.
		mockPrisma.message.findFirst.mockResolvedValue({
			id: BigInt(50),
			raw_payload: '{"text":"hello"}',
			status: "downloaded",
			delivery_retry_count: 2,
			next_delivery_attempt_at: null,
		});

		mockFetchFail(503, "Service Unavailable");

		const result = await callForwardNext(scheduler);

		expect(result).toBeNull();
		expect(mockPrisma.$transaction).toHaveBeenCalled();
		expect(mockPrisma.message.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: BigInt(50) },
				data: expect.objectContaining({
					status: "delivery_failed",
					delivery_retry_count: 3,
					last_delivery_error: "HTTP 503 Service Unavailable",
					next_delivery_attempt_at: null,
				}),
			}),
		);
		expect(mockPrisma.tenantMessageState.update).toHaveBeenCalledWith({
			where: { session_id: SESSION_ID },
			data: { last_forwarded_id: BigInt(50) },
		});
	});

	// ── 6. Cursor skips delivery_failed messages ─────────────────────
	it("advances cursor past delivery_failed messages without calling fetch", async () => {
		const scheduler = makeScheduler();

		mockPrisma.message.findFirst.mockResolvedValue({
			id: BigInt(60),
			raw_payload: '{"text":"hello"}',
			status: "delivery_failed",
			delivery_retry_count: 3,
			next_delivery_attempt_at: null,
		});

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await callForwardNext(scheduler);

		expect(result).toBe(BigInt(60));
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(mockPrisma.tenantMessageState.update).toHaveBeenCalledWith({
			where: { session_id: SESSION_ID },
			data: { last_forwarded_id: BigInt(60) },
		});
	});

	// ── 7. Pending message blocks queue ──────────────────────────────
	it("returns null for a pending message without calling fetch", async () => {
		const scheduler = makeScheduler();

		mockPrisma.message.findFirst.mockResolvedValue({
			id: BigInt(70),
			raw_payload: '{"text":"hello"}',
			status: "pending",
			delivery_retry_count: 0,
			next_delivery_attempt_at: null,
		});

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await callForwardNext(scheduler);

		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// ── 8. Empty payload treated as success ──────────────────────────
	it("treats null raw_payload as successful delivery and deletes the message", async () => {
		const scheduler = makeScheduler();

		mockPrisma.message.findFirst.mockResolvedValue({
			id: BigInt(80),
			raw_payload: null,
			status: "downloaded",
			delivery_retry_count: 0,
			next_delivery_attempt_at: null,
		});

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await callForwardNext(scheduler);

		expect(result).toBe(BigInt(80));
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(mockPrisma.$transaction).toHaveBeenCalled();
		expect(mockPrisma.message.delete).toHaveBeenCalledWith({
			where: { id: BigInt(80) },
		});
	});
});
