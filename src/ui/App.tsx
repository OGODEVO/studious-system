import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import QueueSidebar from "./components/QueueSidebar.js";
import ChatPanel from "./components/ChatPanel.js";
import { useStore } from "./store.js";
import { submitTask, getQueueStatus } from "../runtime/taskQueue.js";
import { type OnTokenCallback } from "../agent.js";
import { config } from "../utils/config.js";

const App: React.FC = () => {
    const [inputValue, setInputValue] = useState("");
    const {
        addMessage,
        appendToken,
        setQueueStatus,
        setAgentStatus,
        clearStreaming,
        history,
        agentStatus
    } = useStore();

    // Poll queue status every second
    useEffect(() => {
        const timer = setInterval(() => {
            setQueueStatus(getQueueStatus());
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    const handleSubmit = async (input: string) => {
        if (!input.trim()) return;

        const userMsg = input.trim();
        setInputValue("");
        addMessage({ role: "user", content: userMsg });
        setAgentStatus("thinking");

        // Prepare streaming callback
        const onToken: OnTokenCallback = (token) => {
            setAgentStatus("streaming");
            appendToken(token);
        };

        // Only send user/assistant messages to the API — not UI system messages
        const apiHistory = history.filter(
            (m): m is typeof m => m.role === "user" || m.role === "assistant"
        );

        try {
            const result = await submitTask(userMsg, apiHistory, "fast", onToken);

            clearStreaming(); // Move stream to history
            if (result.status === "completed") {
                // history is updated by the store actions if we sync differently, 
                // but here we just append the final Assistant message 
                // (Wait, `submitTask` returns the *new* history with the assistant response appended)
                // We should sync the store with the result history
                // Actually, simpler: just Add Message with the result.reply
                addMessage({ role: "assistant", content: result.reply });
            } else {
                addMessage({ role: "system", content: "Error: " + result.error });
            }
        } catch (err) {
            addMessage({ role: "system", content: "Critical Error: " + (err as Error).message });
        } finally {
            setAgentStatus("idle");
        }
    };

    return (
        <Box flexDirection="column" height={20}>
            {/* Header */}
            <Box borderStyle="single" borderColor="green" paddingX={1}>
                <Text bold>Oasis Agent v1.0 </Text>
                <Text> | Context: {config.contextWindow} | </Text>
                <Text color={agentStatus === "streaming" ? "green" : "gray"}>Status: {agentStatus.toUpperCase()}</Text>
            </Box>

            {/* Main Area */}
            <Box flexGrow={1}>
                <ChatPanel />
                <QueueSidebar />
            </Box>

            {/* Input Area */}
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
                <Text color="green">➜ </Text>
                <TextInput
                    value={inputValue}
                    onChange={setInputValue}
                    onSubmit={handleSubmit}
                />
            </Box>
        </Box>
    );
};

export default App;
