import React from "react";
import { Box, Text } from "ink";
import { useStore } from "../store.js";
import { colors } from "../theme.js";

function toDisplayText(content: unknown): string {
    if (typeof content === "string") return content;
    return JSON.stringify(content);
}

function truncate(text: string, max = 280): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 3) + "…";
}

const ChatPanel: React.FC = () => {
    const history = useStore((state) => state.history);
    const streamingToken = useStore((state) => state.streamingToken);

    // Hide noisy internal log spam from the conversation pane.
    const visibleHistory = history
        .filter((msg) => {
            if (msg.role !== "system") return true;
            const text = toDisplayText(msg.content);
            return !text.startsWith("[LOG]");
        })
        .slice(-10);

    return (
        <Box flexDirection="column" paddingRight={1} flexGrow={1}>
            <Text bold color={colors.text}>Session Feed</Text>
            <Text color={colors.dim}>recent interactions</Text>
            <Box flexDirection="column" marginTop={1} flexGrow={1}>
                {visibleHistory.map((msg, idx) => {
                    const text = truncate(toDisplayText(msg.content));
                    const isError = text.startsWith("[ERR]") || text.includes("Error");

                    let prefix: string;
                    let prefixColor: string;
                    let bodyColor: string;

                    if (msg.role === "user") {
                        prefix = "❯";
                        prefixColor = colors.user;
                        bodyColor = colors.text;
                    } else if (msg.role === "assistant") {
                        prefix = "◆";
                        prefixColor = colors.accent;
                        bodyColor = colors.white;
                    } else {
                        prefix = "●";
                        prefixColor = isError ? colors.error : colors.muted;
                        bodyColor = isError ? colors.error : colors.muted;
                    }

                    return (
                        <Box key={idx}>
                            <Text color={prefixColor}>{prefix} </Text>
                            <Text color={bodyColor}>{text}</Text>
                        </Box>
                    );
                })}
            </Box>

            {streamingToken && (
                <Box>
                    <Text color={colors.accent}>{"◇ "}</Text>
                    <Text color={colors.text}>{truncate(streamingToken)}</Text>
                </Box>
            )}
        </Box>
    );
};

export default ChatPanel;
