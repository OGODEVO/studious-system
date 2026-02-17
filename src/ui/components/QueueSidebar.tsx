import React from "react";
import { Box, Text } from "ink";
import { useStore } from "../store.js";
import { getHeartbeatStatus } from "../../runtime/scheduler.js";
import { colors } from "../theme.js";

const QueueSidebar: React.FC = () => {
    const queueStatus = useStore((state) => state.queueStatus);
    const heartbeat = getHeartbeatStatus();

    const bar = (n: number): string => {
        const count = Math.max(0, Math.min(12, n));
        return "█".repeat(count) + "░".repeat(12 - count);
    };

    return (
        <Box flexDirection="column" width={34}>
            <Text bold color={colors.text}>Runtime</Text>
            <Text color={colors.dim}>lanes {"&"} heartbeat</Text>

            <Box flexDirection="column" marginTop={1}>
                <Box>
                    <Text color={colors.success}>fast </Text>
                    <Text color={colors.dim}>[</Text>
                    <Text color={colors.success}>{bar(queueStatus.fast.pending + queueStatus.fast.queued)}</Text>
                    <Text color={colors.dim}>]</Text>
                </Box>
                <Box>
                    <Text color={colors.warning}>slow </Text>
                    <Text color={colors.dim}>[</Text>
                    <Text color={colors.warning}>{bar(queueStatus.slow.pending + queueStatus.slow.queued)}</Text>
                    <Text color={colors.dim}>]</Text>
                </Box>
                <Box>
                    <Text color={colors.accent}>back </Text>
                    <Text color={colors.dim}>[</Text>
                    <Text color={colors.accent}>{bar(queueStatus.background.pending + queueStatus.background.queued)}</Text>
                    <Text color={colors.dim}>]</Text>
                </Box>
            </Box>

            <Box marginTop={1}>
                <Text color={heartbeat.enabled ? colors.success : colors.muted}>
                    {"♥ "}heartbeat: {heartbeat.enabled ? `on ${heartbeat.intervalMinutes}m` : "off"}
                </Text>
            </Box>

            <Box flexDirection="column" marginTop={1}>
                <Text bold color={colors.dim}>commands</Text>
                <Text color={colors.dim}>  /heartbeat 30</Text>
                <Text color={colors.dim}>  /heartbeat off</Text>
                <Text color={colors.dim}>  /grade</Text>
            </Box>
        </Box>
    );
};

export default QueueSidebar;
