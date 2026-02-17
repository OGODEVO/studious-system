export type ResilienceCapability =
    | "retry_logic"
    | "exponential_backoff"
    | "circuit_breaker"
    | "health_metrics"
    | "state_persistence";

export interface ComponentCapabilities {
    component: string;
    capabilities: Record<ResilienceCapability, boolean>;
}

export interface ComponentGrade {
    component: string;
    score: number;
    passed: ResilienceCapability[];
    missing: ResilienceCapability[];
}

const CAPABILITIES: ResilienceCapability[] = [
    "retry_logic",
    "exponential_backoff",
    "circuit_breaker",
    "health_metrics",
    "state_persistence",
];

export function gradeResilience(
    inputs: ComponentCapabilities[]
): { overall: number; components: ComponentGrade[] } {
    const components = inputs.map((input) => {
        const passed = CAPABILITIES.filter((cap) => input.capabilities[cap]);
        const missing = CAPABILITIES.filter((cap) => !input.capabilities[cap]);
        const score = Math.round((passed.length / CAPABILITIES.length) * 100);
        return {
            component: input.component,
            score,
            passed,
            missing,
        };
    });

    const overall =
        components.length === 0
            ? 0
            : Math.round(
                components.reduce((sum, c) => sum + c.score, 0) / components.length
            );

    return { overall, components };
}
