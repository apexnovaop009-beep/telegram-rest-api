import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
	process.env.CALLBACK_RETRY_BASE_DELAY_SECONDS = "5";
	process.env.CALLBACK_MAX_RETRIES = "3";
	process.env.SERVER_NAME = "test-server";
});

// ── Mock DatabaseClient ─────────────────────────────────────────────
// The scheduler calls `DatabaseClient.getInstance().execute(cb)`.
// Our mock captures the callback and runs it against a fake Drizzle db
// that uses a chainable query builder pattern.

interface TrackedUpdate {
	set: Record<string, unknown>;
}

interface TrackedDelete {
	called: boolean;
}

let selectResult: Record<string, unknown>[] = [];
const trackedUpdates: TrackedUpdate[] = [];
const trackedDeletes: TrackedDelete[] = [];
let transactionCalled = false;

function createMockDb() {
	const mockDb: Record<string, unknown> = {
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: () => ({
						limit: () => Promise.resolve(selectResult),
					}),
					limit: () => Promise.resolve(selectResult),
				}),
				orderBy: () => ({
					limit: () => Promise.resolve(selectResult),
				}),
			}),
		}),
		update: () => ({
			set: (data: Record<string, unknown>) => ({
				where: () => {
					trackedUpdates.push({ set: data });
					return Promise.resolve({});
				},
			}),
		}),
		delete: () => ({
			where: () => {
				trackedDeletes.push({ called: true });
				return Promise.resolve({});
			},
		}),
		transaction: async (cb: (tx: unknown) => Promise<void>) => {
			transactionCalled = true;
			await cb(mockDb);
		},
	};
	return mockDb;
}

