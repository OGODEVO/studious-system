import React from "react";
import { Box, Text } from "ink";
import { useStore } from "../store.js";

const QueueSidebar: React.FC = () => {
    const queueStatus = useStore((state) => state.queueStatus);

    return (
        <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1} width={25}>
            <Text bold color="blue">Queue Status</Text>
            <Box flexDirection="column" marginTop={1}>
                <Text>Fast: {queueStatus.fast.pending} run / {queueStatus.fast.queued} Q</Text>
                <Text>Slow: {queueStatus.slow.pending} run / {queueStatus.slow.queued} Q</Text>
                <Text>Back: {queueStatus.background.pending} run / {queueStatus.background.queued} Q</Text>
            </Box>
        </Box>
    );
};

export default QueueSidebar;
