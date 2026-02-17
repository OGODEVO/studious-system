import React from "react";
import { Box, Text } from "ink";
import { useStore } from "../store.js";

const ChatPanel: React.FC = () => {
    const history = useStore((state) => state.history);
    const streamingToken = useStore((state) => state.streamingToken);

    // Render last 8 messages to fit screen
    const visibleHistory = history.slice(-8);

    return (
        <Box flexDirection="column" paddingX={1} flexGrow={1}>
            {visibleHistory.map((msg, idx) => (
                <Box key={idx} flexDirection="column" marginBottom={1}>
                    <Text bold color={msg.role === "user" ? "green" : "cyan"}>
                        {msg.role === "user" ? "You" : "Oasis"}:
                    </Text>
                    <Text>{typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}</Text>
                </Box>
            ))}

            {streamingToken && (
                <Box flexDirection="column" marginBottom={1}>
                    <Text bold color="cyan">Oasis (streaming):</Text>
                    <Text>{streamingToken}</Text>
                </Box>
            )}
        </Box>
    );
};

export default ChatPanel;
