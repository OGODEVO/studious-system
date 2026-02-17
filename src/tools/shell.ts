import { exec } from "child_process";
import { promisify } from "util";
import { CLIApproval, ApprovalInterface } from "../utils/approval.js";
import { saveSession } from "../utils/context.js";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BLOCKED_BINARIES = [
    "sudo", // Still blocked - agent should not need root
];

const MAX_OUTPUT_LENGTH = 3000;

// ---------------------------------------------------------------------------
// Approval State
// ---------------------------------------------------------------------------

let approval: ApprovalInterface = new CLIApproval();
let isGlobalAllowActive = false;

export function setApprovalInterface(impl: ApprovalInterface) {
    approval = impl;
}

export function setGlobalAllow(enabled: boolean) {
    isGlobalAllowActive = enabled;
    console.log(
        enabled
            ? "🔓 Global execution permission GRANTED. Agent can run commands without further approval."
            : "🔒 Global execution permission REVOKED."
    );
}

export function getGlobalAllowStatus(): boolean {
    return isGlobalAllowActive;
}

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

    // High-risk commands get an extra warning log
    const HIGH_RISK = ["rm", "curl", "wget", "mv", "chmod", "chown"];
    if (HIGH_RISK.includes(binary)) {
        console.warn(`⚠️  HIGH RISK COMMAND: '${binary}'. Requires careful review.`);
    }

    // 2. Approval Flow
    if (!isGlobalAllowActive) {
        const decision = await approval.requestApproval(cmd);

        if (decision === "DENY") {
            return "Error: User denied execution of this command.";
        }

        if (decision === "ALLOW_ALL") {
            setGlobalAllow(true);
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

export async function selfUpdate(): Promise<string> {
    console.log("🔄 Self-update initiated via tool...");
    try {
        const { stdout } = await execAsync("git pull");
        if (stdout.includes("Already up to date")) {
            return "✅ Already up to date.";
        }

        await execAsync("npm install");

        saveSession();

        // Return response so agent knows what happened, then exit
        setTimeout(() => process.exit(0), 1000);

        return `⬇️  Updates applied:\n${stdout}\n\n♻️  Restarting agent...`;
    } catch (err: any) {
        return `❌ Update failed: ${err.message}`;
    }
}
