import { exec } from "child_process";
import { promisify } from "util";
import { CLIApproval, ApprovalInterface } from "../utils/approval.js";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Commands that are allowed by default (still subject to approval if not session-whitelisted)
const ALLOWED_BINARIES = [
    "git",
    "npm",
    "node",
    "ls",
    "grep",
    "cat",
    "find",
    "pwd",
    "echo",
    "mkdir",
    "touch",
];

// Commands that are strictly blocked
const BLOCKED_BINARIES = [
    // "rm", // Temporarily allowed but dangerous
    "sudo", // Still blocked - agent should not need root
    // "chmod",
    // "chown",
];

const MAX_OUTPUT_LENGTH = 3000;

// Internal session cache for "always allow"
const sessionAllowList = new Set<string>();

// Default approval interface (can be swapped)
const approval: ApprovalInterface = new CLIApproval();

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function runCommand(args: { command: string }): Promise<string> {
    const cmd = args.command.trim();

    if (!cmd) {
        return "Error: Command cannot be empty.";
    }

    // 1. Basic Security Checks
    const binary = cmd.split(" ")[0];

    if (BLOCKED_BINARIES.includes(binary)) {
        return `Error: Command '${binary}' is blocked for security reasons.`;
    }

    // High-risk commands get an extra warning log, but are allowed if approved
    const HIGH_RISK = ["rm", "curl", "wget", "mv", "chmod", "chown"];
    if (HIGH_RISK.includes(binary)) {
        console.warn(`⚠️  HIGH RISK COMMAND: '${binary}'. Requires careful review.`);
    }

    // Optional: Check against allowed list, or just rely on approval
    // meaningful restriction: only allow standard tools
    if (!ALLOWED_BINARIES.includes(binary) && !cmd.startsWith("./")) {
        // Relaxed for now, but logged
        console.warn(`⚠️  Warning: '${binary}' is not in the standard allow-list, but proceeding to approval.`);
    }

    // 2. Approval Flow
    if (!sessionAllowList.has(cmd)) {
        const decision = await approval.requestApproval(cmd);

        if (decision === "DENY") {
            return "Error: User denied execution of this command.";
        }

        if (decision === "ALWAYS_ALLOW_SESSION") {
            sessionAllowList.add(cmd);
        }
    }

    // 3. Execution
    try {
        const { stdout, stderr } = await execAsync(cmd);

        let output = stdout.trim();
        if (stderr.trim()) {
            output += `\n[stderr]: ${stderr.trim()}`;
        }

        // 4. Output Truncation
        if (output.length > MAX_OUTPUT_LENGTH) {
            return output.slice(0, MAX_OUTPUT_LENGTH) + `\n... (output truncated, total ${output.length} chars)`;
        }

        return output || "(no output)";
    } catch (err: any) {
        return `Error executing command: ${err.message}`;
    }
}
