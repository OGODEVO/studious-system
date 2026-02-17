import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { colors, AVATAR } from "../theme.js";

interface AvatarProps {
    status: "idle" | "thinking" | "streaming";
}

const CYCLE_COLORS = [colors.primary, colors.accent, colors.success] as const;
const CYCLE_MS = 600;

const Avatar: React.FC<AvatarProps> = ({ status }) => {
    const [colorIdx, setColorIdx] = useState(0);

    useEffect(() => {
        if (status === "idle") {
            setColorIdx(0);
            return;
        }

        const timer = setInterval(() => {
            setColorIdx((prev) => (prev + 1) % CYCLE_COLORS.length);
        }, CYCLE_MS);

        return () => clearInterval(timer);
    }, [status]);

    const color = status === "idle" ? colors.primary : CYCLE_COLORS[colorIdx];

    return <Text color={color}>{AVATAR}</Text>;
};

export default Avatar;