vi.mock("../../src/database/DatabaseClient", () => ({
	DatabaseClient: {
		getInstance: () => ({
			execute: (cb: (db: ReturnType<typeof createMockDb>) => Promise<unknown>) =>
				cb(createMockDb()),
		}),
	},
}));

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
		selectResult = [];
		trackedUpdates.length = 0;
		trackedDeletes.length = 0;
		transactionCalled = false;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// ── 1. Successful delivery ───────────────────────────────────────
	it("deletes the message and advances cursor on successful delivery", async () => {
		const scheduler = makeScheduler();

		selectResult = [
			{
				id: BigInt(10),
				raw_payload: '{"text":"hello"}',
				status: "downloaded",
				delivery_retry_count: 0,
				next_delivery_attempt_at: null,
			},
		];

		mockFetchOk();

		const result = await callForwardNext(scheduler);

		expect(result).toBe(BigInt(10));
		expect(transactionCalled).toBe(true);

		const cursorUpdate = trackedUpdates.find(
			(u) => "last_forwarded_id" in u.set,
		);
		expect(cursorUpdate).toBeDefined();
		expect(cursorUpdate!.set.last_forwarded_id).toBe(BigInt(10));

		expect(trackedDeletes.length).toBeGreaterThanOrEqual(1);
	});

	// ── 2. First failure schedules retry ─────────────────────────────
	it("increments retry count and sets next_delivery_attempt_at on first failure", async () => {
		const scheduler = makeScheduler();

		selectResult = [
			{
				id: BigInt(20),
				raw_payload: '{"text":"hello"}',
				status: "downloaded",
				delivery_retry_count: 0,
				next_delivery_attempt_at: null,
			},
		];

		mockFetchFail();

		const before = Date.now();
		const result = await callForwardNext(scheduler);
		const after = Date.now();

		expect(result).toBeNull();
		expect(trackedUpdates.length).toBe(1);

		const updateData = trackedUpdates[0].set;
		expect(updateData.delivery_retry_count).toBe(1);
		expect(updateData.last_delivery_error).toBe(
			"HTTP 500 Internal Server Error",
		);

		const nextAttempt = (updateData.next_delivery_attempt_at as Date).getTime();
		expect(nextAttempt).toBeGreaterThanOrEqual(before + 5000);
		expect(nextAttempt).toBeLessThanOrEqual(after + 5000 + 50);
	});

	// ── 3. Linear back-off delay ─────────────────────────────────────
	it("computes delay as attempt * base (linear back-off)", async () => {
		const scheduler = makeScheduler();

		selectResult = [
			{
				id: BigInt(30),
				raw_payload: '{"text":"hello"}',
				status: "downloaded",
				delivery_retry_count: 1,
				next_delivery_attempt_at: null,
			},
		];

		mockFetchFail();

		const before = Date.now();
		const result = await callForwardNext(scheduler);
		const after = Date.now();

		expect(result).toBeNull();
		const updateData = trackedUpdates[0].set;
		expect(updateData.delivery_retry_count).toBe(2);

		const nextAttempt = (updateData.next_delivery_attempt_at as Date).getTime();
		expect(nextAttempt).toBeGreaterThanOrEqual(before + 10000);
		expect(nextAttempt).toBeLessThanOrEqual(after + 10000 + 50);
	});

	// ── 4. Retry delay not elapsed ───────────────────────────────────
	it("returns null without calling fetch when retry delay has not elapsed", async () => {
		const scheduler = makeScheduler();

		const futureDate = new Date(Date.now() + 60_000);
		selectResult = [
			{
				id: BigInt(40),
				raw_payload: '{"text":"hello"}',
				status: "downloaded",
				delivery_retry_count: 1,
				next_delivery_attempt_at: futureDate,
			},
		];

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await callForwardNext(scheduler);

		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// ── 5. Permanent failure after max retries ───────────────────────
	it("marks message as delivery_failed when retries are exhausted", async () => {
		const scheduler = makeScheduler();

		selectResult = [
			{
				id: BigInt(50),
				raw_payload: '{"text":"hello"}',
				status: "downloaded",
				delivery_retry_count: 2,
				next_delivery_attempt_at: null,
			},
		];

		mockFetchFail(503, "Service Unavailable");

		const result = await callForwardNext(scheduler);

		expect(result).toBeNull();
		expect(transactionCalled).toBe(true);

		const msgUpdate = trackedUpdates.find(
			(u) => "status" in u.set && u.set.status === "delivery_failed",
		);
		expect(msgUpdate).toBeDefined();
		expect(msgUpdate!.set.delivery_retry_count).toBe(3);
		expect(msgUpdate!.set.last_delivery_error).toBe(
			"HTTP 503 Service Unavailable",
		);
		expect(msgUpdate!.set.next_delivery_attempt_at).toBeNull();

		const cursorUpdate = trackedUpdates.find(
			(u) => "last_forwarded_id" in u.set,
		);
		expect(cursorUpdate).toBeDefined();
		expect(cursorUpdate!.set.last_forwarded_id).toBe(BigInt(50));
	});

	// ── 6. Cursor skips delivery_failed messages ─────────────────────
	it("advances cursor past delivery_failed messages without calling fetch", async () => {
		const scheduler = makeScheduler();

		selectResult = [
			{
				id: BigInt(60),
				raw_payload: '{"text":"hello"}',
				status: "delivery_failed",
				delivery_retry_count: 3,
				next_delivery_attempt_at: null,
			},
		];

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await callForwardNext(scheduler);

		expect(result).toBe(BigInt(60));
		expect(fetchSpy).not.toHaveBeenCalled();

		const cursorUpdate = trackedUpdates.find(
			(u) => "last_forwarded_id" in u.set,
		);
		expect(cursorUpdate).toBeDefined();
		expect(cursorUpdate!.set.last_forwarded_id).toBe(BigInt(60));
	});

	// ── 7. No more messages returns null ──────────────────────────────
	it("returns null when there are no messages to forward", async () => {
		const scheduler = makeScheduler();

		selectResult = [];

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await callForwardNext(scheduler);

		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// ── 8. Empty payload treated as success ──────────────────────────
	it("treats null raw_payload as successful delivery and deletes the message", async () => {
		const scheduler = makeScheduler();

		selectResult = [
			{
				id: BigInt(80),
				raw_payload: null,
				status: "downloaded",
				delivery_retry_count: 0,
				next_delivery_attempt_at: null,
			},
		];

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await callForwardNext(scheduler);

		expect(result).toBe(BigInt(80));
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(transactionCalled).toBe(true);
		expect(trackedDeletes.length).toBeGreaterThanOrEqual(1);
	});
});
