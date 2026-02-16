import * as readline from "readline";

// ---------------------------------------------------------------------------
// Approval Interface (Platform Agnostic)
// ---------------------------------------------------------------------------

export type ApprovalDecision = "ALLOW" | "DENY" | "ALWAYS_ALLOW_SESSION";

export interface ApprovalInterface {
    requestApproval(command: string): Promise<ApprovalDecision>;
}

// ---------------------------------------------------------------------------
// CLI Implementation
// ---------------------------------------------------------------------------

export class CLIApproval implements ApprovalInterface {
    async requestApproval(command: string): Promise<ApprovalDecision> {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        return new Promise((resolve) => {
            console.log("\n⚠️  Agent requests to execute command:");
            console.log(`   > ${command}`);
            console.log("   [y] Allow once");
            console.log("   [a] Allow always for this session (careful!)");
            console.log("   [n] Deny");

            rl.question("   Decision (y/a/n): ", (answer) => {
                rl.close();
                const normalized = answer.trim().toLowerCase();

                if (normalized === "y" || normalized === "yes") {
                    resolve("ALLOW");
                } else if (normalized === "a" || normalized === "always") {
                    resolve("ALWAYS_ALLOW_SESSION");
                } else {
                    resolve("DENY");
                }
            });
        });
    }
}
