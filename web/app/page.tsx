"use client";

import { useEffect, useState } from "react";
import { CreateForm } from "@/components/CreateForm";
import { LiveSession } from "@/components/LiveSession";
import { loadSession } from "@/lib/storage";

type Mode =
  | { kind: "loading" }
  | { kind: "create" }
  | { kind: "session"; sessionId: string; token: string; shareUrl?: string };

// cocode is exported as static HTML (next.config.js: output "export"), so
// there is no dynamic /s/[id] route — instead this single page decides its
// role from the URL query string or a resumed A session in localStorage
// (spec §3's routing note, §5.1, §10-2).
export default function Page() {
  const [mode, setMode] = useState<Mode>({ kind: "loading" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("s");
    const t = params.get("t");
    if (s && t) {
      setMode({ kind: "session", sessionId: s, token: t });
      return;
    }

    const stored = loadSession();
    if (stored) {
      setMode({
        kind: "session",
        sessionId: stored.sessionId,
        token: stored.token,
        shareUrl: stored.shareUrl,
      });
      return;
    }

    setMode({ kind: "create" });
  }, []);

  if (mode.kind === "loading") {
    return <div className="cocode-center-shell">読み込み中…</div>;
  }

  if (mode.kind === "create") {
    return (
      <CreateForm
        onCreated={(sessionId, token, shareUrl) => setMode({ kind: "session", sessionId, token, shareUrl })}
      />
    );
  }

  return <LiveSession sessionId={mode.sessionId} token={mode.token} shareUrl={mode.shareUrl} />;
}
