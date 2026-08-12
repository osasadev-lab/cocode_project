"use client";

import { useEffect, useState } from "react";

interface CountdownBadgeProps {
  expiresAt: string;
}

/** Always-visible remaining-time display (spec §5.5/§9): the TTL never
 * extends, so users need a clear signal before it lapses. */
export function CountdownBadge({ expiresAt }: CountdownBadgeProps) {
  const [remainingMs, setRemainingMs] = useState(() => Date.parse(expiresAt) - Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setRemainingMs(Date.parse(expiresAt) - Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const clamped = Math.max(0, remainingMs);
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const label = `${minutes}:${seconds.toString().padStart(2, "0")}`;

  const level = clamped <= 60_000 ? "danger" : clamped <= 5 * 60_000 ? "warn" : "normal";

  return (
    <div
      className={`cocode-glass cocode-countdown${
        level === "danger" ? " cocode-countdown-danger" : level === "warn" ? " cocode-countdown-warn" : ""
      }`}
      title="このセッションが自動的に終了するまでの残り時間"
    >
      ⏳ 残り {label}
    </div>
  );
}
