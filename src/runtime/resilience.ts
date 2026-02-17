export interface RetryPolicy {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio?: number;
}

export interface CircuitBreakerPolicy {
    failureThreshold: number;
    cooldownMs: number;
}

export interface ResiliencePolicy {
    retry: RetryPolicy;
    circuitBreaker: CircuitBreakerPolicy;
}

export interface OperationMetrics {
    total: number;
    successes: number;
    failures: number;
    retries: number;
    circuitOpenEvents: number;
    consecutiveFailures: number;
    lastError?: string;
    lastStartedAt?: number;
    lastSucceededAt?: number;
    lastFailedAt?: number;
}

interface CircuitState {
    openUntil: number;
    consecutiveFailures: number;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(delayMs: number, jitterRatio: number): number {
    if (jitterRatio <= 0) return delayMs;
    const range = delayMs * jitterRatio;
    const min = Math.max(0, delayMs - range);
    const max = delayMs + range;
    return Math.floor(min + Math.random() * (max - min));
}

function initMetrics(): OperationMetrics {
    return {
        total: 0,
        successes: 0,
        failures: 0,
        retries: 0,
        circuitOpenEvents: 0,
        consecutiveFailures: 0,
    };
}

export class ResilientExecutor {
    private readonly policy: ResiliencePolicy;
    private readonly circuits = new Map<string, CircuitState>();
    private readonly metrics = new Map<string, OperationMetrics>();

    constructor(policy: ResiliencePolicy) {
        this.policy = policy;
    }

    private getMetrics(op: string): OperationMetrics {
        const existing = this.metrics.get(op);
        if (existing) return existing;
        const created = initMetrics();
        this.metrics.set(op, created);
        return created;
    }

    private getCircuit(op: string): CircuitState {
        const existing = this.circuits.get(op);
        if (existing) return existing;
        const created: CircuitState = { openUntil: 0, consecutiveFailures: 0 };
        this.circuits.set(op, created);
        return created;
    }

    async execute<T>(op: string, fn: () => Promise<T>): Promise<T> {
        const metrics = this.getMetrics(op);
        const circuit = this.getCircuit(op);
        const now = Date.now();

        if (circuit.openUntil > now) {
            throw new Error(
                `Circuit open for ${op} until ${new Date(circuit.openUntil).toISOString()}`
            );
        }

        metrics.total += 1;
        metrics.lastStartedAt = now;

        let attempt = 0;
        let lastError: Error | null = null;

        while (attempt < this.policy.retry.maxAttempts) {
            attempt += 1;

            try {
                const value = await fn();
                metrics.successes += 1;
                metrics.consecutiveFailures = 0;
                metrics.lastSucceededAt = Date.now();
                circuit.consecutiveFailures = 0;
                circuit.openUntil = 0;
                return value;
            } catch (err) {
                lastError = err as Error;
                metrics.lastError = lastError.message;

                const shouldRetry = attempt < this.policy.retry.maxAttempts;
                if (!shouldRetry) break;

                metrics.retries += 1;

                const delay = Math.min(
                    this.policy.retry.maxDelayMs,
                    this.policy.retry.baseDelayMs * 2 ** (attempt - 1)
                );
                const jittered = withJitter(delay, this.policy.retry.jitterRatio ?? 0.2);
                await wait(jittered);
            }
        }

        metrics.failures += 1;
        metrics.lastFailedAt = Date.now();
        metrics.consecutiveFailures += 1;
        circuit.consecutiveFailures += 1;

        if (circuit.consecutiveFailures >= this.policy.circuitBreaker.failureThreshold) {
            circuit.openUntil = Date.now() + this.policy.circuitBreaker.cooldownMs;
            circuit.consecutiveFailures = 0;
            metrics.circuitOpenEvents += 1;
        }

        throw lastError ?? new Error(`Operation failed: ${op}`);
    }

    getOperationMetrics(op: string): OperationMetrics {
        return { ...this.getMetrics(op) };
    }

    getAllMetrics(): Record<string, OperationMetrics> {
        const out: Record<string, OperationMetrics> = {};
        for (const [op, metrics] of this.metrics.entries()) {
            out[op] = { ...metrics };
        }
        return out;
    }
}
